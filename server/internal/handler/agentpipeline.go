// Pipeline agent: badan postChat yang dieksekusi consumer queue.
//
// Dulu pipeline ini jalan inline di dalam request HTTP POST /chat; sekarang
// dieksekusi executeAgentPipeline oleh consumer queue (AgentJobHandler) dan
// event SSE-nya diterbitkan ke bus lewat emit, lalu di-relay postChat ke
// HTTP stream. Isi pipeline TIDAK diubah kecuali yang mekanis (lihat
// catatan di tiap titik): sendAgentSSE -> emit, c.Param("id") ->
// projectIDStr, req.* -> in.*, uid -> in.UserID, dan finishAgentRun ->
// finishAgentRunIfActive (supaya cancel tidak tertimpa "failed").
// [DONE] TIDAK ditulis di sini — relay menuliskannya saat topik bus
// ditutup (job selesai).
package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"webbuilder/guidance"
	"webbuilder/internal/database/models"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// executeAgentPipeline menjalankan pipeline agent untuk satu run yang sudah
// dibuat + di-enqueue postChat. Mengembalikan nil bila run mencapai
// terminal state (completed/failed/cancelled/menunggu konfirmasi); error
// hanya bila pipeline abort sebelum terminal state (infra gagal, mis.
// project hilang dari DB di tengah jalan atau error DB lain) supaya queue
// me-retry. runCtx adalah konteks job (dibatalkan saat consumer berhenti
// atau job dibatalkan).
func executeAgentPipeline(runCtx context.Context, db *gorm.DB, in agentPipelineInput, emit func(agentBusEvent)) error {
	runID := in.RunID
	projectIDStr := fmt.Sprint(in.ProjectID)
	intent := agentIntent(in.Intent)
	send := func(event string, payload any) {
		emit(newAgentBusEvent(event, payload))
	}

	// Muat run + project fresh dari DB (bukan dari request HTTP — request
	// sudah mati saat consumer jalan).
	run := &models.AgentRun{}
	if err := db.First(run, runID).Error; err != nil {
		// Run tidak ada (mis. dihapus manual) — tidak ada yang dikerjakan.
		slog.Warn("agent pipeline: run tidak ditemukan, job dibuang", "runId", runID, "error", err)
		return nil
	}
	if run.ProjectID != in.ProjectID {
		slog.Warn("agent pipeline: project run tidak cocok dengan payload, job dibuang", "runId", runID, "projectId", in.ProjectID)
		return nil
	}
	if run.Status == "completed" || run.Status == "failed" || run.Status == "cancelled" {
		// Sudah terminal — mis. dibatalkan pengguna saat masih antre di
		// queue. Jangan eksekusi ulang.
		return nil
	}
	p := &models.Project{}
	if err := db.First(p, in.ProjectID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			finishAgentRunIfActive(db, runID, "failed", "Project tidak ditemukan", "project tidak ditemukan")
			return nil
		}
		return err
	}
	provider := getEffectiveAIProvider(db)

	// Konteks intent terakhir (disimpan postChat sebelum enqueue) — dibaca
	// fresh supaya follow-up tetap nyambung. Bila belum ada barisnya,
	// First mengembalikan ErrRecordNotFound dan agentCtx tetap zero-value
	// (tanpa active context), sama seperti di postChat.
	var agentCtx models.AgentContext
	db.Where("project_id = ?", in.ProjectID).First(&agentCtx)
	updateAgentPhase(db, run.ID, "analyzing")
	recordAgentTool(db, run.ID, "analyze_project", "analyzing", "success", "project context + request", "files, schema, diagnostics collected", "")
	updateAgentPhase(db, run.ID, "planning")
	send("intent", gin.H{"intent": intent, "mode": in.Mode})

	var files map[string]string
	json.Unmarshal([]byte(p.Files), &files)
	if files == nil {
		files = map[string]string{}
	}
	if needsClarification(in.Message, files, in.Mode) && !in.Confirm {
		plan := clarificationPlan(in.Message)
		db.Model(&models.AgentRun{}).Where("id = ?", run.ID).Updates(map[string]interface{}{"status": "waiting_for_confirmation", "phase": "clarification", "summary": "Menunggu jawaban klarifikasi"})
		send("clarification", plan)
		return nil
	}
	// Wizard tanya-jawab ala Emergent: permintaan project baru yang vague
	// dijawab dengan 3-5 pertanyaan klarifikasi dari AI sebelum discovery.
	if isVagueNewRequest(in.Message, files, in.Mode) && !in.Confirm {
		questions := generateClarifyingQuestions(in.Message, provider)
		if len(questions) > 0 {
			if run != nil {
				db.Model(&models.AgentRun{}).Where("id = ?", run.ID).Updates(map[string]interface{}{"status": "waiting_for_confirmation", "phase": "clarification", "summary": "Menunggu jawaban klarifikasi"})
			}
			send("clarification", map[string]interface{}{
				"summary":   "Agen punya pertanyaan untukmu.",
				"request":   in.Message,
				"questions": questions,
			})
			return nil
		}
		// Gagal generate -> lanjut ke discovery seperti biasa
	}
	if needsDiscovery(in.Message, files, in.Mode) && !in.Confirm {
		plan := discoveryPlan(in.Message)
		if run != nil {
			db.Model(&models.AgentRun{}).Where("id = ?", run.ID).Updates(map[string]interface{}{"status": "waiting_for_confirmation", "phase": "discovery", "summary": "Menunggu persetujuan rencana"})
		}
		send("discovery", plan)
		return nil
	}

	// Build context: file list + current file contents (truncated)
	var ctx strings.Builder
	ctx.WriteString("\n\nFILE SAAT INI:\n")
	for path, content := range files {
		if len(content) > 3000 {
			content = content[:3000] + "...(dipotong)"
		}
		ctx.WriteString("--- " + path + " ---\n" + content + "\n")
	}
	// Context diagnostik: error preview dan output terminal dikirim ke AI agar dapat dianalisa.
	if len(in.PreviewErrors) > 0 {
		ctx.WriteString("\n\nERROR PREVIEW TERBARU:\n" + strings.Join(in.PreviewErrors, "\n"))
	}
	if len(in.TerminalLines) > 0 {
		lines := in.TerminalLines
		if len(lines) > 80 {
			lines = lines[len(lines)-80:]
		}
		ctx.WriteString("\n\nOUTPUT TERMINAL TERBARU:\n" + strings.Join(lines, "\n"))
	}
	// Baca metadata database proyek (nama tabel dan kolom), bukan secret/isi sensitif.
	if sqlDB, err := getAppSQLDB(); err == nil {
		_ = ensureSchema(projectIDStr)
		rows, err := sqlDB.Query("SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = $1 ORDER BY table_name, ordinal_position", appSchema(projectIDStr))
		if err == nil {
			defer rows.Close()
			var schema strings.Builder
			for rows.Next() {
				var table, col, typ string
				if rows.Scan(&table, &col, &typ) == nil {
					fmt.Fprintf(&schema, "%s.%s (%s)\\n", table, col, typ)
				}
			}
			if schema.Len() > 0 {
				ctx.WriteString("\\n\\nDATABASE SCHEMA PROYEK (read-only context):\\n" + schema.String())
			}
		}
	}
	// URL GitHub di prompt diperlakukan sebagai referensi teknis yang dianalisis
	// secara terbatas. Konten eksternal tidak pernah dianggap instruksi sistem.
	if ref := fetchGitHubReference(in.Message); ref != "" {
		ctx.WriteString("\n\n" + ref)
		send("reference", gin.H{"type": "github", "status": "analyzed", "message": "Referensi GitHub dianalisis sebagai constraint teknis."})
	}
	if ref := fetchWebReference(in.Message); ref != "" {
		ctx.WriteString("\n\n" + ref)
		send("reference", gin.H{"type": "website", "status": "analyzed", "message": "Referensi website dianalisis untuk UI/UX."})
	}
	userMsg := in.Message + ctx.String()

	// Inject memory proyek ke system prompt
	full := ""
	sysPrompt := builderSystemPrompt
	if agentCtx.ActiveFeature != "" {
		sysPrompt += "\n\nAKTIF CONTEXT (jaga kesinambungan follow-up):\n- Intent terakhir: " + agentCtx.Intent + "\n- Fitur/permintaan aktif: " + agentCtx.ActiveFeature
	}
	if p.Memory != "" {
		sysPrompt += "\n\nMEMORY PROYEK:\n" + p.Memory
	}
	// Tool registry tersedia sebagai kontrak agent; parser FILE tetap menjadi fallback kompatibilitas.
	toolJSON, _ := json.Marshal(agentToolCatalog())
	sysPrompt += "\n\nAVAILABLE PROJECT TOOLS (gunakan hanya bila provider mendukung tool calls; jika tidak, gunakan FILE blocks):\n" + string(toolJSON)
	if p.Blueprint != "" {
		sysPrompt += "\n\nBLUEPRINT PROYEK YANG DISETUJUI:\n" + p.Blueprint + "\nIkuti blueprint ini. Jika perubahan menyimpang, jelaskan konflik sebelum mengubah scope."
	}
	if p.FormToken != "" {
		siteURL := getSetting(db, "site_url")
		if siteURL == "" {
			siteURL = "https://build.clipku.my.id"
		}
		sysPrompt += "\n\nFORMULIR KONTAK:\n- Situs ini punya backend formulir otomatis di " + siteURL + "/f/" + p.FormToken + ".\n" +
			"- Jika user meminta form kontak/pendaftaran/pesan/newsletter, kirim datanya via POST JSON {\"data\": {...}} ke endpoint itu. " +
			"Contoh: fetch(\"" + siteURL + "/f/" + p.FormToken + "\", {method:\"POST\", headers:{\"Content-Type\":\"application/json\"}, " +
			"body: JSON.stringify({data: {nama, email, pesan}})}).\n" +
			"- Data otomatis tersimpan & pemilik situs dapat notifikasi. JANGAN buat backend form sendiri."
	}
	if mp, ok := modePrompts[in.Mode]; ok {
		sysPrompt = mp
		if p.Memory != "" {
			sysPrompt += "\n\nMEMORY PROYEK:\n" + p.Memory
		}
	}
	if p.Framework == "vue" {
		sysPrompt += "\nFRAMEWORK: Vue 3 Options API."
	} else if p.Framework == "svelte" {
		sysPrompt += "\nFRAMEWORK: Svelte 3."
	}
	// Approved discovery: derive a blueprint internally after the user confirms.
	if len(files) == 0 && in.Mode != "ask" && in.Mode != "debug" && in.Mode != "review" {
		sysPrompt += `

AUTONOMOUS BLUEPRINT (EMPTY PROJECT):
- Do not ask discovery questions or wait for confirmation. Infer sensible defaults from the request and build immediately.
- Before writing files, internally derive target users, roles, core flows, routes, entities, permissions, responsive states, and acceptance checks.
- Save a concise machine-readable blueprint using <<<BLUEPRINT>>>...<<<END>>> and then generate the working project.
- If information is missing, choose a safe conventional default and mention the assumption briefly after implementation.
`
	}

	// Modern Web Guidance (GoogleChrome/modern-web-guidance): pilih panduan
	// relevan dari prompt user lalu suntik ke system prompt. Dibatasi 7000 byte
	// agar tidak memakan konteks; null bila topiknya tidak tercakup.
	if gsec, gids := guidance.PromptSection(in.Message, 7000); gsec != "" {
		sysPrompt += "\n\n" + gsec
		if run != nil {
			recordAgentTool(db, run.ID, "modern_web_guidance", "analyzing", "success", strings.Join(gids, ","), "panduan web modern disuntik ke prompt", "")
		}
	}

	// Design system: pilih satu preset dari permintaan user, kunci di memory
	// proyek, lalu suntik tokennya. Tanpa ini semua aplikasi memakai palet
	// oranye/putih yang sama dan terlihat seperti template.
	// Framework routing tetap milik AI: prompt lengkap dipakai untuk memilih
	// profile, bukan selector dashboard. Profile disimpan di blueprint/memory
	// setelah analisis agar dapat diaudit dan diteruskan ke generator.
	if p.Framework == "auto" {
		profile := chooseFrameworkProfile(in.Message)
		p.Framework = profile
		db.Model(&p).Update("framework", profile)
		send("framework", gin.H{"selected": profile, "reason": "dipilih dari analisis prompt dan scope project"})
	}
	preset := chooseDesign(p, in.Message)
	if !strings.Contains(strings.ToLower(p.Memory), "design: ") {
		if strings.TrimSpace(p.Memory) != "" {
			p.Memory = strings.TrimSpace(p.Memory) + "\n"
		}
		p.Memory += "DESIGN: " + preset.Name + " (" + preset.Label + ")"
		db.Model(p).Update("memory", p.Memory)
	}
	sysPrompt += "\n\n" + DesignBrief(preset)

	// Find or create a ChatSession for this project
	var session models.ChatSession
	if err := db.Where("project_id = ?", p.ID).Order("id DESC").First(&session).Error; err != nil {
		session = models.ChatSession{ProjectID: p.ID, Title: in.Message}
		if len(session.Title) > 100 {
			session.Title = session.Title[:100]
		}
		db.Create(&session)
	}

	// Save user message to DB
	currentMessage := models.ChatMessage{SessionID: session.ID, Role: "user", Content: in.Message}
	db.Create(&currentMessage)

	// Load last 20 messages for history (oldest first), excluding the one we just saved
	var histMsgs []models.ChatMessage
	db.Where("session_id = ? AND id <> ?", session.ID, currentMessage.ID).Order("id DESC").Limit(20).Find(&histMsgs)
	// Reverse to chronological order; exclude the last inserted user message (it's added by streamChatWithHistory)
	var history []chatMsg
	for i := len(histMsgs) - 1; i >= 0; i-- {
		m := histMsgs[i]
		// skip the user message we just inserted (it will be appended as the current message)
		if m.Role == "user" && m.Content == in.Message && i == 0 {
			continue
		}
		history = append(history, chatMsg{Role: m.Role, Content: m.Content})
	}

	// Snapshot sebelum AI: dipakai untuk menghitung perubahan NYATA setelah
	// tool write_file/apply_patch menulis langsung ke DB.
	before := map[string]string{}
	for k, v := range files {
		before[k] = v
	}

	if run != nil {
		updateAgentPhase(db, run.ID, "generating")
		recordAgentTool(db, run.ID, "ai_stream", "generating", "running", in.Mode, "provider stream started", "")
	}
	streamCtx, cancelStream := context.WithCancel(runCtx)
	registerAgentCancel(run.ID, cancelStream)
	defer unregisterAgentCancel(run.ID)
	err := provider.streamChatWithTools(streamCtx, sysPrompt, history, userMsg, agentToolCatalog(), func(name string, input map[string]interface{}) (interface{}, error) {
		// Simpan argumen nyata (bukan label generik) supaya kegagalan tool
		// bisa didiagnosis tanpa menebak apa yang dikirim model.
		rj, _ := json.Marshal(input)
		if run != nil {
			recordAgentTool(db, run.ID, name, "analyzing", "running", string(rj), "Agent meminta tool", "")
		}
		result, toolErr := executeAgentTool(db, p, name, input)
		if run != nil {
			status := "success"
			detail := "Tool berhasil dijalankan"
			if toolErr != nil {
				status = "failed"
				detail = toolErr.Error()
			}
			recordAgentTool(db, run.ID, name, "analyzing", status, string(rj), detail, "")
		}
		return result, toolErr
	}, func(chunk string) {
		full += chunk
		send("message", chunk)
	})
	if err != nil {
		// Provider lama yang belum mendukung tools tetap dilayani oleh parser stream legacy.
		full = ""
		err = provider.streamChatWithHistory(streamCtx, sysPrompt, history, userMsg, in.Image, func(chunk string) {
			full += chunk
			send("message", chunk)
		})
	}
	if err != nil {
		if run != nil {
			recordAgentTool(db, run.ID, "ai_stream", "generating", "failed", in.Mode, "Provider stream gagal", err.Error())
		}
		// Bedakan batal pengguna vs konteks job mati (shutdown/restart):
		// batal pengguna sudah menandai run "cancelled" di DB
		// (cancelAgentRun) SEBELUM membatalkan stream. Bila run masih
		// aktif tetapi konteks job mati, ini shutdown — kembalikan error
		// supaya queue me-retry job sesudah restart (run belum terminal,
		// pre-check akan mengeksekusi ulang dari awal). Perlombaan kecil
		// (stream abort sebelum update DB mendarat) aman: retry sesudah
		// backoff akan melihat run sudah "cancelled" dan melewatinya
		// tanpa eksekusi.
		var cur models.AgentRun
		if db.First(&cur, run.ID).Error == nil && cur.Status == "cancelled" {
			finishAgentRunIfActive(db, run.ID, "cancelled", "Proses dihentikan pengguna", "cancelled by user")
			return nil
		}
		if runCtx.Err() != nil {
			return fmt.Errorf("agent pipeline dibatalkan (konteks job mati): %w", err)
		}
		finishAgentRunIfActive(db, run.ID, "failed", "Provider AI gagal menyelesaikan proses", err.Error())
		emit(agentBusEvent{Raw: jsonEscape("[ERROR] " + err.Error())})
		return nil
	}

	// Bersihkan output teknis yang bocor ke chat sebelum disimpan/dikirim sebagai jawaban utama.
	full = sanitizeAssistantReply(full)
	// Ringkas diagnosis runtime/database untuk user; detail tetap berada di AgentToolCall.
	if strings.Contains(strings.ToLower(full), "failed to fetch") && strings.Contains(strings.ToLower(full), "clouddb") {
		full = "Data sudah diproses, tetapi Preview belum bisa terhubung ke database. Koneksi Preview perlu diperbaiki; data tersimpan tetap aman."
	}
	if strings.Contains(strings.ToLower(full), "placeholder.tsx") || strings.Contains(strings.ToLower(full), "quality stage") || strings.Contains(strings.ToLower(full), "project belum memenuhi kontrak") {
		full = "Preview belum siap karena masih ada file lama yang belum dipakai. Saya akan menggantinya atau menghapusnya, lalu menjalankan build ulang."
	}
	// Save AI response to DB
	if full != "" {
		db.Create(&models.ChatMessage{SessionID: session.ID, Role: "assistant", Content: full})
		// Catat pemakaian agar kuota bulanan terpotong (tanpa ini user free dapat AI unlimited)
		recordAIUsage(db, in.UserID, provider.Model, sysPrompt+userMsg, full)
	}

	// Parse BLUEPRINT blocks dari AI -> persist project contract.
	if start := strings.Index(full, "<<<BLUEPRINT>>>"); start >= 0 {
		rest := full[start+14:]
		if end := strings.Index(rest, "<<<END>>>"); end >= 0 {
			blueprint := strings.TrimSpace(rest[:end])
			if blueprint != "" {
				db.Model(&p).Update("blueprint", blueprint)
				if run != nil {
					recordAgentTool(db, run.ID, "save_blueprint", "planning", "success", "blueprint", blueprint, "")
				}
			}
		}
	}
	// Parse MEMORY blocks dari AI -> simpan ke project memory
	for {
		start := strings.Index(full, "<<<MEMORY:")
		if start < 0 {
			break
		}
		rest := full[start+10:]
		end := strings.Index(rest, ">>>")
		if end < 0 {
			break
		}
		fact := strings.TrimSpace(rest[:end])
		if fact != "" && !strings.Contains(p.Memory, fact) {
			if p.Memory != "" {
				p.Memory += "\n"
			}
			p.Memory += "- " + fact
			db.Model(&p).Update("memory", p.Memory)
		}
		full = full[:start] + rest[end+3:]
	}
	// Tool write_file/apply_patch menulis LANGSUNG ke kolom files di DB,
	// sementara p & files di memori sudah basi. Muat ulang dulu supaya
	// perbandingan perubahan, apply FILE block, dan sinkronisasi runtime
	// memakai isi terbaru (kalau tidak, file yang ditulis tool dianggap
	// "tidak ada perubahan" dan runtime di-sync dari daftar lama).
	db.First(p, p.ID)
	fresh := map[string]string{}
	if p.Files != "" {
		_ = json.Unmarshal([]byte(p.Files), &fresh)
	}
	// Parse file blocks -> Auto-apply ke project files (Lovable standard)
	newFiles := parseFileBlocks(full, fresh)
	changed := []string{}
	for k, v := range newFiles {
		if before[k] != v {
			changed = append(changed, k)
		}
	}
	for k := range before {
		if _, still := newFiles[k]; !still {
			changed = append(changed, k)
		}
	}
	if len(changed) > 0 {
		fj, _ := json.Marshal(newFiles)
		db.Model(&p).Update("files", string(fj))
		db.Create(&models.ProjectVersion{ProjectID: p.ID, Label: "AI (" + itoa(len(changed)) + " file)", Files: string(fj)})
		send("changes", gin.H{"applied": true, "changed": changed, "files": string(fj)})
	}
	// Token desain: pastikan variabel yang dirujuk model benar-benar didefinisikan.
	if tokenPath, ok := ensureDesignTokens(newFiles, preset); ok {
		fj, _ := json.Marshal(newFiles)
		db.Model(&p).Update("files", string(fj))
		changed = append(changed, tokenPath)
		send("changes", gin.H{"applied": true, "changed": []string{tokenPath}, "source": "design-tokens"})
	}
	// Blueprint executable: untuk project baru, materialisasikan struktur domain
	// yang sudah disetujui menjadi folder, kontrak TypeScript, dokumentasi,
	// dan migration idempotent sebelum build. Project lama tidak disentuh.
	if len(before) == 0 {
		if added := materializeBlueprint(newFiles, p.Blueprint); len(added) > 0 {
			changed = append(changed, added...)
			fj, _ := json.Marshal(newFiles)
			db.Model(p).Update("files", string(fj))
			send("changes", gin.H{"applied": true, "changed": added, "source": "blueprint-materializer"})
		}
	}
	// Scaffold operasional selalu muncul di Code: env example, README,
	// Vite types, dan stylesheet dasar. Secret tidak pernah dibuat otomatis.
	if added := ensureProjectScaffolding(newFiles); len(added) > 0 {
		fj, _ := json.Marshal(newFiles)
		db.Model(p).Update("files", string(fj))
		changed = append(changed, added...)
		send("changes", gin.H{"applied": true, "changed": added, "source": "project-scaffold"})
	}
	// Jalankan migration yang dimaterialisasikan dari blueprint pada project baru.
	// Setiap file dicatat durable dan idempotent di ProjectMigration.
	if len(before) == 0 {
		if applied, err := applyGeneratedMigrations(db, p, newFiles); err != nil {
			send("error", gin.H{"phase": "database", "message": err.Error()})
		} else if len(applied) > 0 {
			send("database", gin.H{"applied": applied, "source": "blueprint-migrations"})
		}
	}
	// Kontrak TypeScript: kalau hasilnya HTML tunggal atau berisi .js/.jsx,
	// konversi sekali ke proyek Vite+React+TS sebelum build dijalankan.
	if contractViolated(newFiles) {
		if _, fixed, err := enforceProjectContract(db, p, provider); err == nil && len(fixed) > 0 {
			db.First(p, p.ID)
			reloaded := map[string]string{}
			_ = json.Unmarshal([]byte(p.Files), &reloaded)
			if len(reloaded) > 0 {
				newFiles = reloaded
			}
			changed = append(changed, fixed...)
			send("changes", gin.H{"applied": true, "changed": fixed, "source": "typescript-contract"})
		}
	}
	// Parse SQL blocks for database (tetap auto karena DDL aman)
	if run != nil {
		updateAgentPhase(db, run.ID, "database")
	}
	for _, sqlBlock := range parseSQLBlocks(full) {
		execAISQL(db, projectIDStr, sqlBlock)
	}
	var acceptance map[string]interface{}
	var acceptanceErr error
	if run != nil {
		if len(changed) == 0 {
			recordAgentTool(db, run.ID, "apply_files", "applying", "success", "Tidak ada file berubah", "Project sudah sesuai", "")
		} else {
			for _, file := range changed {
				recordAgentTool(db, run.ID, "apply_file", "applying", "success", file, "File diterapkan", "")
			}
		}
		updateAgentPhase(db, run.ID, "database_verify")
		recordAgentTool(db, run.ID, "verify_database", "database_verify", "running", "runtime pipeline", "Menjalankan verifikasi database", "")
		acceptance, acceptanceErr = runAgentRuntimeAcceptance(db, p, in.UserID)
		// Auto-repair terbatas: satu error TypeScript tidak boleh mengakhiri
		// generasi. Kirim diagnostik build NYATA ke model, terapkan file
		// perbaikan, lalu ulangi pipeline (maks 2 percobaan).
		for attempt := 1; attempt <= 3 && acceptanceErr != nil; attempt++ {
			diag := acceptanceDiagnostic(acceptance, acceptanceErr)
			if !isRepairableDiagnostic(diag) {
				break
			}
			updateAgentPhase(db, run.ID, "auto_fix")
			recordAgentTool(db, run.ID, "auto_fix", "auto_fix", "running", fmt.Sprintf("percobaan %d", attempt), "Memperbaiki error build", "")
			send("auto_fix", gin.H{"attempt": attempt, "error": lastLines(diag, 12)})
			repaired, repairErr := repairProjectFiles(db, p, provider, sysPrompt, diag)
			if repairErr != nil || len(repaired) == 0 {
				recordAgentTool(db, run.ID, "auto_fix", "auto_fix", "failed", fmt.Sprintf("percobaan %d", attempt), "Auto-fix tidak menghasilkan file", fmt.Sprint(repairErr))
				break
			}
			recordAgentTool(db, run.ID, "auto_fix", "auto_fix", "success", fmt.Sprintf("percobaan %d", attempt), "File diperbaiki: "+strings.Join(repaired, ", "), "")
			send("changes", gin.H{"applied": true, "changed": repaired, "autoFix": true})
			acceptance, acceptanceErr = runAgentRuntimeAcceptance(db, p, in.UserID)
		}
		if acceptanceErr != nil {
			recordAgentTool(db, run.ID, "runtime_acceptance", "runtime", "failed", "sync/install/build/database/runtime", fmt.Sprint(acceptance), acceptanceErr.Error())
			finishAgentRunIfActive(db, run.ID, "failed", "Pipeline build/runtime gagal", acceptanceErr.Error())
		} else {
			recordAgentTool(db, run.ID, "verify_database", "database_verify", "success", "runtime pipeline", "Database siap", "")
			recordAgentTool(db, run.ID, "runtime_acceptance", "runtime", "success", "sync/install/build/database/runtime", fmt.Sprint(acceptance), "")
			updateAgentPhase(db, run.ID, "runtime")
			finishAgentRunIfActive(db, run.ID, "completed", "Project berhasil diperbarui dan runtime siap", "")
		}
	}
	finalStatus, finalSummary := "completed", "Project berhasil diperbarui dan diverifikasi"
	if acceptanceErr != nil {
		finalStatus = "failed"
		finalSummary = "Build/preview belum berhasil. " + lastLines(acceptanceDiagnostic(acceptance, acceptanceErr), 4)
	}
	send("result", gin.H{"status": finalStatus, "summary": finalSummary, "changedFiles": changed, "intent": intent})
	return nil
}

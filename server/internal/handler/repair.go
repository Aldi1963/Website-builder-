package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"

	"webbuilder/internal/database/models"

	"gorm.io/gorm"
)

// acceptanceDiagnostic menggabungkan pesan error pipeline dengan output build
// nyata (TypeScript/Vite) dan hasil browser acceptance.
func acceptanceDiagnostic(acceptance map[string]interface{}, err error) string {
	parts := []string{}
	if err != nil {
		parts = append(parts, err.Error())
	}
	if out, ok := acceptance["output"].(string); ok && strings.TrimSpace(out) != "" {
		if len(out) > 8000 {
			out = out[len(out)-8000:]
		}
		parts = append(parts, out)
	}
	if ba, ok := acceptance["browserAcceptance"].(map[string]interface{}); ok {
		if b, mErr := json.Marshal(ba); mErr == nil {
			parts = append(parts, string(b))
		}
	}
	return strings.Join(parts, "\n")
}

// isRepairableDiagnostic memisahkan kesalahan kode (bisa diperbaiki model) dari
// kesalahan infrastruktur/jaringan yang tidak ada gunanya diulang dengan prompt.
func isRepairableDiagnostic(diag string) bool {
	d := strings.ToLower(diag)
	markers := []string{
		"error ts", "error:", "cannot find module", "failed to resolve",
		"is not defined", "is not assignable", "implicitly has an 'any'",
		"possibly 'null'", "npm err", "unexpected token", "expected",
		"syntaxerror", "cannot read properties of undefined",
		"tabel aplikasi belum dibuat", "tabel belum ada", "missing table",
	}
	for _, m := range markers {
		if strings.Contains(d, m) {
			return true
		}
	}
	return false
}

// lastLines mengambil n baris terakhir untuk ditampilkan ke user (bukan log penuh).
func lastLines(s string, n int) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	if len(lines) <= n {
		return strings.Join(lines, "\n")
	}
	return strings.Join(lines[len(lines)-n:], "\n")
}

// repairProjectFiles meminta model memperbaiki error build memakai isi file
// terkini, lalu menyimpan file yang dikembalikan sebagai versi baru.
func repairProjectFiles(db *gorm.DB, p *models.Project, provider *AIProvider, sysPrompt, diag string) ([]string, error) {
	var files map[string]string
	if err := json.Unmarshal([]byte(p.Files), &files); err != nil || len(files) == 0 {
		return nil, fmt.Errorf("file project tidak terbaca")
	}

	// Prioritaskan file yang biasanya menjadi sumber error, lalu sisanya.
	priority := []string{"index.html", "src/main.tsx", "src/App.tsx", "package.json", "tsconfig.json", "vite.config.ts"}
	seen := map[string]bool{}
	var order []string
	for _, name := range priority {
		if _, ok := files[name]; ok {
			order = append(order, name)
			seen[name] = true
		}
	}
	for name := range files {
		if !seen[name] {
			order = append(order, name)
		}
	}
	if len(order) > 14 {
		order = order[:14]
	}

	var b strings.Builder
	for _, name := range order {
		content := files[name]
		if len(content) > 7000 {
			content = content[:7000] + "\n…dipotong"
		}
		b.WriteString("<<<FILE: " + name + ">>>\n" + content + "\n<<<END>>>\n")
	}

	missing := []string{}
	for _, required := range []string{"index.html", "src/main.tsx", "src/App.tsx"} {
		if strings.TrimSpace(files[required]) == "" {
			missing = append(missing, required)
		}
	}

	userMsg := "Build project ini GAGAL. Perbaiki sampai `npm run build` lolos.\n\n" +
		"DIAGNOSTIK (output nyata, jangan diabaikan):\n" + diag + "\n\n"
	if len(missing) > 0 {
		userMsg += "FILE WAJIB YANG BELUM ADA: " + strings.Join(missing, ", ") + "\n"
		userMsg += "src/main.tsx harus mengimpor ./App, dan src/App.tsx wajib ada di root src/.\n\n"
	}
	userMsg += "ATURAN:\n" +
		"- Kembalikan HANYA file yang perlu diubah/dibuat, lengkap, dengan format <<<FILE: path>>>...<<<END>>>.\n" +
		"- Jangan mengubah desain atau fitur yang sudah bekerja; fokus pada error build.\n" +
		"- Jangan menulis deklarasi Window duplikat; /wb-cloud.js sudah menyediakan window.cloudAuth, window.cloudDb, window.db.\n" +
		"- index.html ada di ROOT proyek, bukan di public/.\n"
	if strings.Contains(strings.ToLower(diag), "tabel aplikasi belum dibuat") {
		userMsg += "- WAJIB: sertakan blok <<<SQL>>>CREATE TABLE IF NOT EXISTS nama_tabel (...);<<<END>>> untuk SETIAP tabel yang disebut pada diagnostik. " +
			"Kolom harus mencakup semua field yang dipakai service layer (mis. name, price, stock, total, user_id, created_at) dengan tipe Postgres yang tepat, " +
			"tambahkan id SERIAL PRIMARY KEY bila belum ada. Jangan hanya mengubah file TypeScript.\n"
	}
	userMsg += "\nFILE SAAT INI:\n" + b.String()

	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()

	out := ""
	err := provider.streamChatWithHistory(ctx, sysPrompt, nil, userMsg, "", func(chunk string) { out += chunk })
	if err != nil {
		return nil, err
	}

	newFiles := parseFileBlocks(out, files)
	changed := []string{}
	for name, content := range newFiles {
		if files[name] != content {
			changed = append(changed, name)
		}
	}
	sqlBlocks := parseSQLBlocks(out)
	if len(changed) == 0 && len(sqlBlocks) == 0 {
		return nil, fmt.Errorf("model tidak mengembalikan file/SQL perbaikan")
	}

	encoded, _ := json.Marshal(newFiles)
	if len(changed) > 0 {
		if err := db.Model(p).Update("files", string(encoded)).Error; err != nil {
			return nil, err
		}
		p.Files = string(encoded)
	}
	// Perbaikan sering membutuhkan DDL (tabel yang belum dibuat), bukan hanya
	// file. Jalankan blok SQL yang dikembalikan model pada schema proyek.
	for _, block := range sqlBlocks {
		execAISQL(db, fmt.Sprint(p.ID), block)
	}
	if len(changed) == 0 {
		changed = []string{"(sql migration)"}
	}
	db.Create(&models.ProjectVersion{ProjectID: p.ID, Label: "AI auto-fix (" + itoa(len(changed)) + " file)", Files: string(encoded)})
	return changed, nil
}

// autoCreateMissingTables membuat tabel yang dipakai aplikasi secara
// deterministik dari field pada panggilan cloudDb.insert. Ini menghilangkan
// ketergantungan pada model yang sering lupa menulis blok SQL.
func autoCreateMissingTables(p *models.Project) []string {
	missing := missingAppTables(p)
	if len(missing) == 0 {
		return nil
	}
	var files map[string]string
	if json.Unmarshal([]byte(p.Files), &files) != nil {
		return missing
	}
	sqldb, err := getAppSQLDB()
	if err != nil {
		return missing
	}
	created := []string{}
	for _, table := range missing {
		cols := inferTableColumns(files, table)
		defs := []string{"id SERIAL PRIMARY KEY"}
		for _, c := range cols {
			defs = append(defs, fmt.Sprintf("%s %s", c, inferColumnType(c)))
		}
		if !containsString(cols, "created_at") {
			defs = append(defs, "created_at TIMESTAMPTZ DEFAULT now()")
		}
		stmt := fmt.Sprintf("CREATE TABLE IF NOT EXISTS %s.%s (%s)", appSchema(fmt.Sprint(p.ID)), table, strings.Join(defs, ", "))
		if _, err := sqldb.Exec(stmt); err == nil {
			created = append(created, table)
		}
	}
	return created
}

func containsString(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}

// inferColumnType memilih tipe Postgres dari nama kolom.
func inferColumnType(name string) string {
	n := strings.ToLower(name)
	switch {
	case strings.HasSuffix(n, "_at") || strings.Contains(n, "date") || strings.Contains(n, "time"):
		return "TIMESTAMPTZ"
	case n == "price" || n == "total" || n == "amount" || n == "stock" || n == "quantity" ||
		n == "qty" || n == "count" || n == "unit_price" || n == "subtotal" || strings.HasSuffix(n, "_price"):
		return "NUMERIC"
	case strings.HasPrefix(n, "is_") || strings.HasPrefix(n, "has_"):
		return "BOOLEAN"
	default:
		return "TEXT"
	}
}

// inferTableColumns mengumpulkan nama field dari objek yang di-insert ke tabel.
func inferTableColumns(files map[string]string, table string) []string {
	// Cocokkan: cloudDb.insert(<'table'|var>, { a: ..., b: ... })
	callRe := regexp.MustCompile(`cloudDb\.insert\s*\(\s*([^,]+?)\s*,\s*\{([^{}]*)\}`)
	constRe := regexp.MustCompile(`(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?::\s*string\s*)?=\s*['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]`)
	keyRe := regexp.MustCompile(`([a-zA-Z_][a-zA-Z0-9_]*)\s*:`)
	seen := map[string]bool{}
	out := []string{}
	for _, content := range files {
		if !strings.Contains(content, "cloudDb.insert") {
			continue
		}
		vars := map[string]string{}
		for _, m := range constRe.FindAllStringSubmatch(content, -1) {
			vars[m[1]] = m[2]
		}
		for _, m := range callRe.FindAllStringSubmatch(content, -1) {
			arg := strings.TrimSpace(m[1])
			target := strings.Trim(arg, `'"`)
			if lit, ok := vars[arg]; ok {
				target = lit
			}
			if target != table {
				continue
			}
			for _, k := range keyRe.FindAllStringSubmatch(m[2], -1) {
				if !seen[k[1]] && k[1] != "id" {
					seen[k[1]] = true
					out = append(out, k[1])
				}
			}
		}
	}
	return out
}

// referencedAppTables mengekstrak nama tabel yang dipakai aplikasi dari service
// layer (cloudDb.*) supaya bisa dibandingkan dengan tabel yang ada di schema.
func referencedAppTables(files map[string]string) []string {
	// Nama tabel sering disimpan di konstanta (const p='pos_products') lalu
	// dipakai sebagai argumen cloudDb.select(p). Tangani literal DAN variabel.
	callRe := regexp.MustCompile(`cloudDb\.(?:select|insert|update|delete|del|query)\s*\(\s*(?:['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]|([a-zA-Z_$][a-zA-Z0-9_$]*))`)
	constRe := regexp.MustCompile(`(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?::\s*string\s*)?=\s*['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]`)
	seen := map[string]bool{}
	out := []string{}
	add := func(t string) {
		if t == "" || seen[t] || strings.HasPrefix(t, "app_") {
			return
		}
		seen[t] = true
		out = append(out, t)
	}
	for name, content := range files {
		if !strings.Contains(name, "src/") {
			continue
		}
		vars := map[string]string{}
		for _, m := range constRe.FindAllStringSubmatch(content, -1) {
			vars[m[1]] = m[2]
		}
		for _, m := range callRe.FindAllStringSubmatch(content, -1) {
			if m[1] != "" {
				add(m[1])
				continue
			}
			if lit, ok := vars[m[2]]; ok {
				add(lit)
			}
		}
	}
	return out
}

// missingAppTables mengembalikan tabel yang direferensikan aplikasi tetapi belum
// ada di schema proyek. Tanpa pemeriksaan ini aplikasi "berhasil build" tapi
// setiap operasi data gagal saat dipakai.
func missingAppTables(p *models.Project) []string {
	var files map[string]string
	if json.Unmarshal([]byte(p.Files), &files) != nil {
		return nil
	}
	refs := referencedAppTables(files)
	if len(refs) == 0 {
		return nil
	}
	sqldb, err := getAppSQLDB()
	if err != nil {
		return nil
	}
	rows, err := sqldb.Query("SELECT tablename FROM pg_tables WHERE schemaname = $1", appSchema(fmt.Sprint(p.ID)))
	if err != nil {
		return nil
	}
	defer rows.Close()
	existing := map[string]bool{}
	for rows.Next() {
		var n string
		if rows.Scan(&n) == nil {
			existing[n] = true
		}
	}
	missing := []string{}
	for _, t := range refs {
		if !existing[t] && !strings.HasPrefix(t, "app_") {
			missing = append(missing, t)
		}
	}
	return missing
}

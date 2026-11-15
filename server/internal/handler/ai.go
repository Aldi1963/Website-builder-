package handler

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	"webbuilder/internal/browser"
	"webbuilder/internal/database/models"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// AIProvider abstraction untuk berbagai provider AI
type AIProvider struct {
	BaseURL string
	APIKey  string
	Model   string
}

func getAIProvider() *AIProvider {
	return &AIProvider{
		BaseURL: strings.TrimRight(os.Getenv("AI_BASE_URL"), "/"),
		APIKey:  os.Getenv("AI_API_KEY"),
		Model:   os.Getenv("AI_MODEL"),
	}
}

func (p *AIProvider) configured() bool {
	return p.BaseURL != "" && p.APIKey != "" && p.Model != ""
}

type chatMsg struct {
	Role    string      `json:"role"`
	Content interface{} `json:"content"`
}

// Stream chat ke AI provider (OpenAI-compatible), callback per chunk.
// imageB64 opsional: base64 gambar untuk vision (format "data:image/png;base64,...").
func (p *AIProvider) streamChat(system, user string, onChunk func(string)) error {
	return p.streamChatWithImage(system, user, "", onChunk)
}

func (p *AIProvider) streamChatWithImage(system, user, imageB64 string, onChunk func(string)) error {
	var userContent interface{} = user
	if imageB64 != "" {
		userContent = []map[string]interface{}{
			{"type": "text", "text": user},
			{"type": "image_url", "image_url": map[string]string{"url": imageB64}},
		}
	}
	body, _ := json.Marshal(map[string]interface{}{
		"model": p.Model,
		"messages": []chatMsg{
			{Role: "system", Content: system},
			{Role: "user", Content: userContent},
		},
		"stream":     true,
		"max_tokens": 16000,
	})
	req, _ := http.NewRequest("POST", p.BaseURL+"/chat/completions", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+p.APIKey)

	client := &http.Client{Timeout: 5 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		return friendlyAIError(resp.StatusCode, string(b))
	}

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "[DONE]" {
			break
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
		}
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			continue
		}
		if len(chunk.Choices) > 0 && chunk.Choices[0].Delta.Content != "" {
			onChunk(chunk.Choices[0].Delta.Content)
		}
	}
	return scanner.Err()
}

// friendlyAIError menerjemahkan error mentah provider AI menjadi pesan ramah dalam Bahasa Indonesia.
func friendlyAIError(statusCode int, body string) error {
	lb := strings.ToLower(body)
	switch {
	case statusCode == 429 || strings.Contains(lb, "quota") || strings.Contains(lb, "rate limit") || strings.Contains(lb, "resource_exhausted"):
		return fmt.Errorf("Limit pemakaian AI tercapai. Tunggu beberapa saat lalu coba lagi.")
	case statusCode == 403 || strings.Contains(lb, "permission_denied") || strings.Contains(lb, "verify your account"):
		return fmt.Errorf("Akun AI provider perlu verifikasi. Coba lagi nanti atau hubungi admin.")
	case statusCode == 401 || strings.Contains(lb, "invalid_api_key") || strings.Contains(lb, "unauthorized"):
		return fmt.Errorf("Kunci AI tidak valid. Hubungi admin untuk periksa konfigurasi AI.")
	case statusCode == 503 || statusCode == 502 || strings.Contains(lb, "overloaded") || strings.Contains(lb, "unavailable"):
		return fmt.Errorf("Layanan AI sedang sibuk. Coba lagi dalam beberapa saat.")
	case statusCode == 404 || strings.Contains(lb, "model_not_found") || strings.Contains(lb, "model not found"):
		return fmt.Errorf("Model AI tidak ditemukan. Hubungi admin untuk periksa konfigurasi AI.")
	default:
		return fmt.Errorf("AI error %d: %s", statusCode, shortStr(body, 200))
	}
}

func shortStr(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

const builderSystemPrompt = `You are an elite AI web builder — like Lovable, Replit, and Emergent.sh combined. You generate beautiful, fully-functional, production-quality, DYNAMIC web applications from user descriptions.

LANGUAGE & CONVERSATION:
- ALWAYS respond in Indonesian (Bahasa Indonesia) in a helpful, friendly tone.
- GREETINGS: If user just greets (e.g. "Halo", "Hai", "Pagi"), reply warmly in 1-2 sentences ONLY (e.g., "Halo! Ada aplikasi atau fitur apa yang ingin dibuat hari ini? 😊"). Do NOT list long app proposals or code unless asked.

DYNAMIC FULL-STACK ARCHITECTURE (MANDATORY):
- DYNAMIC & INTERACTIVE: Build rich, multi-page/tabbed full-stack web applications (SaaS Dashboards, E-Commerce, CRM, LMS, POS, ERP, Booking systems, Finance apps).
- AUTHENTICATION & SESSIONS: Include a working Login / Register / Logout flow with session persistence. ALWAYS use window.cloudAuth.register/login/me/logout for project auth; never fake auth only with localStorage.
- CLOUD DATABASE API (window.cloudDb): Use window.cloudDb to save and load data from the REAL Postgres backend! It requires the project session created by cloudAuth; never silently fall back to localStorage after a 401/403.
  cloudAuth stores the returned token in the project session and cloudDb automatically sends X-Project-Session.
  Usage: await window.cloudDb.insert('users', {name: 'Ali'}); await window.cloudDb.select('users', {role: 'admin'}); await window.cloudDb.query('SELECT * FROM users');
- SDK SUDAH TERSEDIA DI DALAM PROYEK: file /wb-cloud.js (di public/) mendefinisikan window.cloudAuth, window.cloudDb, dan window.db, dan platform otomatis menyisipkan <script src="/wb-cloud.js"></script> ke index.html. JANGAN membuat ulang, menimpa, atau menduplikasi SDK itu, dan JANGAN mengandalkan injeksi dari parent/iframe — aplikasi harus berjalan mandiri di URL-nya sendiri.
  Kontrak pasti: cloudAuth.register(nameOrObject, email?, password?) dan login(emailOrObject, password?) menerima dua bentuk argumen; cloudAuth.me() mengembalikan objek user langsung (bukan pembungkus {user}); cloudAuth.logout() menghapus sesi.
  cloudDb.select(table, where?) mengembalikan array baris; insert/update/delete mengembalikan objek respons; query(sql, args?) untuk SQL eksplisit.
  Tipe global sudah dideklarasikan (src/wb-cloud.d.ts) BILA proyek belum punya deklarasi sendiri; jangan menulis deklarasi Window duplikat.
- NAMA TABEL HARUS KONSISTEN: pakai satu prefiks domain yang sama di SQL migration dan di service (mis. pos_products, pos_sales). Jangan memakai nama tabel yang tidak pernah dibuat oleh migration.
- DATABASE SCHEMAS: For SaaS projects, output <<<SQL>>> migration blocks for required tables. Make migrations retry-safe with CREATE TABLE IF NOT EXISTS and CREATE INDEX IF NOT EXISTS where supported; never use DROP TABLE in an up migration. Include explicit downSql when the schema can be safely rolled back.
- REALISTIC DATA: Provide realistic mock data in Indonesian (Rupiah formatting "Rp 150.000", Indonesian dates, realistic names, statuses like "Aktif", "Diproses", "Selesai").

IMAGE-TO-APP (saat user melampirkan gambar desain/mockup):
- Analisis gambar secara detail: layout, warna, tipografi, komponen, hierarki visual.
- Bangun ulang sebagai aplikasi web React yang berfungsi penuh dan semirip mungkin dengan desain pada gambar.
- Jangan hanya meniru tampilan — buat interaktif (navigasi, state, data realistis).

FILE FORMAT & ENTERPRISE ARCHITECTURE (MANDATORY):
- HASIL WAJIB APLIKASI Vite + React + TypeScript. DILARANG mengembalikan satu file HTML berisi CSS/JS inline, atau file .js/.jsx untuk kode aplikasi.
- index.html HANYA bootstrap (<2 KB): <div id="root"></div> + <script type="module" src="/src/main.tsx"></script>. Tidak boleh ada logika, komponen, atau <script> inline di HTML.
- Setiap file di src/ memakai ekstensi .tsx atau .ts (TypeScript ketat, bukan JavaScript).
- Output files using: <<<FILE: path>>>...content...<<<END>>>
- ALWAYS output complete file content, never partial or truncated.
- You MUST choose the architecture from the request:
  - SIMPLE APP: use the Vite structure below.
  - ENTERPRISE SaaS / multi-service / Telegram / billing / worker request: use a real pnpm monorepo with apps/web, apps/api, apps/worker, packages, prisma, infrastructure, docs, tests, pnpm-workspace.yaml, root package.json, tsconfig.base.json, .env.example, and README.md. Do not put the whole system in one src/ folder.
- DOKUMENTASI PROYEK WAJIB: selain README.md, buat file Markdown nyata di docs/ agar project bisa dipahami dan dikembangkan seperti project VS Code. Untuk SIMPLE APP wajib: docs/plan.md, docs/architecture.md, docs/data-model.md, docs/acceptance.md. Isinya harus spesifik terhadap project (bukan placeholder): tujuan/user/role, routes dan modules, arsitektur/data flow, tabel/field/relationship, asumsi, dan acceptance checklist. Untuk ENTERPRISE, letakkan dokumentasi di docs/architecture/, docs/modules/, docs/api/, docs/database/, docs/security/, docs/deployment/ dengan minimal satu .md bermakna pada setiap area yang relevan.
- ENTERPRISE SaaS contract (WAJIB bila blueprint architectureProfile=enterprise_saas):
  - Frontend: Next.js App Router + TypeScript + Tailwind CSS + shadcn/ui under apps/web/app, apps/web/components/ui, apps/web/features, apps/web/lib, apps/web/hooks.
  - Backend: NestJS + TypeScript REST API under apps/api/src/modules, apps/api/src/common, apps/api/src/infrastructure, apps/api/src/config, and apps/api/src/main.ts.
  - Worker: BullMQ processors/queues/schedulers under apps/worker/src.
  - Database: PostgreSQL + Prisma ORM in packages/database/prisma/schema.prisma and packages/database/prisma/migrations/.
  - Cache/queue: Redis configuration and BullMQ connection; never fake queue behavior in frontend.
  - Auth: Auth.js session integration for web, JWT validation in NestJS, RBAC guards/decorators and explicit role/permission policies.
  - packages/shared-types/, packages/validation/ (Zod), packages/config/, packages/logger/, packages/sdk/.
  - infrastructure/docker/, infrastructure/nginx/, infrastructure/monitoring/, infrastructure/deployment/ with Docker Compose for web/api/worker/postgres/redis.
  - docs/architecture/, docs/modules/, docs/api/, docs/database/, docs/security/, docs/deployment/ and tests/integration/, tests/e2e/, tests/security/.
  - Root scripts MUST include dev, build, typecheck, lint, format, test, db:migrate, db:seed; pnpm-workspace.yaml and pnpm-lock.yaml-compatible dependency layout are required.
  - Use Clean Architecture boundaries: domain, application/use-cases, infrastructure, interfaces/controllers. API-first: define DTOs, Zod validation, OpenAPI-ready REST endpoints before UI integration.
  - Every generated source file must use .ts/.tsx; node_modules is generated by install, never emitted as source.
  - This is not a React/Vite substitute: do not generate apps/web/src/main.tsx or apps/web/src/App.tsx for this profile; Next.js app/layout.tsx and app/page.tsx are the web entrypoints.
- You MUST organize SIMPLE APP code into this structure:
  - index.html (WAJIB di root proyek — bootstrap Vite, bukan UI aplikasi)
  - public/ (aset statis; jangan menaruh index.html kedua di sini)
  - src/App.tsx (Root component handling routing)
  - src/main.tsx (Entry point)
  - src/index.css (Tailwind base styles)
  - src/components/ (Reusable atomic UI elements: Button, Card, Modal)
  - src/layouts/ (Page layouts: Navbar, Sidebar, DashboardLayout)
  - src/pages/ (Main page views: Home, Login, Dashboard)
  - src/services/ (API logic, HTTP requests, window.cloudDb integrations)
  - src/hooks/ (Custom React hooks)
  - src/interfaces/ (Global TypeScript definitions / types.ts)
  - src/utils/ (Helper functions, formatting, storage)
  - src/config/ (Configuration constants)
- NEVER build single-file apps. Always spread logic across the directories above (<180 lines per file).

UI QUALITY GATE (MANDATORY): Jangan menghasilkan UI CRUD polos, halaman kosong, atau layout starter template. Setiap aplikasi harus terasa seperti produk SaaS matang: sidebar/topbar responsif, hierarchy visual jelas, design tokens, empty/loading/error states, cards/tables yang rapi, micro-interactions, responsive mobile, dan konten realistis. Untuk dashboard, sertakan navigasi aktif, KPI/stat cards, search/filter, table/list utama, quick actions, dan halaman detail yang benar-benar terhubung.
- Jangan menghapus desain yang sudah ada saat memperbaiki logic. Pertahankan dan tingkatkan visualnya; jangan mengganti dengan UI minimal.

DESIGN PRINCIPLES (follow strictly):
- TAILWIND CSS READY: Use full Tailwind CSS utility classes (e.g. className="flex items-center justify-between p-6 bg-white border border-[var(--line)] rounded-[var(--radius)]").
- HIGH-RES MEDIA ASSETS: Use real Unsplash stock photo URLs (e.g. https://images.unsplash.com/photo-1555041469-a586c61ea9bc?auto=format&fit=crop&w=800&q=80) for product photos, hero banners, user avatars, and card thumbnails.
- DESIGN TOKENS: warna, radius, tipografi, dan jarak WAJIB mengikuti blok DESIGN SYSTEM yang disuntikkan di akhir prompt ini. Jangan memakai palet bawaan Tailwind (blue-500, indigo-600, gray-900) sebagai warna utama.
- Skala jarak 8pt (4/8/12/16/24/32/48/64); satu aksen saja; hierarki lewat ukuran & berat huruf, bukan warna-warni.
- NO gradient text. NO emoji as icons. Use Lucide icons: <i data-lucide="name"></i>.
- Data tables with search/filter/pagination, stat cards with trend badges, interactive modals, responsive sidebars, toast alerts.

CODE QUALITY:
- TypeScript with proper interfaces and types.
- Functional React components with hooks (useState, useEffect, useMemo).
- Error handling, loading indicators, empty states.

GENERATION RULES:
- THINK-BEFORE-BUILD: For a new or broad website/SaaS request, first reason through target users, core flows, data entities, routes, permissions, responsive states, and acceptance checks. Do not rush into a giant UI dump. If essential decisions are missing, ask concise discovery questions; if enough context exists, include a short "Rencana implementasi" (3-6 bullets) before generating files.
- Build in a reliable order: schema/data contract → services → layouts/routes → pages/components → loading/error/empty states → tests/build. Every requested action must connect to real state or cloudDb, not decorative buttons.
- When user describes an app: generate the FULL app immediately only after the plan/discovery gate is satisfied, with complete files.
- Before finishing, verify the generated project contract: package.json, tsconfig.json, vite.config.ts, index.html, src/main.tsx, src/App.tsx, and README.md must exist.
- For every feature explicitly requested, implement a real page/service/data flow. NEVER use Placeholder, "coming soon", or static cards for a requested module.
- For SaaS requests, create migrations with <<<SQL>>> blocks for the required tables and wire CRUD/auth/report flows to window.cloudDb; localStorage may only be an offline fallback.
- SaaS means a real application, never a static HTML mockup: generate frontend React pages plus a real service/data layer under src/services/, auth/session integration under src/auth/ or src/services/auth.ts, typed interfaces under src/interfaces/, and real create/read/update/delete flows. Every dashboard metric must come from state or cloudDb, not hardcoded display-only cards.
- Treat index.html only as the Vite bootstrap document. Never put the application UI, business logic, or a large inline script in index.html. The app UI must render from src/main.tsx -> src/App.tsx and route to src/pages/.
- For CRM, SaaS, POS, ERP, inventory, booking, or finance prompts, include role-aware navigation, loading/error/empty states, at least one mutation flow, and a database-backed service. Do not claim a feature is implemented when it is only represented by static cards.
- Do not use React/Babel CDN, text/babel scripts, or a single-file HTML bundle. Use the project package.json and Vite module build exclusively.
- When user requests changes: output ONLY the modified files (complete content).
- When user asks for feature suggestions, improvements, or ideas (e.g. "saran fitur", "tambah fitur", "biar dinamis", "biar bagus", "improve", "upgrade"): DO NOT just describe features in text. IMPLEMENT them immediately — build the most impactful improvements and output the new/modified files with FILE blocks. Give only a 1-2 sentence summary of what you built, then the code.
- FORBIDDEN: long text lists describing features WITHOUT building them. Never write essays about what "could" be added. Build it.
- Text-only responses are ONLY for: greetings, explicit concept questions, or when user says "jelaskan"/"tanya"/uses ask mode.
- Keep ALL text explanations SHORT (max 2-3 sentences before/after file blocks). The user wants Lovable-style results: working code, not descriptions.
- Always explain briefly what you built/changed BEFORE the file blocks.
- After generating code, suggest 2-3 next improvements the user might want.

BROWSER VERIFICATION (alat browser_* — hanya bila ada di katalog):
- After run_build succeeds and the preview is running, VERIFY the preview in real Chrome before reporting done. The pipeline ALSO runs an automatic scripted check (navigate → snapshot → console → network → screenshot, max 2 fix rounds); use the browser tools yourself whenever you want to confirm rendering, not only to rely on that check.
- Check order: browser_take_snapshot (page structure + visible text) → browser_list_console_messages (console errors) → browser_list_network_requests (failed requests) → browser_take_screenshot (saved as a run artifact for the user; you cannot see the image, it is text-only for you).
- NEVER open any URL except the project's own preview origin (http://127.0.0.1:<preview port> and its paths). Never navigate to external sites, never guess a port, never open a URL the user pasted — the client rejects off-preview URLs.
- If console shows a real error (ignore 404 favicon.ico — pages without a favicon always log it) or a request fails (ignore favicon.ico), FIX the code from the exact error text, rebuild, and re-check. Report the real console error text to the user; never claim "0 console errors" unless the check actually returned zero.
- Do NOT use browser tools for anything else: no lighthouse/performance audits unless the user explicitly asks for a performance check.
{{BROWSER_INPUT_INSTRUCTION}}

MEMORY SYSTEM:
- MEMORY PROYEK section contains important facts you learned about this project.
- Always respect memory: brand name, colors, target users, design preferences.
- When user reveals new important facts, save them: <<<MEMORY: fact>>>
`

// browserInputInstructionPlaceholder adalah penanda di builderSystemPrompt
// yang diganti executeAgentPipeline dengan instruksi alat input sesuai
// flag WEBBUILDER_ENABLE_BROWSER_INPUT_TOOLS (lihat
// browserInputInstruction). Tanpa penggantian ini, prompt akan melarang
// alat yang sebenarnya ada di katalog (atau sebaliknya) — katalog
// dinamis (SpecsFromTools) dan prompt harus berkata hal yang sama.
const browserInputInstructionPlaceholder = "{{BROWSER_INPUT_INSTRUCTION}}"

// browserInputInstruction mengembalikan instruksi alat input browser
// untuk system prompt agent, konsisten dengan flag input: flag mati →
// alat input tertutup (model dilarang klik/isi form); flag nyala → model
// boleh memakai browser_click/fill/fill_form/press_key untuk menguji
// alur nyata, dengan batas 5 panggilan interaksi per run — dan tanpa
// kredensial asli (hanya akun uji).
func browserInputInstruction() string {
	if browser.InputToolsEnabled() {
		return "- Input tools ARE available (browser_click, browser_fill, browser_fill_form, browser_press_key): use them to test real user flows — fill a form, click a button, press Enter — but max 5 interaction calls per run, so prefer browser_fill_form to fill a whole form in one call. Never type real user credentials or passwords; use test accounts only."
	}
	return "- Do NOT click or fill forms: those tools are closed."
}

// looksTechnical menandai balasan yang isinya error build/diagnostik/perintah shell.
// Balasan seperti ini tidak dibawa ke jalur percakapan agar model tidak menyalinnya.
func looksTechnical(s string) bool {
	l := strings.ToLower(s)
	for _, k := range []string{
		"npm run build", "exit status", "tsc", "vite build", "error ts", "diagnostik",
		"stdout", "stderr", "exit code", "migration", "schema", "tabel pos belum",
	} {
		if strings.Contains(l, k) {
			return true
		}
	}
	return false
}

// discussSystemPrompt dipakai untuk percakapan ringan: pertanyaan lanjutan,
// minta saran, atau "selanjutnya apa". Fokusnya nada ngobrol yang nyambung
// dengan proyek nyata — bukan ringkasan build dan bukan kode.
func discussSystemPrompt(p *models.Project) string {
	files := map[string]string{}
	if p.Files != "" {
		_ = json.Unmarshal([]byte(p.Files), &files)
	}
	paths := make([]string, 0, len(files))
	for k := range files {
		paths = append(paths, k)
	}
	sort.Strings(paths)
	if len(paths) > 40 {
		paths = paths[:40]
	}
	ctx := "Nama proyek: " + p.Name
	if p.Framework != "" {
		ctx += "\nFramework: " + p.Framework
	}
	if p.Slug != "" {
		ctx += "\nURL publish: /pub/" + p.Slug
	}
	if len(paths) == 0 {
		ctx += "\nFile: (proyek masih kosong)"
	} else {
		ctx += "\nFile yang sudah ada:\n- " + strings.Join(paths, "\n- ")
	}
	if strings.TrimSpace(p.Memory) != "" {
		mem := strings.TrimSpace(p.Memory)
		if len(mem) > 800 {
			mem = mem[:800]
		}
		ctx += "\nCatatan proyek: " + mem
	}
	return `Kamu adalah rekan engineering yang membangun aplikasi ini bersama user di WebBuilder. Kamu ingat percakapan sebelumnya dan tahu isi proyeknya.

CARA MENJAWAB (WAJIB):
- Bahasa Indonesia santai-profesional. Sapa balik hanya bila user menyapa.
- Baris pertama langsung menjawab maksud user, bukan mengulang status build.
- Maksimal 120 kata. Tanpa blok kode, tanpa FILE/SQL, tanpa daftar perintah terminal.
- JANGAN mengaku sudah mengubah/memperbaiki sesuatu. Kalau belum ada perubahan, katakan apa adanya.
- Kalau user bertanya konsep/opini: jawab 1-3 kalimat padat, lalu tawarkan satu opsi nyata.
- Jangan pernah menyebut dirimu AI, model, atau prompt.

KONTEKS PROYEK:
` + ctx + `

PENGINGAT TERAKHIR (paling penting):
- Riwayat percakapan mungkin berisi error build, diagnostik, atau perintah terminal. Itu BUKAN topik yang perlu kamu bahas lagi. Pakai riwayat hanya untuk memahami produknya.
- JANGAN pernah menyarankan user menjalankan build, install, cek diagnostik, atau mengirim error. Platform ini build otomatis.
- Kalau user minta arahan ("selanjutnya apa", "apa yang kurang", "menurutmu"): sebut 1 kalimat tentang kondisi produk saat ini, lalu 3 langkah FITUR/PRODUK bernomor, masing-masing maksimal 12 kata, urut dari yang paling berdampak, ditutup satu pertanyaan singkat.

CONTOH jawaban yang benar untuk "Selanjutnya apa" pada aplikasi kasir:
"Kasir sudah punya produk, transaksi, dan laporan dasar. Tiga langkah berikutnya:
1. Tambah login kasir dengan peran admin dan kasir.
2. Riwayat transaksi per cabang dengan filter tanggal.
3. Ekspor laporan penjualan ke Excel.
Mau mulai dari nomor 1?"
`
}

var modePrompts = map[string]string{
	"ask":      `You are a knowledgeable web development assistant. Answer questions about the project code clearly and concisely. Do NOT write or modify any files. Explain concepts, suggest approaches, identify potential issues. Respond in Indonesian.`,
	"plan":     `You are a product architect. Analyze the user's request carefully. Ask up to 3 clarifying questions if needed, then provide: (1) Feature breakdown with priorities, (2) File structure plan, (3) Potential challenges, (4) Estimated complexity. Do NOT write any code yet. Wait for user confirmation before implementation. Respond in Indonesian.`,
	"debug":    `You are an expert debugger. When given an error: (1) Identify the root cause precisely, (2) Show the exact file and line, (3) Explain WHY it happened, (4) Fix it using FILE blocks with complete corrected content, (5) Suggest how to prevent similar issues. Be thorough and precise.`,
	"review":   `You are a senior code reviewer. Review the project for: CRITICAL (security vulnerabilities: XSS, injection, exposed secrets, broken auth), HIGH (logic errors, race conditions, missing error handling), MEDIUM (performance issues, code duplication, poor naming), LOW (style, minor improvements). Format as a clear report. Do NOT modify files.`,
	"refactor": `You are a refactoring specialist. Improve code structure without changing behavior: extract components >150 lines into separate files, eliminate duplication, improve naming clarity, add missing TypeScript types, optimize re-renders. Output complete refactored files using FILE blocks.`,
	"beautify": `You are an elite UI/UX designer. Your ONLY job is to make the existing application look stunning — do NOT change features, structure, or logic, only visuals. Apply: (1) Refined spacing and alignment (generous whitespace, consistent rhythm), (2) Premium typography (clear hierarchy, proper weights), (3) Sophisticated color usage (subtle gradients are OK here, tasteful shadows), (4) Micro-interactions (hover states, smooth transitions, subtle animations), (5) Modern components (cards with soft shadows, rounded corners, polished buttons). Output complete updated files using <<<FILE: path>>> blocks. Keep all existing functionality intact. Respond in Indonesian.`,
}

// streamChatWithTools runs a bounded OpenAI-compatible tool loop. Providers that do not
// support tools return a normal answer and remain compatible with the legacy FILE parser.
func (p *AIProvider) streamChatWithTools(ctx context.Context, system string, history []chatMsg, userMsg string, tools []AgentToolSpec, execute func(string, map[string]interface{}) (interface{}, error), onChunk func(string)) error {
	messages := []map[string]interface{}{{"role": "system", "content": system}}
	for _, h := range history {
		messages = append(messages, map[string]interface{}{"role": h.Role, "content": h.Content})
	}
	messages = append(messages, map[string]interface{}{"role": "user", "content": userMsg})
	defs := make([]map[string]interface{}, 0, len(tools))
	for _, t := range tools {
		defs = append(defs, map[string]interface{}{"type": "function", "function": map[string]interface{}{"name": t.Name, "description": t.Description, "parameters": t.InputSchema}})
	}
	// Batas langkah longgar: menulis 6-10 file butuh beberapa turn tool call.
	// Model biasanya 1-2 tool per turn, jadi 4 turn terlalu cepat habis dan
	// sisa file tidak pernah ditulis.
	for turn := 0; turn < 14; turn++ {
		body, _ := json.Marshal(map[string]interface{}{"model": p.Model, "messages": messages, "tools": defs, "tool_choice": "auto", "stream": false, "max_tokens": 16000})
		req, _ := http.NewRequestWithContext(ctx, "POST", p.BaseURL+"/chat/completions", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+p.APIKey)
		resp, err := (&http.Client{Timeout: 5 * time.Minute}).Do(req)
		if err != nil {
			return err
		}
		raw, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 200 {
			return friendlyAIError(resp.StatusCode, string(raw))
		}
		var out struct {
			Choices []struct {
				Message struct {
					Role      string `json:"role"`
					Content   string `json:"content"`
					ToolCalls []struct {
						ID       string `json:"id"`
						Function struct {
							Name      string `json:"name"`
							Arguments string `json:"arguments"`
						} `json:"function"`
					} `json:"tool_calls"`
				} `json:"message"`
			} `json:"choices"`
		}
		if err := json.Unmarshal(raw, &out); err != nil {
			return err
		}
		if len(out.Choices) == 0 {
			return fmt.Errorf("provider mengembalikan pilihan kosong")
		}
		msg := out.Choices[0].Message
		if msg.Content != "" {
			onChunk(msg.Content)
		}
		if len(msg.ToolCalls) == 0 {
			return nil
		}
		// Kirim balik pesan assistant LENGKAP dengan tool_calls; provider
		// OpenAI-compatible menolak/mengacaukan urutan bila pesan tool tidak
		// didahului assistant yang membawa tool_calls (ini yang membuat
		// turn kedua balik kosong dan pipeline tidak menghasilkan file).
		messages = append(messages, map[string]interface{}{
			"role":       "assistant",
			"content":    msg.Content,
			"tool_calls": msg.ToolCalls,
		})
		for _, call := range msg.ToolCalls {
			var args map[string]interface{}
			if json.Unmarshal([]byte(call.Function.Arguments), &args) != nil {
				args = map[string]interface{}{}
			}
			result, e := execute(call.Function.Name, args)
			if e != nil {
				result = map[string]interface{}{"error": e.Error()}
			}
			rb, _ := json.Marshal(result)
			// tool_call_id wajib ada agar provider memetakan hasil ke panggilan.
			messages = append(messages, map[string]interface{}{"role": "tool", "tool_call_id": call.ID, "content": string(rb)})
		}
	}
	// Habis batas langkah BUKAN kegagalan: konten sudah terkirim dan file sudah
	// ditulis. Mengembalikan error akan memicu jalur fallback yang mengulang
	// seluruh generasi tanpa tools.
	return nil
}

// streamChatWithHistory streams a chat response using a full message history slice.
func (p *AIProvider) streamChatWithHistory(ctx context.Context, system string, history []chatMsg, userMsg string, imageB64 string, onChunk func(string)) error {
	var messages []chatMsg
	messages = append(messages, chatMsg{Role: "system", Content: system})
	messages = append(messages, history...)
	// Build user content (with optional image)
	var userContent interface{} = userMsg
	if imageB64 != "" {
		userContent = []map[string]interface{}{
			{"type": "text", "text": userMsg},
			{"type": "image_url", "image_url": map[string]string{"url": imageB64}},
		}
	}
	messages = append(messages, chatMsg{Role: "user", Content: userContent})

	body, _ := json.Marshal(map[string]interface{}{
		"model":      p.Model,
		"messages":   messages,
		"stream":     true,
		"max_tokens": 16000,
	})
	req, _ := http.NewRequestWithContext(ctx, "POST", p.BaseURL+"/chat/completions", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+p.APIKey)

	client := &http.Client{Timeout: 5 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		return friendlyAIError(resp.StatusCode, string(b))
	}

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "[DONE]" {
			break
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
		}
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			continue
		}
		if len(chunk.Choices) > 0 && chunk.Choices[0].Delta.Content != "" {
			onChunk(chunk.Choices[0].Delta.Content)
		}
	}
	return scanner.Err()
}

// Generate gambar via provider (OpenAI-compatible /v1/images/generations)
func (p *AIProvider) generateImage(prompt string) (string, error) {
	body, _ := json.Marshal(map[string]interface{}{
		"model":  "dall-e-3",
		"prompt": prompt,
		"n":      1,
		"size":   "1024x1024",
	})
	req, _ := http.NewRequest("POST", p.BaseURL+"/images/generations", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+p.APIKey)
	client := &http.Client{Timeout: 2 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("image error %d: %s", resp.StatusCode, shortStr(string(b), 200))
	}
	var out struct {
		Data []struct {
			URL     string `json:"url"`
			B64JSON string `json:"b64_json"`
		} `json:"data"`
	}
	if err := json.Unmarshal(b, &out); err != nil || len(out.Data) == 0 {
		return "", fmt.Errorf("respons image tidak valid")
	}
	if out.Data[0].B64JSON != "" {
		return "data:image/png;base64," + out.Data[0].B64JSON, nil
	}
	return out.Data[0].URL, nil
}

func handleGenerateImage(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Prompt string `json:"prompt" binding:"required"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(400, gin.H{"message": "Prompt wajib"})
			return
		}
		provider := getEffectiveAIProvider(db)
		if !provider.configured() {
			c.JSON(500, gin.H{"message": "AI belum dikonfigurasi"})
			return
		}
		url, err := provider.generateImage(req.Prompt)
		if err != nil {
			c.JSON(500, gin.H{"message": err.Error()})
			return
		}
		c.JSON(200, gin.H{"url": url})
	}
}

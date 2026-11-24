// Package securityscan memindai kode hasil generate + policy database proyek
// SEBELUM publish, memakai pola statis (regex) — bukan analisis taint-flow
// dan bukan penjamin keamanan.
//
// Keputusan gating (lihat handler.publishProject):
//   - temuan KRITIS  -> publish DIBLOKIR (fail-closed);
//   - temuan high/medium/low -> publish jalan, tapi laporan ikut terkirim
//     sebagai peringatan tegas.
//
// Scanner pola statis TIDAK BISA membuktikan tidak ada celah: ia hanya
// melaporkan pola yang dikenali. Laporan selalu membawa Limitations agar
// "tidak ada temuan pola" tidak pernah dibaca sebagai "aman".
package securityscan

import (
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Severity adalah tingkat keparahan temuan.
type Severity string

const (
	SeverityCritical Severity = "critical"
	SeverityHigh     Severity = "high"
	SeverityMedium   Severity = "medium"
	SeverityLow      Severity = "low"
)

// Category adalah kelompok temuan.
type Category string

const (
	CategorySecret     Category = "secret"
	CategorySQLI       Category = "sql-injection"
	CategoryXSS        Category = "xss"
	CategoryCodeInject Category = "code-injection"
	CategoryAuth       Category = "auth"
	CategoryPolicy     Category = "db-policy"
)

// Finding adalah satu temuan pemindaian.
type Finding struct {
	ID       string   `json:"id"`
	Severity Severity `json:"severity"`
	Category Category `json:"category"`
	File     string   `json:"file"`
	Line     int      `json:"line"`
	Message  string   `json:"message"`
	Snippet  string   `json:"snippet"`
	Rule     string   `json:"rule"`
}

// Summary menghitung temuan per severity.
type Summary struct {
	Critical int `json:"critical"`
	High     int `json:"high"`
	Medium   int `json:"medium"`
	Low      int `json:"low"`
	Total    int `json:"total"`
}

// Report adalah hasil lengkap satu pemindaian.
type Report struct {
	Passed        bool      `json:"passed"`  // true = tidak ada temuan kritis
	Blocked       bool      `json:"blocked"` // true = ada temuan kritis, publish diblokir
	Summary       Summary   `json:"summary"`
	Findings      []Finding `json:"findings"`
	ScannedFiles  int       `json:"scannedFiles"`
	ScannedAt     time.Time `json:"scannedAt"`
	PolicyChecked bool      `json:"policyChecked"`
	PolicyRows    int       `json:"policyRows"`
	PolicyNote    string    `json:"policyNote,omitempty"`
	Limitations   string    `json:"limitations"`
}

// LimitationsText ditulis di setiap laporan supaya hasil tidak pernah
// dibaca sebagai jaminan keamanan.
const LimitationsText = "Pemindaian ini memakai pencocokan pola statis atas kode dan policy yang " +
	"tersimpan; ia tidak menjalankan kode, tidak menelusuri alur data (taint-flow), dan tidak " +
	"menguji aplikasi yang sudah berjalan. \"Tidak ada temuan\" berarti tidak ada pola yang " +
	"dikenali — BUKAN berarti aplikasi aman. Secret yang disamarkan (mis. dipecah jadi " +
	"beberapa potongan string), injeksi lewat jalur tidak langsung, dan celah logika bisnis " +
	"tidak terdeteksi. Periksa temuan secara manual sebelum publish."

// MaxFindings membatasi ukuran laporan; bila terlampaui, temuan berlebih
// dibuang (yang kritis didahulukan) dan Truncated dicatat lewat PolicyNote.
const MaxFindings = 100

type rule struct {
	id       string
	severity Severity
	category Category
	re       *regexp.Regexp
	message  string
	// codeOnly: hanya berlaku untuk file kode (bukan .md/.txt/.env).
	codeOnly bool
	// valueGroup: bila >= 0, grup ini adalah NILAI yang harus lolos
	// allowlist placeholder (bukan secret sungguhan).
	valueGroup int
}

func mustRe(p string) *regexp.Regexp { return regexp.MustCompile(p) }

var secretRules = []rule{
	{
		id: "secret-aws-access-key", severity: SeverityCritical, category: CategorySecret,
		re:      mustRe(`AKIA[0-9A-Z]{16}`),
		message: "AWS access key tertulis di kode — pindahkan ke env server, jangan commit ke repo/file proyek.",
	},
	{
		id: "secret-stripe-live", severity: SeverityCritical, category: CategorySecret,
		re:      mustRe(`sk_live_[A-Za-z0-9]{16,}`),
		message: "Stripe live secret key tertulis di kode — kunci ini bisa menarik dana; cabut dan pindahkan ke env server.",
	},
	{
		id: "secret-openai-key", severity: SeverityCritical, category: CategorySecret,
		re:      mustRe(`sk-[A-Za-z0-9]{20,}`),
		message: "API key (format sk-...) tertulis di kode — pindahkan ke env server.",
	},
	{
		id: "secret-github-token", severity: SeverityCritical, category: CategorySecret,
		re:      mustRe(`(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{20,}`),
		message: "Token GitHub tertulis di kode — cabut token ini dan pindahkan ke env server.",
	},
	{
		id: "secret-google-api-key", severity: SeverityCritical, category: CategorySecret,
		re:      mustRe(`AIza[0-9A-Za-z_\-]{35}`),
		message: "Google API key tertulis di kode — batasi di Google Cloud Console dan pindahkan ke env server.",
	},
	{
		id: "secret-slack-token", severity: SeverityCritical, category: CategorySecret,
		re:      mustRe(`xox[baprs]-[A-Za-z0-9\-]{10,}`),
		message: "Token Slack tertulis di kode — cabut dan pindahkan ke env server.",
	},
	{
		id: "secret-private-key", severity: SeverityCritical, category: CategorySecret,
		re:      mustRe(`-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----`),
		message: "Private key tertulis di kode — private key tidak boleh ada di file proyek.",
	},
	{
		id: "secret-jwt-literal", severity: SeverityCritical, category: CategorySecret,
		re:      mustRe(`eyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+`),
		message: "Token JWT literal tertulis di kode — token bisa dipakai siapa pun yang membaca file ini; pakai sesi server.",
	},
	{
		id: "secret-bearer-literal", severity: SeverityCritical, category: CategorySecret,
		re:      mustRe(`(?i)Bearer\s+[A-Za-z0-9._\-]{20,}`),
		message: "Bearer token literal tertulis di kode — pindahkan ke env server.",
	},
	{
		id: "secret-assigned", severity: SeverityCritical, category: CategorySecret,
		re:         mustRe(`(?i)(api[_-]?key|apikey|api[_-]?secret|secret[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)\s*[:=]\s*['"]([^'"]+)['"]`),
		message:    "Nilai secret/API key ditulis langsung di kode — pakai import.meta.env / process.env, bukan literal.",
		valueGroup: 2,
	},
	{
		id: "secret-password-assigned", severity: SeverityCritical, category: CategorySecret,
		re:         mustRe(`(?i)password\s*[:=]\s*['"]([^'"]{4,})['"]`),
		message:    "Password ditulis langsung di kode — jangan hardcode password; pakai env atau hash bcrypt di server.",
		valueGroup: 1,
	},
}

var codeRules = []rule{
	{
		id: "sqli-template-literal", severity: SeverityCritical, category: CategorySQLI, codeOnly: true,
		re:      mustRe("`[^`]{0,400}\\b(SELECT|INSERT\\s+INTO|UPDATE\\s+\\w+\\s+SET|DELETE\\s+FROM|DROP\\s+TABLE)\\b[^`]{0,400}\\$\\{"),
		message: "SQL dibangun dari template literal berisi ${...} — input pengguna bisa lolos ke query. Pakai parameter ($1, $2 / args) lewat cloudDb.query(sql, args).",
	},
	{
		id: "sqli-query-concat", severity: SeverityCritical, category: CategorySQLI, codeOnly: true,
		re:      mustRe(`(?i)\.(query|raw|execute)\s*\([^)]*\+`),
		message: "Query SQL dibangun dengan konkatenasi string (+) — input bisa lolos ke query. Pakai parameter, bukan gabung string.",
	},
	{
		id: "sqli-string-concat", severity: SeverityCritical, category: CategorySQLI, codeOnly: true,
		re:      mustRe(`(?i)["'][^"'\n]{0,120}\b(SELECT\b[^"'\n]*\bFROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b[^"'\n]{0,120}["']\s*\+`),
		message: "String SQL digabung dengan + — gabungkan lewat parameter query, bukan konkatenasi.",
	},
	{
		id: "sqli-where-concat", severity: SeverityCritical, category: CategorySQLI, codeOnly: true,
		re:      mustRe(`(?i)WHERE\s+[^"'\n]{0,120}\+\s*[A-Za-z_$]`),
		message: "Klausa WHERE digabung dengan variabel lewat + — pakai parameter query.",
	},
	{
		id: "xss-dangerously-set-html", severity: SeverityHigh, category: CategoryXSS, codeOnly: true,
		re:      mustRe(`dangerouslySetInnerHTML`),
		message: "dangerouslySetInnerHTML merender HTML mentah — pastikan isinya sudah disanitasi (mis. DOMPurify), atau pakai teks biasa.",
	},
	{
		id: "xss-inner-html", severity: SeverityHigh, category: CategoryXSS, codeOnly: true,
		re:      mustRe(`innerHTML\s*\+?=\s*[^'"\s]`),
		message: "innerHTML diisi dari nilai non-literal — bisa jadi celah XSS bila nilainya dari pengguna. Pakai textContent atau sanitasi.",
	},
	{
		id: "xss-outer-html", severity: SeverityMedium, category: CategoryXSS, codeOnly: true,
		re:      mustRe(`outerHTML\s*\+?=\s*[^'"\s]`),
		message: "outerHTML diisi dari nilai non-literal — periksa sumber nilainya, bisa jadi celah XSS.",
	},
	{
		id: "xss-document-write", severity: SeverityHigh, category: CategoryXSS, codeOnly: true,
		re:      mustRe(`document\.write\s*\(`),
		message: "document.write merender string mentah ke halaman — hindari; pakai DOM API / React.",
	},
	{
		id: "xss-vue-html", severity: SeverityHigh, category: CategoryXSS, codeOnly: true,
		re:      mustRe(`v-html\s*=`),
		message: "v-html merender HTML mentah — pastikan isinya sudah disanitasi.",
	},
	{
		id: "codeinj-eval", severity: SeverityHigh, category: CategoryCodeInject, codeOnly: true,
		re:      mustRe(`\beval\s*\(`),
		message: "eval() mengeksekusi string sebagai kode — jangan pakai dengan input apa pun.",
	},
	{
		id: "codeinj-new-function", severity: SeverityHigh, category: CategoryCodeInject, codeOnly: true,
		re:      mustRe(`new\s+Function\s*\(`),
		message: "new Function() mengeksekusi string sebagai kode — sama berbahayanya dengan eval().",
	},
	{
		id: "auth-skip", severity: SeverityHigh, category: CategoryAuth, codeOnly: true,
		re:      mustRe(`(?i)(skipAuth|bypassAuth|disableAuth|authDisabled|noAuth)\s*[:=]\s*true`),
		message: "Auth dimatikan/dilewati secara eksplisit di kode — pastikan ini bukan tertinggal dari debug.",
	},
	{
		id: "auth-fake-login", severity: SeverityHigh, category: CategoryAuth, codeOnly: true,
		re:      mustRe(`isAuthenticated\s*=\s*true`),
		message: "Status login di-set true secara literal — login seperti ini bisa dilewati siapa pun.",
	},
	{
		id: "auth-jwt-hardcoded-secret", severity: SeverityCritical, category: CategoryAuth, codeOnly: true,
		re:      mustRe(`jwt\.sign\s*\([^,]+,\s*['"][^'"]{8,}['"]`),
		message: "jwt.sign memakai secret literal di kode — siapa pun yang membaca file ini bisa menempa token. Pakai env server.",
	},
	{
		id: "auth-cors-wildcard", severity: SeverityMedium, category: CategoryAuth, codeOnly: true,
		re:      mustRe(`(?i)Access-Control-Allow-Origin['"]?\s*[:=]\s*['"]\*['"]`),
		message: "CORS mengizinkan semua origin (*) — batasi ke origin aplikasi sendiri bila endpoint memakai kredensial.",
	},
}

// placeholderValue: true bila nilai yang tertangkap rule secret adalah
// placeholder/contoh (bukan secret sungguhan).
func placeholderValue(v string) bool {
	s := strings.ToLower(strings.TrimSpace(v))
	if s == "" || len(s) < 4 {
		return true
	}
	if strings.Contains(s, "${") {
		return true // nilai berasal dari interpolasi/env saat jalan, bukan literal
	}
	for _, p := range []string{
		"your_", "your-", "example", "placeholder", "changeme", "change-me",
		"xxx", "dummy", "insert", "todo", "sample", "test-key", "test_key",
		"123456", "password", "secret", "abcdef",
	} {
		if strings.Contains(s, p) {
			return true
		}
	}
	// Satu karakter berulang ("aaaa…", "****") bukan secret.
	allSame := true
	for i := 1; i < len(s); i++ {
		if s[i] != s[0] {
			allSame = false
			break
		}
	}
	return allSame
}

// isCodeFile: file yang diperiksa rule kode (SQLi/XSS/auth).
func isCodeFile(path string) bool {
	lower := strings.ToLower(path)
	for _, ext := range []string{".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".html", ".vue", ".sql"} {
		if strings.HasSuffix(lower, ext) {
			return true
		}
	}
	return false
}

// scannable: file yang dipindai sama sekali (bukan lockfile, bundle, atau
// hasil build — memindai dist hanya mengulang isi src).
func scannable(path string) bool {
	lower := strings.ToLower(path)
	if strings.Contains(lower, "node_modules/") || strings.HasPrefix(lower, "dist/") ||
		strings.Contains(lower, "/dist/") || strings.HasSuffix(lower, ".map") ||
		strings.HasSuffix(lower, ".lock") || strings.HasSuffix(lower, "package-lock.json") {
		return false
	}
	return true
}

// inComment: true bila kecocokan berada di dalam komentar baris itu
// (// ... atau # ... atau * ...). Mengurangi false positive dari contoh
// di komentar — komentar tetap bukan tempat secret, tapi pola di komentar
// hampir selalu berupa contoh/dokumentasi.
func inComment(line string, idx int) bool {
	before := line[:idx]
	trimmed := strings.TrimSpace(line)
	if strings.HasPrefix(trimmed, "//") || strings.HasPrefix(trimmed, "#") ||
		strings.HasPrefix(trimmed, "*") || strings.HasPrefix(trimmed, "<!--") {
		return true
	}
	if i := strings.Index(before, "//"); i >= 0 {
		return true
	}
	if i := strings.Index(before, "#"); i >= 0 {
		return true
	}
	return false
}

func itoa(n int) string { return strconv.Itoa(n) }

func snippetOf(line string) string {
	s := strings.TrimSpace(line)
	if len(s) > 200 {
		s = s[:200] + "…"
	}
	return s
}

// ScanFiles memindai map path -> isi file dan mengembalikan laporan.
func ScanFiles(files map[string]string) Report {
	rep := Report{ScannedAt: time.Now().UTC(), Findings: []Finding{}, Limitations: LimitationsText}
	seen := map[string]bool{}
	paths := make([]string, 0, len(files))
	for p := range files {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	for _, path := range paths {
		if !scannable(path) {
			continue
		}
		rep.ScannedFiles++
		content := files[path]
		isCode := isCodeFile(path)
		lines := strings.Split(content, "\n")
		check := func(r rule) {
			if r.codeOnly && !isCode {
				return
			}
			for ln, line := range lines {
				for _, loc := range r.re.FindAllStringSubmatchIndex(line, -1) {
					if len(loc) < 2 {
						continue
					}
					idx := loc[0]
					if inComment(line, idx) {
						continue
					}
					if r.valueGroup > 0 {
						gi := 2 * r.valueGroup
						if gi+1 < len(loc) && loc[gi] >= 0 {
							if placeholderValue(line[loc[gi]:loc[gi+1]]) {
								continue
							}
						}
					}
					key := r.id + "|" + path + "|" + itoa(ln)
					if seen[key] {
						continue
					}
					seen[key] = true
					rep.Findings = append(rep.Findings, Finding{
						ID: r.id, Severity: r.severity, Category: r.category,
						File: path, Line: ln + 1, Message: r.message,
						Snippet: snippetOf(line), Rule: r.id,
					})
				}
			}
		}
		for _, r := range secretRules {
			check(r)
		}
		for _, r := range codeRules {
			check(r)
		}
	}
	finalize(&rep)
	return rep
}

// finalize mengurutkan temuan (kritis dulu, lalu file/baris), menghitung
// ringkasan, dan menetapkan verdict. Dipakai juga setelah temuan policy
// ditambahkan.
func finalize(rep *Report) {
	sevRank := map[Severity]int{SeverityCritical: 0, SeverityHigh: 1, SeverityMedium: 2, SeverityLow: 3}
	sort.SliceStable(rep.Findings, func(i, j int) bool {
		if sevRank[rep.Findings[i].Severity] != sevRank[rep.Findings[j].Severity] {
			return sevRank[rep.Findings[i].Severity] < sevRank[rep.Findings[j].Severity]
		}
		if rep.Findings[i].File != rep.Findings[j].File {
			return rep.Findings[i].File < rep.Findings[j].File
		}
		return rep.Findings[i].Line < rep.Findings[j].Line
	})
	if len(rep.Findings) > MaxFindings {
		rep.Findings = rep.Findings[:MaxFindings]
	}
	rep.Summary = Summary{}
	for _, f := range rep.Findings {
		rep.Summary.Total++
		switch f.Severity {
		case SeverityCritical:
			rep.Summary.Critical++
		case SeverityHigh:
			rep.Summary.High++
		case SeverityMedium:
			rep.Summary.Medium++
		case SeverityLow:
			rep.Summary.Low++
		}
	}
	rep.Blocked = rep.Summary.Critical > 0
	rep.Passed = !rep.Blocked
}

// PolicyRow adalah satu baris app_policies proyek (table/role/operation/enabled).
type PolicyRow struct {
	Table     string
	Role      string
	Operation string
	Enabled   bool
}

// Tabel sensitif: isinya kredensial/sesi — role rendah tidak boleh baca.
var sensitiveTables = map[string]bool{
	"app_users": true, "app_sessions": true, "app_policies": true,
}

// CheckPolicies menilai baris policy eksplisit. Default platform adalah
// deny-by-default (lihat handler.requireAppOperation), jadi tidak adanya
// baris policy BUKAN temuan — hanya baris yang secara eksplisit membuka
// akses berbahaya yang dilaporkan.
func CheckPolicies(rows []PolicyRow) []Finding {
	var out []Finding
	for _, r := range rows {
		if !r.Enabled {
			continue
		}
		table, role, op := strings.ToLower(r.Table), strings.ToLower(r.Role), strings.ToLower(r.Operation)
		lowRole := role == "member" || role == "viewer"
		switch {
		case sensitiveTables[table] && op == "select" && lowRole:
			out = append(out, Finding{
				ID: "policy-sensitive-table-read", Severity: SeverityCritical, Category: CategoryPolicy,
				File: "app_policies", Message: "Policy mengizinkan role '" + role + "' membaca tabel sensitif '" + table + "' (berisi password hash / token sesi). Cabut akses baca tabel ini untuk role rendah.",
				Rule: "policy-sensitive-table-read",
			})
		case op == "query" && lowRole:
			out = append(out, Finding{
				ID: "policy-raw-query-low-role", Severity: SeverityCritical, Category: CategoryPolicy,
				File: "app_policies", Message: "Policy mengizinkan role '" + role + "' memakai endpoint query SQL mentah (operasi 'query') — role rendah bisa menjalankan SQL arbitrer di schema proyek.",
				Rule: "policy-raw-query-low-role",
			})
		case op == "delete" && lowRole:
			out = append(out, Finding{
				ID: "policy-delete-low-role", Severity: SeverityHigh, Category: CategoryPolicy,
				File: "app_policies", Message: "Policy mengizinkan role '" + role + "' menghapus baris di tabel '" + table + "'.",
				Rule: "policy-delete-low-role",
			})
		case op == "insert" && role == "viewer":
			out = append(out, Finding{
				ID: "policy-viewer-write", Severity: SeverityHigh, Category: CategoryPolicy,
				File: "app_policies", Message: "Policy mengizinkan role 'viewer' menulis (insert) ke tabel '" + table + "' — viewer seharusnya read-only.",
				Rule: "policy-viewer-write",
			})
		case op == "update" && role == "viewer":
			out = append(out, Finding{
				ID: "policy-viewer-write", Severity: SeverityHigh, Category: CategoryPolicy,
				File: "app_policies", Message: "Policy mengizinkan role 'viewer' mengubah (update) tabel '" + table + "' — viewer seharusnya read-only.",
				Rule: "policy-viewer-write",
			})
		}
	}
	return out
}

// AddPolicyFindings menggabungkan temuan policy ke laporan dan menghitung
// ulang verdict.
func AddPolicyFindings(rep *Report, rows []PolicyRow) {
	rep.PolicyRows = len(rows)
	rep.Findings = append(rep.Findings, CheckPolicies(rows)...)
	finalize(rep)
}

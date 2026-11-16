package handler

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"gorm.io/gorm"
	"webbuilder/internal/browser"
	"webbuilder/internal/database/models"
	tenantRuntime "webbuilder/internal/runtime"
)

// Runtime step 1: a per-project Node workspace for install/build verification.
// It is deliberately allowlisted and bounded; it is not a general host shell.
var runtimeDev = struct {
	sync.Mutex
	items map[uint]*exec.Cmd
	ports map[uint]int
}{items: map[uint]*exec.Cmd{}, ports: map[uint]int{}}

type runtimePreviewGrant struct {
	ProjectID uint
	UserID    uint
	ExpiresAt time.Time
}

var runtimePreviewSessions = struct {
	sync.Mutex
	items map[string]runtimePreviewGrant
}{items: map[string]runtimePreviewGrant{}}

func issueRuntimePreviewToken(projectID, userID uint) string {
	// Signed token survives WebBuilder restarts; it is still scoped and short-lived.
	// Preview token berlaku lama agar link tidak rusak saat user berpindah tab,
	// restart browser, atau melanjutkan pekerjaan beberapa hari kemudian.
	exp := time.Now().Add(30 * 24 * time.Hour)
	claims := jwt.MapClaims{"typ": "runtime_preview", "pid": projectID, "uid": userID, "exp": exp.Unix()}
	t := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := t.SignedString(jwtSecret())
	if err != nil {
		return ""
	}
	return "pv_" + signed
}

func getRuntimePreviewGrant(token string) (runtimePreviewGrant, bool) {
	if !strings.HasPrefix(token, "pv_") {
		return runtimePreviewGrant{}, false
	}
	raw := strings.TrimPrefix(token, "pv_")
	t, err := jwt.Parse(raw, func(t *jwt.Token) (interface{}, error) {
		if t.Method != jwt.SigningMethodHS256 {
			return nil, errors.New("invalid preview signing method")
		}
		return jwtSecret(), nil
	})
	if err != nil || !t.Valid {
		return runtimePreviewGrant{}, false
	}
	claims, ok := t.Claims.(jwt.MapClaims)
	if !ok || claims["typ"] != "runtime_preview" {
		return runtimePreviewGrant{}, false
	}
	pid, pok := claims["pid"].(float64)
	uid, uok := claims["uid"].(float64)
	if !pok || !uok || pid < 1 || uid < 1 {
		return runtimePreviewGrant{}, false
	}
	return runtimePreviewGrant{ProjectID: uint(pid), UserID: uint(uid), ExpiresAt: time.Now().Add(24 * time.Hour)}, true
}

func projectRuntimeRoot(pid uint) string {
	return filepath.Join("..", "runtime", fmt.Sprintf("project-%d", pid))
}

// serverPort adalah port listen server WebBuilder (env PORT, default
// 18082 — sama seperti server/main.go). Dipakai target proxy /api di
// vite.config hasil scaffold supaya preview proyek jalan saat server
// berjalan di port lain (bukan hardcode 18082).
func serverPort() string {
	if port := strings.TrimSpace(os.Getenv("PORT")); port != "" {
		return port
	}
	return "18082"
}

// apiBaseURL adalah base URL API WebBuilder yang dipakai proyek hasil
// generate (VITE_API_BASE_URL di .env.example). Diturunkan dari port
// listen server yang sebenarnya (env PORT, default 18082 — sama seperti
// server/main.go), bukan hardcode, supaya benar saat server jalan di
// port lain (mis. 18086 di server uji) maupun di produksi.
func apiBaseURL() string {
	return "http://localhost:" + serverPort()
}

var viteServerRe = regexp.MustCompile(`server\s*:\s*\{`)
var viteProxyRe = regexp.MustCompile(`proxy\s*:\s*\{`)
var viteDefineConfigRe = regexp.MustCompile(`defineConfig\(\s*\{`)
var viteAPIEntryRe = regexp.MustCompile(`"/api"\s*:\s*\{[^}]*\}`)

// viteAPIProxyEntry adalah entri proxy "/api" dev server Vite ke server
// WebBuilder, DENGAN bypass untuk prefix preview Live Runtime.
//
// Tanpa bypass, permintaan dokumen preview (path
// /api/projects/<id>/runtime/preview/...) yang diteruskan proxy preview
// Go ke Vite langsung dipantulkan BALIK oleh Vite ke server Go —
// karena path-nya berawalan /api dan entri proxy ini mencocokkannya —
// TANPA token preview (token sudah di-strip Director proxy Go).
// Server Go lalu menolak pantulan itu 401 "Sesi berakhir", Vite
// mengembalikan 401 itu sebagai jawaban dokumen, dan iframe preview
// kosong walau token preview-nya valid. Bypass membuat Vite melayani
// sendiri semua request di bawah prefix preview (dokumen + aset hasil
// transform), sementara panggilan /api milik aplikasi hasil generate
// (cloudDb/cloudAuth) tetap di-proxy ke Go seperti biasa.
//
// HATI-HATI SEMANTIK BYPASS VITE 5 (terbukti dari source Vite 5.4.21 di
// node_modules, proxyMiddleware): bypass yang mengembalikan STRING
// menulis ulang req.url lalu memanggil next() — request dilayani Vite
// sendiri; bypass yang mengembalikan FALSE justru dijawab Vite dengan
// 404 KOSONG (bukan dilayani sendiri). Karena itu bypass di sini
// mengembalikan req.url apa adanya (prefix base tetap utuh, supaya
// transform middleware Vite yang mengharapkan base tidak 404), bukan
// false.
func viteAPIProxyEntry(port, previewPrefix string) string {
	target := `"http://127.0.0.1:` + port + `"`
	return `"/api": { target: ` + target + `, changeOrigin: true, bypass: (req) => (req.url || "").startsWith("` + previewPrefix + `") ? req.url : undefined }`
}

// viteDevProxyEntries adalah entri proxy dev server Vite ke server
// WebBuilder: "/api" untuk cloudDb/cloudAuth, "/app-files" untuk file
// upload (gambar dsb.) yang disajikan rute publik API. Target mengikuti
// port listen server (bukan hardcode), sama seperti proxy /api yang
// sudah ada sebelumnya.
func viteDevProxyEntries(port, previewPrefix string) []string {
	target := `"http://127.0.0.1:` + port + `"`
	return []string{
		viteAPIProxyEntry(port, previewPrefix),
		`"/app-files": { target: ` + target + `, changeOrigin: true }`,
	}
}

// ensureViteDevProxy memastikan vite.config.ts hasil generate mem-proxy
// "/api" dan "/app-files" ke server WebBuilder.
//
// Tanpa proxy, aplikasi yang dibuka di port Vite dev memanggil /api dan
// /app-files relatif ke dirinya sendiri: /api menerima 404
// (cloudDb/cloudAuth gagal total), dan /app-files dijawab SPA-fallback
// HTML (HTTP 200 text/html) sehingga <img> tampil rusak di screenshot
// verifikasi MCP — padahal lewat origin API URL yang sama mengembalikan
// 200 image/png. Jalur verifikasi browser memang membuka Vite dev
// langsung (bukan lewat proxy preview API), jadi proxy inilah lapisan
// yang benar; penyajian lewat origin API tidak diubah.
//
// Patch hanya diterapkan di workspace runtime (file proyek di DB tidak
// diubah) dan idempotent: entri yang sudah ada tidak diduplikasi. Bila
// objek proxy sudah ada (mis. hanya "/api"), entri yang kurang disisipkan
// ke DALAM objek itu — menambah kunci "proxy:" kedua akan menimpa yang
// pertama (di object literal JS kunci terakhir menang) dan "/api" hilang.
//
// previewPrefix adalah prefix proxy preview proyek ini
// (/api/projects/<id>/runtime/preview). Entri "/api" yang sudah ada
// TANPA bypass — atau dengan bypass lama yang mengembalikan false
// (di Vite 5 dijawab 404 kosong) — diganti dengan entri baru yang
// memuat bypass benar (lihat viteAPIProxyEntry): tanpa bypass, Vite
// memantulkan permintaan preview balik ke server Go tanpa token dan
// preview 401.
func ensureViteDevProxy(s, port, previewPrefix string) string {
	missing := []string{}
	for _, e := range viteDevProxyEntries(port, previewPrefix) {
		name := strings.SplitN(e, ":", 2)[0]
		if !strings.Contains(s, name) {
			missing = append(missing, e)
		}
	}
	if len(missing) > 0 {
		joined := strings.Join(missing, ", ")
		if loc := viteProxyRe.FindStringIndex(s); loc != nil {
			s = s[:loc[1]] + " " + joined + "," + s[loc[1]:]
		} else if loc := viteServerRe.FindStringIndex(s); loc != nil {
			s = s[:loc[1]] + " proxy: { " + joined + " }, " + s[loc[1]:]
		} else if loc := viteDefineConfigRe.FindStringIndex(s); loc != nil {
			s = s[:loc[1]] + "\n  server: { proxy: { " + joined + " } }," + s[loc[1]:]
		}
	}
	// Entri "/api" lama (tanpa bypass, atau bypass lama yang mengembalikan
	// false — di Vite 5 itu dijawab 404 kosong, bukan dilayani sendiri):
	// ganti dengan entri baru (target port terbaru + bypass prefix
	// preview). Deteksi memakai entri segar persis, bukan sekadar
	// keberadaan previewPrefix, supaya bypass lama ikut diperbarui.
	if previewPrefix != "" {
		if fresh := viteAPIProxyEntry(port, previewPrefix); !strings.Contains(s, fresh) {
			if loc := viteAPIEntryRe.FindStringIndex(s); loc != nil {
				s = s[:loc[0]] + fresh + s[loc[1]:]
			}
		}
	}
	return s
}

func envSafeValue(value string) string {
	value = strings.TrimSpace(value)
	value = strings.NewReplacer("\n", " ", "\r", " ", "=", "-", "#", "").Replace(value)
	if value == "" { return "WebBuilder App" }
	return value
}

// majorOf mengekstrak major version dari spec npm ("^5.4.10" -> 5, "latest" -> 0).
func majorOf(spec string) int {
	digits := ""
	for _, r := range strings.TrimLeft(spec, "^~>=< v") {
		if r >= '0' && r <= '9' {
			digits += string(r)
			continue
		}
		break
	}
	if digits == "" {
		return 0
	}
	n, _ := strconv.Atoi(digits)
	return n
}

func runtimeRun(ctx context.Context, dir string, command string, args ...string) (string, int, error) {
	// Migrasi isolasi: flag WEBBUILDER_ENABLE_TENANT_EXEC=1 -> perintah
	// tenant satu-shot lewat adapter isolasi (lihat runtimeexec.go);
	// flag mati -> jalur lama di bawah ini, persis seperti sebelum migrasi.
	if tenantRuntime.Enabled() {
		return runtimeRunIsolated(ctx, dir, command, args...)
	}
	cmd := exec.CommandContext(ctx, command, args...)
	cmd.Dir = dir
	// legacy_peer_deps: proyek hasil AI sering mencampur vite major & plugin
	// peer-nya; tanpa ini `npm install` gagal ERESOLVE dan build tak pernah jalan.
	cmd.Env = append(os.Environ(), "CI=1", "npm_config_fund=false", "npm_config_audit=false", "npm_config_legacy_peer_deps=true")
	out, err := cmd.CombinedOutput()
	code := 0
	if cmd.ProcessState != nil {
		code = cmd.ProcessState.ExitCode()
	}
	return string(out), code, err
}

func runtimeToolchain(dir string) (string, []string, []string) {
	if _, err := os.Stat(filepath.Join(dir, "pnpm-workspace.yaml")); err == nil {
		return "pnpm", []string{"install", "--ignore-scripts", "--no-frozen-lockfile"}, []string{"--filter", "web", "run", "build"}
	}
	if _, err := os.Stat(filepath.Join(dir, "pnpm-lock.yaml")); err == nil {
		return "pnpm", []string{"install", "--ignore-scripts", "--no-frozen-lockfile"}, []string{"run", "build"}
	}
	if _, err := os.Stat(filepath.Join(dir, "requirements.txt")); err == nil {
		return "python3", []string{"-m", "pip", "install", "-r", "requirements.txt"}, []string{"-m", "uvicorn", "main:app", "--host", "0.0.0.0"}
	}
	if _, err := os.Stat(filepath.Join(dir, "manage.py")); err == nil {
		return "python3", []string{"-m", "pip", "install", "-r", "requirements.txt"}, []string{"manage.py", "runserver", "0.0.0.0:3000"}
	}
	if _, err := os.Stat(filepath.Join(dir, "artisan")); err == nil {
		return "composer", []string{"install", "--no-interaction", "--no-progress"}, []string{"install"}
	}
	return "npm", []string{"install", "--ignore-scripts", "--no-audit", "--no-fund"}, []string{"run", "build"}
}

// normalizeViteConfig menerapkan SEMUA patch workspace-runtime pada
// vite.config.ts: allowedHosts + proxy dev (ensureViteDevProxy).
// Dipakai di dua tempat (loop file DB dan blok vite.config.ts di bawah)
// supaya keduanya menghitung isi "yang diinginkan" yang SAMA — bila
// hanya satu tempat yang menormalisasi, sync() berulang menulis ulang
// file (sekali tanpa allowedHosts, sekali dengan) dan Vite restart
// tanpa ada perubahan, membuat request iframe gagal 502.
func normalizeViteConfig(s, port, previewPrefix string) string {
	if !strings.Contains(s, "allowedHosts") {
		if strings.Contains(s, "server: {") {
			s = strings.Replace(s, "server: {", "server: { allowedHosts: true,", 1)
		} else {
			s = strings.Replace(s, "defineConfig({", "defineConfig({\n  server: { allowedHosts: true },", 1)
		}
	}
	return ensureViteDevProxy(s, port, previewPrefix)
}

// writeFileIfChanged menulis file hanya bila isinya berbeda (atau file
// belum ada). prepareRuntimeWorkspace dipanggil setiap sync() — tanpa
// ini, sync() kedua dan seterusnya menulis ulang vite.config.ts dan
// .env.local dengan isi YANG SAMA, dan Vite me-restart dev server pada
// setiap penulisan itu. Restart yang datang sesudah poll preview
// mendapat 200 (tetapi sebelum iframe selesai memuat) membuat request
// iframe gagal 502 "preview runtime tidak tersedia" dan preview tetap
// kosong. Dengan helper ini, sync() tanpa perubahan adalah no-op dan
// Vite tidak restart.
func writeFileIfChanged(path string, content []byte, perm os.FileMode) error {
	if existing, err := os.ReadFile(path); err == nil && bytes.Equal(existing, content) {
		return nil
	}
	return os.WriteFile(path, content, perm)
}

func runtimePnpmWebFilter(dir string) string {
	content, err := os.ReadFile(filepath.Join(dir, "apps", "web", "package.json"))
	if err == nil {
		var pkg struct{ Name string `json:"name"` }
		if json.Unmarshal(content, &pkg) == nil && strings.TrimSpace(pkg.Name) != "" { return pkg.Name }
	}
	return "web"
}

// runtimePreviewBasePath adalah prefix URL proxy preview Live Runtime
// untuk satu proyek. Dipakai sebagai --base dev server Vite (supaya semua
// URL modul hasil transform Vite berada di bawah prefix proxy — tanpa ini
// import absolut /src/... dan /node_modules/... lolos dari proxy, dijawab
// SPA-fallback HTML oleh server WebBuilder, dan aplikasi tidak pernah
// dirender) dan sebagai prefix rewrite di runtimeDevPreview.
func runtimePreviewBasePath(pid uint) string {
	return fmt.Sprintf("/api/projects/%d/runtime/preview", pid)
}

func runtimeDevCommand(dir string, port int, projectID uint) (string, []string) {
	command, _, _ := runtimeToolchain(dir)
	// Dev server Vite: --base mengunci semua URL aset/modul di bawah
	// prefix proxy preview. HANYA untuk dev server — `npm run build`
	// (verifikasi/publish) tidak memakai flag ini sehingga hasil build
	// production tetap ber-base "/" seperti semula.
	baseArgs := []string{"--base", runtimePreviewBasePath(projectID) + "/"}
	if command == "pnpm" {
		filter := runtimePnpmWebFilter(dir)
		args := []string{"--filter", filter, "dev", "--host", "127.0.0.1", "--port", fmt.Sprint(port)}
		args = append(args, baseArgs...)
		if _, err := exec.LookPath("pnpm"); err == nil { return "pnpm", args }
		return "npx", append([]string{"--yes", "pnpm@9.15.0"}, args...)
	}
	if command == "python3" {
		return "python3", []string{"-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", fmt.Sprint(port)}
	}
	if command == "composer" {
		return "php", []string{"artisan", "serve", "--host", "127.0.0.1", "--port", fmt.Sprint(port)}
	}
	args := []string{"run", "dev", "--", "--host", "127.0.0.1", "--port", fmt.Sprint(port)}
	args = append(args, baseArgs...)
	return "npm", args
}

func runtimeWaitReady(port int, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 500*time.Millisecond)
		if err == nil { _ = conn.Close(); return true }
		time.Sleep(250 * time.Millisecond)
	}
	return false
}

func runtimeStatus(c *gin.Context, status string, output string, code int, err error) {
	c.JSON(200, gin.H{"status": status, "output": output, "exitCode": code, "error": errorString(err)})
}

func errorString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func runtimeProject(db *gorm.DB, c *gin.Context) (*models.Project, bool) {
	p, role := canAccessProject(db, c.Param("id"), c.GetUint("userID"))
	if p == nil || role == "" || role == "viewer" {
		c.JSON(403, gin.H{"error": "Project runtime membutuhkan akses editor"})
		return nil, false
	}
	return p, true
}

// normalizeSolutionTsconfigs memperbaiki tsconfig solution-style hasil
// model supaya `tsc -b` — script build template Vite
// ("tsc -b && vite build") — lolos.
//
// Akar masalah (reproduksi: proyek uji "Uji Fix B 15 Nov", TS 7.0.2):
// `tsc -b` mengompilasi tiap proyek yang direferensikan dengan opsinya
// SENDIRI; compilerOptions tsconfig.json root TIDAK diwariskan. Model
// sering menghasilkan dua varian yang pecah:
//
//  1. tsconfig.node.json TANPA "include"/"files". Tanpa itu tsc memakai
//     include default (semua file .ts/.tsx di bawah root), jadi proyek
//     node ikut mengompilasi src/*.tsx — tanpa flag jsx — dan gagal
//     `error TS17004: Cannot use JSX unless the '--jsx' flag is
//     provided` di setiap elemen JSX. Template Vite selalu membatasi
//     proyek node ke ["vite.config.ts"]; normalisasi ini mengembalikan
//     batas itu.
//  2. tsconfig.app.json TANPA "jsx" (model hanya menulis jsx di root).
//     Proyek app mengompilasi src/ tanpa jsx -> TS17004 yang sama.
//     Diisi "react-jsx" bila kuncinya memang tidak ada.
//
// Hanya kunci yang HILANG yang ditambahkan; nilai yang sudah ditulis
// model tidak pernah ditimpa. Config yang tidak bisa dibaca, referensi
// yang menunjuk ke luar workspace, dan bentuk di luar dua varian di atas
// dibiarkan apa adanya supaya tsc sendiri yang melaporkannya.
//
// BUKAN regresi TypeScript 7: bentuk yang sama gagal identik (12x
// TS17004) di TypeScript 5.9.3, jadi pin versi TS tidak memperbaikinya;
// dan perintah build-nya sudah benar untuk proyek solution-style, jadi
// bukan build script yang diubah.
func normalizeSolutionTsconfigs(dir string) {
	rootRaw, err := os.ReadFile(filepath.Join(dir, "tsconfig.json"))
	if err != nil {
		return
	}
	var root map[string]interface{}
	if err := json.Unmarshal(rootRaw, &root); err != nil {
		return
	}
	refs, _ := root["references"].([]interface{})
	if len(refs) == 0 {
		return
	}
	for _, ref := range refs {
		refMap, _ := ref.(map[string]interface{})
		rel, _ := refMap["path"].(string)
		if strings.TrimSpace(rel) == "" {
			continue
		}
		cfgPath := filepath.Join(dir, filepath.FromSlash(rel))
		// Referensi tidak boleh lolos dari workspace proyek.
		if rel2, err := filepath.Rel(dir, cfgPath); err != nil || rel2 == ".." || strings.HasPrefix(rel2, ".."+string(os.PathSeparator)) {
			continue
		}
		raw, err := os.ReadFile(cfgPath)
		if err != nil {
			continue
		}
		var cfg map[string]interface{}
		if err := json.Unmarshal(raw, &cfg); err != nil {
			continue
		}
		base := strings.ToLower(filepath.Base(cfgPath))
		changed := false
		// (1) Proyek tooling/node tanpa include/files: batasi ke vite.config.ts.
		if strings.Contains(base, "node") {
			if _, ok := cfg["include"]; !ok {
				if _, ok := cfg["files"]; !ok {
					cfg["include"] = []string{"vite.config.ts"}
					changed = true
				}
			}
		}
		// (2) Proyek app tanpa jsx: isi react-jsx (template Vite).
		// Dikenali dari namanya atau dari include yang menyentuh src/.
		isApp := strings.Contains(base, "app")
		if !isApp {
			if inc, ok := cfg["include"].([]interface{}); ok {
				for _, v := range inc {
					if s, ok := v.(string); ok && strings.Contains(s, "src") {
						isApp = true
						break
					}
				}
			}
		}
		if isApp {
			opts, _ := cfg["compilerOptions"].(map[string]interface{})
			if opts == nil {
				opts = map[string]interface{}{}
				cfg["compilerOptions"] = opts
			}
			if _, ok := opts["jsx"]; !ok {
				opts["jsx"] = "react-jsx"
				changed = true
			}
		}
		if !changed {
			continue
		}
		if encoded, err := json.MarshalIndent(cfg, "", "  "); err == nil {
			_ = os.WriteFile(cfgPath, encoded, 0644)
		}
	}
}

func prepareRuntimeWorkspace(p *models.Project) (string, error) {
	dir := projectRuntimeRoot(p.ID)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", err
	}
	var files map[string]string
	if err := json.Unmarshal([]byte(p.Files), &files); err != nil {
		return "", err
	}
	// Runtime selalu melengkapi file operasional yang aman. Secret hanya boleh
	// diisi user lewat .env.local; .env.example tidak pernah berisi credential.
	if _, exists := files[".env.example"]; !exists {
		files[".env.example"] = "VITE_API_BASE_URL=" + apiBaseURL() + "\nVITE_APP_NAME=WebBuilder App\n# Isi secret hanya di .env.local, jangan commit credential.\n"
	}
	if _, exists := files["README.md"]; !exists {
		files["README.md"] = fmt.Sprintf(`# %s

Project generated with WebBuilder.

## Menjalankan lokal

    npm install
    npm run dev

## Build production

    npm run build

## Struktur utama

- public/: aset statis
- src/components/: komponen reusable
- src/pages/: halaman aplikasi
- src/services/: integrasi API/database
- src/hooks/: custom hooks
- src/utils/: helper
- src/App.tsx: root component
- src/main.tsx: entry point

Environment variable lokal disimpan di file .env.local; jangan commit secret atau API key.
`, p.Name)
	}
	// Every generated runtime includes a usable README, even when the AI
	// response omitted documentation. Keep it in the project workspace so
	// npm install/dev/export flows have the same documented contract.
	if _, exists := files["README.md"]; !exists {
		files["README.md"] = fmt.Sprintf(`# %s

Project generated with WebBuilder.

## Menjalankan lokal

    npm install
    npm run dev

## Build production

    npm run build

## Struktur utama

- public/: aset statis
- src/components/: komponen reusable
- src/pages/: halaman aplikasi
- src/services/: integrasi API/database
- src/hooks/: custom hooks
- src/utils/: helper
- src/App.tsx: root component
- src/main.tsx: entry point

Environment variable lokal disimpan di file .env.local; jangan commit secret atau API key.
`, p.Name)
	}
	// .env.local adalah environment aktif untuk runtime preview. File ini hanya
	// dibuat di workspace runtime, tidak disimpan ke database/file tree, dan
	// tidak pernah berisi credential. Vite membaca nilai ini saat dev server
	// dimulai sehingga preview memakai konfigurasi project yang nyata.
	activeEnv := fmt.Sprintf("VITE_APP_NAME=%s\nVITE_API_BASE_URL=\nVITE_PROJECT_ID=%d\nVITE_RUNTIME=preview\n", envSafeValue(p.Name), p.ID)
	if err := writeFileIfChanged(filepath.Join(dir, ".env.local"), []byte(activeEnv), 0600); err != nil {
		return "", err
	}
	for name, content := range files {
		clean := filepath.Clean(name)
		if clean == "." || filepath.IsAbs(clean) || strings.HasPrefix(clean, ".."+string(os.PathSeparator)) || clean == ".." {
			continue
		}
		target := filepath.Join(dir, clean)
		if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
			return "", err
		}
		// vite.config.ts: salinan workspace selalu membawa patch
		// normalisasi (normalizeViteConfig) yang tidak ada di file DB.
		// Bandingkan dengan versi TER-NORMALISASI — bukan isi DB mentah
		// — supaya sync() berulang tidak menulis ulang dan me-restart
		// Vite tanpa ada perubahan (restart itu membuat request iframe
		// gagal 502).
		desired := content
		if clean == "vite.config.ts" {
			desired = normalizeViteConfig(content, serverPort(), runtimePreviewBasePath(p.ID))
		}
		if err := writeFileIfChanged(target, []byte(desired), 0644); err != nil {
			return "", err
		}
	}
	pkg := filepath.Join(dir, "package.json")
	if _, err := os.Stat(pkg); os.IsNotExist(err) {
		content := `{"name":"webbuilder-project","private":true,"version":"0.0.0","type":"module","scripts":{"dev":"vite","build":"vite build"},"dependencies":{"@vitejs/plugin-react":"latest","vite":"latest","typescript":"latest","react":"latest","react-dom":"latest","@types/react":"latest","@types/react-dom":"latest","tailwindcss":"3.4.17","postcss":"8.4.49","autoprefixer":"10.4.20"},"devDependencies":{}}`
		if err := os.WriteFile(pkg, []byte(content), 0644); err != nil {
			return "", err
		}
	} else {
		// Ensure every generated Vite project has a startable dev script.
		var manifest map[string]interface{}
		if raw, readErr := os.ReadFile(pkg); readErr == nil && json.Unmarshal(raw, &manifest) == nil {
			scripts, _ := manifest["scripts"].(map[string]interface{})
			if scripts == nil {
				scripts = map[string]interface{}{}
			}
			if _, exists := scripts["dev"]; !exists {
				scripts["dev"] = "vite"
			}
			if _, exists := scripts["build"]; !exists {
				scripts["build"] = "vite build"
			}
			manifest["scripts"] = scripts
			// TypeScript React projects need JSX declarations in a clean workspace.
			deps, _ := manifest["dependencies"].(map[string]interface{})
			if deps == nil {
				deps = map[string]interface{}{}
			}
			if _, exists := deps["@types/react"]; !exists {
				deps["@types/react"] = "latest"
			}
			if _, exists := deps["@types/react-dom"]; !exists {
				deps["@types/react-dom"] = "latest"
			}
			if _, exists := deps["tailwindcss"]; !exists {
				deps["tailwindcss"] = "3.4.17"
			}
			if _, exists := deps["postcss"]; !exists {
				deps["postcss"] = "8.4.49"
			}
			if _, exists := deps["autoprefixer"]; !exists {
				deps["autoprefixer"] = "10.4.20"
			}
			// Script build memanggil `vite build`, tetapi package.json hasil
			// model sering tidak memuat vite/react/react-dom sama sekali.
			// Tanpa ketiganya install lolos lalu build gagal `vite: not
			// found` (exit 127). Tambahkan bila tidak ada di dependencies
			// MAUPUN devDependencies; versi yang sudah ada (di mana pun)
			// dihormati dan tidak diduplikasi. Sama seperti scaffold saat
			// package.json belum ada: ketiganya "latest".
			for _, name := range []string{"vite", "react", "react-dom"} {
				if _, exists := deps[name]; exists {
					continue
				}
				if devDeps, ok := manifest["devDependencies"].(map[string]interface{}); ok {
					if _, exists := devDeps[name]; exists {
						continue
					}
				}
				deps[name] = "latest"
			}
			// Tselaraskan plugin React dengan major vite yang ditulis model.
			// plugin-react@6 butuh vite>=8 dan mengimpor "vite/internal" yang
			// TIDAK ada di vite 5 → build gagal ERR_PACKAGE_PATH_NOT_EXPORTED.
			viteSpec, _ := deps["vite"].(string)
			if viteSpec == "" {
				if devDeps, ok := manifest["devDependencies"].(map[string]interface{}); ok {
					viteSpec, _ = devDeps["vite"].(string)
				}
			}
			if majorOf(viteSpec) > 0 && majorOf(viteSpec) <= 5 {
				deps["@vitejs/plugin-react"] = "^4.3.4"
			} else {
				deps["@vitejs/plugin-react"] = "latest"
			}
			// Script build hasil AI sering memanggil `tsc`; pastikan ada.
			if _, exists := deps["typescript"]; !exists {
				deps["typescript"] = "latest"
			}
			manifest["dependencies"] = deps
			if encoded, marshalErr := json.MarshalIndent(manifest, "", "  "); marshalErr == nil {
				_ = writeFileIfChanged(pkg, encoded, 0644)
			}
		}
	}
	// Ensure generated TypeScript/Vite projects are buildable even when the model
	// omitted toolchain files. These files are deterministic scaffolding, not app logic.
	tsconfigPath := filepath.Join(dir, "tsconfig.json")
	if _, err := os.Stat(tsconfigPath); os.IsNotExist(err) {
		content := `{"compilerOptions":{"target":"ES2021","useDefineForClassFields":true,"lib":["ES2021","DOM","DOM.Iterable"],"allowJs":false,"skipLibCheck":true,"esModuleInterop":true,"allowSyntheticDefaultImports":true,"strict":true,"forceConsistentCasingInFileNames":true,"module":"ESNext","moduleResolution":"Bundler","resolveJsonModule":true,"isolatedModules":true,"noEmit":true,"jsx":"react-jsx"},"include":["src"]}`
		if err := os.WriteFile(tsconfigPath, []byte(content), 0644); err != nil {
			return "", err
		}
	} else if raw, readErr := os.ReadFile(tsconfigPath); readErr == nil {
		// Older generated projects commonly use ES2020, which breaks modern
		// APIs such as String.replaceAll. Normalize only the compiler target/lib.
		fixed := strings.ReplaceAll(string(raw), `"ES2020"`, `"ES2021"`)
		if fixed != string(raw) {
			if err := os.WriteFile(tsconfigPath, []byte(fixed), 0644); err != nil {
				return "", err
			}
		}
	} else if !os.IsNotExist(readErr) {
		return "", readErr
	}
	// Proyek solution-style hasil model (tsconfig.json berisi
	// "references") sering gagal `tsc -b` — lihat
	// normalizeSolutionTsconfigs. Best-effort: kesalahan yang tersisa
	// tetap dilaporkan tsc sendiri saat build.
	normalizeSolutionTsconfigs(dir)
	viteCfg := filepath.Join(dir, "vite.config.ts")
	if _, err := os.Stat(viteCfg); os.IsNotExist(err) {
		content := `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({ plugins: [react()], server: { allowedHosts: true, proxy: { ` + viteAPIProxyEntry(serverPort(), runtimePreviewBasePath(p.ID)) + `, "/app-files": { target: "http://127.0.0.1:` + serverPort() + `", changeOrigin: true } } } });
`
		if err := os.WriteFile(viteCfg, []byte(content), 0644); err != nil {
			return "", err
		}
	} else if b, err := os.ReadFile(viteCfg); err == nil {
		// Dev server harus bisa memanggil backend WebBuilder. Tanpa proxy,
		// aplikasi yang dibuka di port Vite memanggil /api dan /app-files
		// relatif ke dirinya sendiri: /api menerima 404 (cloudDb/cloudAuth
		// gagal total), dan /app-files dijawab SPA-fallback HTML sehingga
		// <img> tampil rusak di screenshot verifikasi MCP (lihat
		// ensureViteDevProxy). Patch hanya di workspace runtime.
		s := string(b)
		orig := s
		s = normalizeViteConfig(s, serverPort(), runtimePreviewBasePath(p.ID))
		if s != orig {
			os.WriteFile(viteCfg, []byte(s), 0644)
		}
	}
	// .npmrc: samakan perilaku npm di dalam workspace (dev server yang dijalankan
	// npm juga mewarisi ini). Tanpa legacy-peer-deps, konflik peer vite/plugin
	// hasil AI membuat install & build gagal permanen.
	npmrc := filepath.Join(dir, ".npmrc")
	if _, err := os.Stat(npmrc); os.IsNotExist(err) {
		_ = os.WriteFile(npmrc, []byte("legacy-peer-deps=true\nfund=false\naudit=false\n"), 0644)
	}
	viteEnv := filepath.Join(dir, "src", "vite-env.d.ts")
	if _, err := os.Stat(viteEnv); os.IsNotExist(err) {
		if err := os.MkdirAll(filepath.Dir(viteEnv), 0755); err != nil {
			return "", err
		}
		content := `/// <reference types="vite/client" />
`
		if err := os.WriteFile(viteEnv, []byte(content), 0644); err != nil {
			return "", err
		}
	}
	// Keep Tailwind utility classes functional in generated projects that use them.
	configs := map[string]string{
		"tailwind.config.js": `/** @type {import('tailwindcss').Config} */
export default { content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"], theme: { extend: {} }, plugins: [] };
`,
		"postcss.config.js": `export default { plugins: { tailwindcss: {}, autoprefixer: {} } };
`,
	}
	for name, content := range configs {
		path := filepath.Join(dir, name)
		if _, err := os.Stat(path); os.IsNotExist(err) {
			if err := os.WriteFile(path, []byte(content), 0644); err != nil {
				return "", err
			}
		} else if name == "postcss.config.js" {
			// Repair legacy configs that only enabled autoprefixer; otherwise
			// @tailwind directives remain literal text in the production CSS.
			if raw, readErr := os.ReadFile(path); readErr == nil && !strings.Contains(string(raw), "tailwindcss") {
				if err := os.WriteFile(path, []byte(content), 0644); err != nil {
					return "", err
				}
			}
		}
	}
	// Vite requires a root index.html. Older projects may only contain public/index.html.
	index := filepath.Join(dir, "index.html")
	if _, err := os.Stat(index); os.IsNotExist(err) {
		content := `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>WebBuilder App</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>`
		if err := os.WriteFile(index, []byte(content), 0644); err != nil {
			return "", err
		}
	}
	// Tailwind utility classes are inert unless the entry stylesheet imports
	// Tailwind layers. Preserve custom CSS, but add the layers once when the
	// generated app uses Tailwind and forgot the directives.
	cssPath := filepath.Join(dir, "src", "index.css")
	if raw, readErr := os.ReadFile(cssPath); readErr == nil {
		css := string(raw)
		if !strings.Contains(css, "@tailwind base") && !strings.Contains(css, "@import \"tailwindcss\"") {
			css = "@tailwind base;\n@tailwind components;\n@tailwind utilities;\n\n" + css
			if err := os.WriteFile(cssPath, []byte(css), 0644); err != nil {
				return "", err
			}
		}
	}
	// SDK cloud nyata di dalam proyek. Sebelumnya cloudAuth/cloudDb hanya
	// disuntikkan Builder ke iframe, sehingga aplikasi hasil AI crash begitu
	// dibuka mandiri (runtime port / publish). File ini ikut ke dist saat build.
	if err := writeProjectSDK(dir, p.ID); err != nil {
		return "", err
	}
	if err := ensureSDKInIndexHTML(dir); err != nil {
		return "", err
	}
	return dir, nil
}

// writeProjectSDK menulis public/wb-cloud.js berisi cloudAuth/cloudDb/window.db
// yang memanggil /api/app-api/<pid> dengan sesi proyek sendiri.
func writeProjectSDK(dir string, pid uint) error {
	publicDir := filepath.Join(dir, "public")
	if err := os.MkdirAll(publicDir, 0755); err != nil {
		return err
	}
	sdk := strings.ReplaceAll(projectSDKSource, "__PID__", fmt.Sprintf("%d", pid))
	if err := os.WriteFile(filepath.Join(publicDir, "wb-cloud.js"), []byte(sdk), 0644); err != nil {
		return err
	}
	return ensureSDKTypes(dir)
}

// ensureSDKTypes menulis deklarasi TypeScript hanya bila proyek belum
// mendeklarasikan global cloudDb sendiri (menghindari duplikasi properti Window).
func ensureSDKTypes(dir string) error {
	srcDir := filepath.Join(dir, "src")
	declared := false
	_ = filepath.Walk(srcDir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info == nil || info.IsDir() || declared {
			return nil
		}
		ext := filepath.Ext(path)
		if ext != ".ts" && ext != ".tsx" {
			return nil
		}
		raw, readErr := os.ReadFile(path)
		if readErr != nil || len(raw) > 200000 {
			return nil
		}
		text := string(raw)
		if strings.Contains(text, "cloudDb") && strings.Contains(text, "interface Window") {
			declared = true
		}
		return nil
	})
	if declared {
		return nil
	}
	if err := os.MkdirAll(srcDir, 0755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(srcDir, "wb-cloud.d.ts"), []byte(projectSDKTypes), 0644)
}

// ensureSDKInIndexHTML memastikan index.html memuat /wb-cloud.js sebelum bundle.
func ensureSDKInIndexHTML(dir string) error {
	index := filepath.Join(dir, "index.html")
	raw, err := os.ReadFile(index)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	html := string(raw)
	if strings.Contains(html, "wb-cloud.js") {
		return nil
	}
	tag := `<script src="/wb-cloud.js"></script>`
	switch {
	case strings.Contains(html, "<head>"):
		html = strings.Replace(html, "<head>", "<head>\n  "+tag, 1)
	case strings.Contains(html, "<head "):
		if i := strings.Index(html, ">"); i >= 0 {
			html = html[:i+1] + "\n  " + tag + html[i+1:]
		}
	default:
		html = tag + "\n" + html
	}
	return os.WriteFile(index, []byte(html), 0644)
}

func runtimeInstall(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, ok := runtimeProject(db, c)
		if !ok {
			return
		}
		dir, err := prepareRuntimeWorkspace(p)
		if err != nil {
			c.JSON(500, gin.H{"error": err.Error()})
			return
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 4*time.Minute)
		defer cancel()
		command, installArgs, _ := runtimeToolchain(dir)
		out, code, runErr := runtimeRun(ctx, dir, command, installArgs...)
		status := "success"
		if runErr != nil { status = "failed" }
		updates := map[string]interface{}{"buildStatus": status, "buildError": errorString(runErr)}
		if status == "success" { now := time.Now(); updates["builtAt"] = &now; updates["publishState"] = "preview_ready" } else { updates["publishState"] = "build_failed" }
		db.Model(p).Updates(updates)
		runtimeStatus(c, status, out, code, runErr)
	}
}

func runtimeBuild(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, ok := runtimeProject(db, c)
		if !ok {
			return
		}
		dir, err := prepareRuntimeWorkspace(p)
		if err != nil {
			c.JSON(500, gin.H{"error": err.Error()})
			return
		}
		if _, err := os.Stat(filepath.Join(dir, "node_modules")); err != nil {
			if _, pnpmErr := os.Stat(filepath.Join(dir, "pnpm-lock.yaml")); pnpmErr != nil {
				c.JSON(409, gin.H{"status": "blocked", "error": "Dependencies belum di-install. Jalankan install terlebih dahulu."})
				return
			}
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 3*time.Minute)
		defer cancel()
		command, _, buildArgs := runtimeToolchain(dir)
		out, code, runErr := runtimeRun(ctx, dir, command, buildArgs...)
		status := "success"
		if runErr != nil {
			status = "failed"
		}
		runtimeStatus(c, status, out, code, runErr)
	}
}

func generatedQualityIssues(p *models.Project) []string {
	var files map[string]string
	if json.Unmarshal([]byte(p.Files), &files) != nil {
		return []string{"files project tidak valid"}
	}
	required := []string{"package.json", "README.md"}
	enterprise := strings.Contains(files["pnpm-workspace.yaml"], "apps/") || strings.TrimSpace(files["apps/web/app/page.tsx"]) != ""
	if enterprise {
		required = append(required, "pnpm-workspace.yaml", "apps/web/package.json", "apps/web/app/layout.tsx", "apps/web/app/page.tsx", "apps/api/src/main.ts", "packages/database/prisma/schema.prisma")
	} else {
		required = append(required, "index.html", "src/main.tsx", "src/App.tsx")
	}
	issues := []string{}
	all := strings.ToLower(p.Name)
	var combined strings.Builder
	for name, content := range files {
		all += " " + strings.ToLower(name)
		combined.WriteString("\n" + strings.ToLower(content))
	}
	text := combined.String()
	for _, name := range required {
		if strings.TrimSpace(files[name]) == "" {
			issues = append(issues, "file wajib tidak ada: "+name)
		}
	}
	// Placeholder text is reported as a warning by browser acceptance tests,
	// not a hard blocker: legacy projects must still be allowed to install/build
	// so the AI can inspect the real runtime and replace incomplete modules.
	// Product apps need real data flow, not only static dashboard cards.
	isSaaS := strings.Contains(all, "saas") || strings.Contains(all, "pos") || strings.Contains(all, "crm") || strings.Contains(all, "erp") || strings.Contains(all, "inventory") || strings.Contains(all, "e-commerce") || strings.Contains(all, " ecommerce")
	// Reject HTML-only generation for product projects. index.html is allowed only as Vite bootstrap.
	isProduct := isSaaS || strings.Contains(all, "wholesale") || strings.Contains(all, "contractor") || strings.Contains(all, "booking") || strings.Contains(all, "finance")
	if isProduct {
		if strings.Contains(text, "<script type=\"text/babel\"") || strings.Contains(text, "unpkg.com/react") {
			issues = append(issues, "project memakai HTML/Babel CDN, bukan Vite React")
		}
		if strings.TrimSpace(files["src/main.tsx"]) == "" || strings.TrimSpace(files["src/App.tsx"]) == "" {
			issues = append(issues, "aplikasi product wajib memiliki entry React src/main.tsx dan src/App.tsx")
		}
		if !strings.Contains(all, "src/services") {
			issues = append(issues, "aplikasi product wajib memiliki service/data layer")
		}
	}
	if isSaaS {
		if !strings.Contains(text, "cloudDb") && !strings.Contains(text, "window.db") {
			issues = append(issues, "aplikasi SaaS tidak memiliki persistence cloudDb/window.db")
		}
		if !strings.Contains(all, "src/services") && !strings.Contains(all, "src/service") {
			issues = append(issues, "service/data layer wajib ada di src/services/")
		}
		if !strings.Contains(text, "insert(") && !strings.Contains(text, ".insert") && !strings.Contains(text, "create") {
			issues = append(issues, "belum ditemukan alur create/insert data nyata")
		}
	}
	if strings.Contains(all, "pos") {
		for _, feature := range []struct{ token, label string }{{"product", "products CRUD"}, {"checkout", "checkout"}, {"inventory", "inventory/stok"}} {
			if !strings.Contains(all, feature.token) && !strings.Contains(text, feature.token) {
				issues = append(issues, "fitur POS wajib belum ditemukan: "+feature.label)
			}
		}
	}
	return issues
}

func runtimePipeline(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, ok := runtimeProject(db, c)
		if !ok {
			return
		}
		// Prepare scaffolding first. Legacy projects may omit package/toolchain
		// files; the runtime can repair those before install/build.
		dir, err := prepareRuntimeWorkspace(p)
		if err != nil {
			c.JSON(500, gin.H{"status": "failed", "phase": "sync", "error": err.Error()})
			return
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 7*time.Minute)
		defer cancel()
		var req struct {
			SQL []string `json:"sql"`
		}
		if c.Request.ContentLength > 0 {
			if err := c.ShouldBindJSON(&req); err != nil {
				c.JSON(400, gin.H{"status": "failed", "phase": "request", "error": err.Error()})
				return
			}
		}
		command, installArgs, buildArgs := runtimeToolchain(dir)
		installOut, installCode, installErr := runtimeRun(ctx, dir, command, installArgs...)
		if installErr != nil {
			c.JSON(200, gin.H{"status": "failed", "phase": "install", "output": installOut, "exitCode": installCode, "error": installErr.Error()})
			return
		}
		buildOut, buildCode, buildErr := runtimeRun(ctx, dir, command, buildArgs...)
		if buildErr != nil {
			c.JSON(200, gin.H{"status": "failed", "phase": "build", "command": command, "output": installOut + "\n" + buildOut, "exitCode": buildCode, "error": buildErr.Error()})
			return
		}
		migrationSteps := []string{}
		for i, sqlText := range req.SQL {
			sqlText = strings.TrimSpace(sqlText)
			if sqlText == "" {
				continue
			}
			hash := sha256.Sum256([]byte(sqlText))
			name := fmt.Sprintf("ai-%s", hex.EncodeToString(hash[:])[:16])
			var existing models.ProjectMigration
			if err := db.Where("project_id = ? AND name = ? AND status = ?", p.ID, name, "applied").First(&existing).Error; err == nil {
				migrationSteps = append(migrationSteps, fmt.Sprintf("%d:%s(idempotent)", i+1, name))
				continue
			}
			steps, migrationErr := runMigrationSQL(ctx, fmt.Sprint(p.ID), sqlText, false)
			status := "applied"
			if migrationErr != nil {
				status = "failed"
			}
			row := models.ProjectMigration{ProjectID: p.ID, Name: name, UpSQL: sqlText, Status: status, Error: errorString(migrationErr)}
			if migrationErr == nil {
				now := time.Now()
				row.AppliedAt = &now
			}
			db.Create(&row)
			if migrationErr != nil {
				c.JSON(200, gin.H{"status": "failed", "phase": "migration", "migration": name, "steps": steps, "error": migrationErr.Error()})
				return
			}
			migrationSteps = append(migrationSteps, fmt.Sprintf("%d:%s", i+1, name))
		}
		// Backend-owned database readiness check. Full CRUD verification remains
		// available through /runtime/db-verify, while this gate prevents the
		// browser from starting a runtime against an unavailable app database.
		if err := ensureSchema(fmt.Sprint(p.ID)); err != nil {
			c.JSON(200, gin.H{"status": "failed", "phase": "database", "migrations": migrationSteps, "error": err.Error()})
			return
		}
		sqldb, err := getAppSQLDB()
		if err != nil {
			c.JSON(200, gin.H{"status": "failed", "phase": "database", "migrations": migrationSteps, "error": err.Error()})
			return
		}
		if err := sqldb.PingContext(ctx); err != nil {
			c.JSON(200, gin.H{"status": "failed", "phase": "database", "migrations": migrationSteps, "error": err.Error()})
			return
		}
		c.JSON(200, gin.H{"status": "success", "phase": "database", "output": installOut + "\n" + buildOut, "exitCode": buildCode, "migrations": migrationSteps, "database": "ready"})
	}
}

func runtimeVerify(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, ok := runtimeProject(db, c)
		if !ok {
			return
		}
		issues := generatedQualityIssues(p)
		if len(issues) > 0 {
			db.Model(p).Updates(map[string]interface{}{"buildStatus": "failed", "buildError": strings.Join(issues, "; "), "publishState": "build_failed"})
			c.JSON(200, gin.H{"status": "failed", "phase": "quality", "issues": issues, "error": "Project belum memenuhi kontrak framework/build."})
			return
		}
		dir, err := prepareRuntimeWorkspace(p)
		if err != nil {
			c.JSON(500, gin.H{"status": "failed", "error": err.Error()})
			return
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 7*time.Minute)
		defer cancel()
		command, installArgs, buildArgs := runtimeToolchain(dir)
		installOut, installCode, installErr := runtimeRun(ctx, dir, command, installArgs...)
		if installErr != nil {
			c.JSON(200, gin.H{"status": "failed", "phase": "install", "command": command, "output": installOut, "exitCode": installCode, "error": installErr.Error()})
			return
		}
		buildOut, buildCode, buildErr := runtimeRun(ctx, dir, command, buildArgs...)
		status := "success"
		if buildErr != nil { status = "failed" }
		if status == "success" {
			now := time.Now()
			db.Model(p).Updates(map[string]interface{}{"buildStatus": "success", "buildError": "", "builtAt": &now, "publishState": "preview_ready"})
		} else {
			db.Model(p).Updates(map[string]interface{}{"buildStatus": "failed", "buildError": errorString(buildErr), "publishState": "build_failed"})
		}
		c.JSON(200, gin.H{"status": status, "phase": "build", "command": command, "output": installOut + "\n" + buildOut, "exitCode": buildCode, "error": errorString(buildErr)})
	}
}

func runtimeDBVerify(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, ok := runtimeProject(db, c)
		if !ok {
			return
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
		defer cancel()
		if err := ensureSchema(fmt.Sprint(p.ID)); err != nil {
			c.JSON(200, gin.H{"status": "failed", "phase": "schema", "error": err.Error()})
			return
		}
		sqldb, err := getAppSQLDB()
		if err != nil {
			c.JSON(200, gin.H{"status": "failed", "phase": "connect", "error": err.Error()})
			return
		}
		// Use a transaction and a throwaway table so verification never changes project data.
		table := fmt.Sprintf("%s.__wb_verify_%d", appSchema(fmt.Sprint(p.ID)), time.Now().UnixNano())
		tx, err := sqldb.BeginTx(ctx, nil)
		if err != nil {
			c.JSON(200, gin.H{"status": "failed", "phase": "transaction", "error": err.Error()})
			return
		}
		rollback := true
		defer func() {
			if rollback {
				_ = tx.Rollback()
			}
		}()
		steps := []string{}
		run := func(phase, query string, args ...interface{}) error {
			if _, e := tx.ExecContext(ctx, query, args...); e != nil {
				c.JSON(200, gin.H{"status": "failed", "phase": phase, "steps": steps, "error": e.Error()})
				return e
			}
			steps = append(steps, phase)
			return nil
		}
		if err := run("create", fmt.Sprintf("CREATE TABLE %s (id SERIAL PRIMARY KEY, value TEXT NOT NULL)", table)); err != nil {
			return
		}
		if err := run("insert", fmt.Sprintf("INSERT INTO %s (value) VALUES ($1)", table), "webbuilder"); err != nil {
			return
		}
		var value string
		if err := tx.QueryRowContext(ctx, fmt.Sprintf("SELECT value FROM %s WHERE value = $1", table), "webbuilder").Scan(&value); err != nil {
			c.JSON(200, gin.H{"status": "failed", "phase": "select", "steps": steps, "error": err.Error()})
			return
		}
		steps = append(steps, "select")
		if err := run("update", fmt.Sprintf("UPDATE %s SET value = $1 WHERE value = $2", table), "verified", "webbuilder"); err != nil {
			return
		}
		if err := run("delete", fmt.Sprintf("DELETE FROM %s WHERE value = $1", table), "verified"); err != nil {
			return
		}
		if err := run("drop", fmt.Sprintf("DROP TABLE %s", table)); err != nil {
			return
		}
		if err := tx.Commit(); err != nil {
			c.JSON(200, gin.H{"status": "failed", "phase": "commit", "steps": steps, "error": err.Error()})
			return
		}
		rollback = false
		c.JSON(200, gin.H{"status": "success", "phase": "crud", "steps": steps, "value": value, "message": "Database connection, schema, transaction, CRUD, and rollback-safe cleanup berhasil."})
	}
}

func runtimeCaptureScreenshot(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, ok := runtimeProject(db, c)
		if !ok {
			return
		}
		runtimeDev.Lock()
		port := runtimeDev.ports[p.ID]
		runtimeDev.Unlock()
		if port == 0 {
			c.JSON(409, gin.H{"error": "Runtime belum siap"})
			return
		}
		dir := filepath.Join(projectRuntimeRoot(p.ID), "screenshots")
		if err := os.MkdirAll(dir, 0755); err != nil {
			c.JSON(500, gin.H{"error": err.Error()})
			return
		}
		name := fmt.Sprintf("capture-%d.png", time.Now().UnixNano())
		out := filepath.Join(dir, name)
		// Screenshot hanya lewat MCP (chrome-devtools-mcp). Jalur
		// playwright lama sudah dihapus: bila flag browser mati atau
		// MCP gagal start, kembalikan error tegas — tidak ada fallback.
		if !browser.Enabled() {
			c.JSON(503, gin.H{"error": "Screenshot butuh alat browser (set WEBBUILDER_ENABLE_BROWSER_TOOLS=1 dan WEBBUILDER_ENABLE_TENANT_EXEC=1)"})
			return
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
		defer cancel()
		if err := browser.CaptureScreenshot(ctx, fmt.Sprintf("http://127.0.0.1:%d", port), out); err != nil {
			c.JSON(502, gin.H{"error": "Screenshot gagal", "output": err.Error()})
			return
		}
		c.JSON(200, gin.H{"status": "ready", "path": fmt.Sprintf("/api/projects/%d/runtime/screenshots/%s", p.ID, name), "name": name})
	}
}
func runtimeScreenshotFile(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, ok := runtimeProject(db, c)
		if !ok {
			return
		}
		name := filepath.Base(c.Param("name"))
		if !strings.HasPrefix(name, "capture-") || !strings.HasSuffix(name, ".png") {
			c.Status(404)
			return
		}
		path := filepath.Join(projectRuntimeRoot(p.ID), "screenshots", name)
		if _, err := os.Stat(path); err != nil {
			c.Status(404)
			return
		}
		c.File(path)
	}
}

// validVerificationScreenshotName menerima hanya nama file screenshot
// verifikasi yang sah: screenshot-<n>.png dengan <n> angka. Pola ketat
// ini sekaligus menolak traversal ("..", "/", "\") dan nama file lain —
// tidak ada normalisasi diam-diam: nama yang tidak cocok ditolak 404.
func validVerificationScreenshotName(name string) bool {
	if !strings.HasPrefix(name, "screenshot-") || !strings.HasSuffix(name, ".png") {
		return false
	}
	num := strings.TrimSuffix(strings.TrimPrefix(name, "screenshot-"), ".png")
	if num == "" {
		return false
	}
	for _, r := range num {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// verificationScreenshotURL mengubah path screenshot verifikasi
// (runtime/project-<pid>/run-<runId>/screenshot-<n>.png) menjadi URL API
// relatif yang bisa dimuat <img> frontend, atau "" bila path tidak cocok
// pola itu — mis. screenshot gagal dipindah dari workspace MCP (path
// workspace bukan path run) atau verifikasi tidak jalan. URL relatif
// saja: frontend menambahkan token JWT-nya sebagai ?token= (didukung
// authMiddleware, jalur yang sama dengan iframe preview) karena <img>
// tidak bisa mengirim header Authorization.
func verificationScreenshotURL(projectID, runID uint, screenshotPath string) string {
	name := filepath.Base(screenshotPath)
	if !validVerificationScreenshotName(name) {
		return ""
	}
	wantDir := filepath.Join(projectRuntimeRoot(projectID), fmt.Sprintf("run-%d", runID))
	if filepath.Dir(screenshotPath) != wantDir {
		return ""
	}
	return fmt.Sprintf("/api/projects/%d/runtime/screenshots/verification/%d/%s", projectID, runID, name)
}

// runtimeVerificationScreenshotFile menyajikan screenshot verifikasi
// browser satu run: GET /api/projects/:id/runtime/screenshots/
// verification/:runId/:name. Auth sama seperti endpoint screenshot lama
// (runtimeProject: owner/editor proyek, lewat authMiddleware).
//
// Keamanan path: :runId harus angka dan harus baris agent_runs milik
// proyek ini (cek DB — run proyek lain / user lain → 404, bukan file);
// :name harus persis screenshot-<n>.png; path hasil join dicek tetap
// di dalam direktori run itu sebelum disajikan.
func runtimeVerificationScreenshotFile(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, ok := runtimeProject(db, c)
		if !ok {
			return
		}
		runID, err := strconv.ParseUint(c.Param("runId"), 10, 64)
		if err != nil || runID == 0 {
			c.Status(404)
			return
		}
		var run models.AgentRun
		if err := db.Where("id = ? AND project_id = ?", runID, p.ID).First(&run).Error; err != nil {
			c.Status(404)
			return
		}
		name := c.Param("name")
		if !validVerificationScreenshotName(name) || name != filepath.Base(name) {
			c.Status(404)
			return
		}
		runDir := filepath.Join(projectRuntimeRoot(p.ID), fmt.Sprintf("run-%d", runID))
		path := filepath.Join(runDir, name)
		if filepath.Dir(path) != runDir {
			c.Status(404)
			return
		}
		if _, err := os.Stat(path); err != nil {
			c.Status(404)
			return
		}
		c.File(path)
	}
}

func runtimeDevStart(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, ok := runtimeProject(db, c)
		if !ok {
			return
		}
		dir, err := prepareRuntimeWorkspace(p)
		if err != nil {
			c.JSON(500, gin.H{"error": err.Error()})
			return
		}
		// Bootstrap dependencies automatically before starting the dev server.
		// This makes a fresh generated project runnable with one action.
		installNeeded := false
		if _, statErr := os.Stat(filepath.Join(dir, "node_modules")); os.IsNotExist(statErr) { installNeeded = true }
		if command, _, _ := runtimeToolchain(dir); command == "pnpm" {
			if _, statErr := os.Stat(filepath.Join(dir, "apps", "web", "node_modules")); os.IsNotExist(statErr) { installNeeded = true }
		}
		if installNeeded {
			installCommand, installArgs, _ := runtimeToolchain(dir)
			if installCommand == "pnpm" {
				if _, lookErr := exec.LookPath("pnpm"); lookErr != nil { installCommand = "npx"; installArgs = append([]string{"--yes", "pnpm"}, installArgs...) }
			}
			ctx, cancel := context.WithTimeout(c.Request.Context(), 4*time.Minute)
			out, code, installErr := runtimeRun(ctx, dir, installCommand, installArgs...)
			cancel()
			if installErr != nil {
				c.JSON(422, gin.H{"status": "install_failed", "phase": "install", "output": out, "exitCode": code, "error": installErr.Error()})
				return
			}
		}
		runtimeDev.Lock()
		if cmd := runtimeDev.items[p.ID]; cmd != nil && cmd.Process != nil {
			port := runtimeDev.ports[p.ID]
			runtimeDev.Unlock()
			previewToken := issueRuntimePreviewToken(p.ID, c.GetUint("userID"))
			c.JSON(200, gin.H{"status": "running", "port": port, "previewPath": fmt.Sprintf("/api/projects/%d/runtime/preview/", p.ID), "previewToken": previewToken})
			return
		}
		port := 19000 + int(p.ID)%1000
		for port < 20000 {
			ln, e := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
			if e == nil {
				_ = ln.Close()
				break
			}
			port++
		}
		logPath := filepath.Join(dir, "runtime-dev.log")
		logFile, e := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
		if e != nil {
			runtimeDev.Unlock()
			c.JSON(500, gin.H{"error": e.Error()})
			return
		}
		// Dev server SENGAJA tetap jalur lama (exec langsung), bukan adapter
		// isolasi: adapter saat ini one-shot (Run: timeout + output berbatas
		// + exit code), sedangkan dev server adalah proses long-running yang
		// diawasi — restart otomatis saat crash (lihat goroutine di bawah),
		// log di-stream ke runtime-dev.log, dan dihentikan lewat kill grup
		// proses. Memaksanya ke Run akan merusak desain adapter.
		// KONSEKUENSI JUJUR: dengan flag tenant-exec nyala pun, proses dev
		// server tetap berjalan dengan os.Environ() penuh (termasuk secret)
		// — isolasi penuh BELUM tercapai selama dev server masih di sini.
		// Tindak lanjut: tambah kemampuan Start/Stop (supervised process)
		// ke paket runtime, lalu pindahkan dev server ke sana.
		// Install bootstrap di atas (runtimeRun) SUDAH lewat adapter bila
		// flag nyala; hanya proses dev-nya yang masih jalur lama.
		devCommand, devArgs := runtimeDevCommand(dir, port, p.ID)
		cmd := exec.Command(devCommand, devArgs...)
		cmd.Dir = dir
		cmd.Stdout = logFile
		cmd.Stderr = logFile
		cmd.Env = append(os.Environ(), "CI=1")
		cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		if e = cmd.Start(); e != nil {
			logFile.Close()
			runtimeDev.Unlock()
			c.JSON(500, gin.H{"error": e.Error()})
			return
		}
		runtimeDev.items[p.ID] = cmd
		runtimeDev.ports[p.ID] = port
		runtimeDev.Unlock()
		_ = logFile.Close()
		go func(initial *exec.Cmd, projectID uint, runtimeDir string, runtimePort int, runtimeLog string) {
			current := initial
			for {
				_ = current.Wait()
				runtimeDev.Lock()
				stillManaged := runtimeDev.items[projectID] == current
				runtimeDev.Unlock()
				if !stillManaged {
					return // explicit stop removed the process from the registry
				}
				// Unexpected crash: give the process a short backoff, then restart
				// on the same port and append diagnostics to the same log.
				time.Sleep(2 * time.Second)
				logFile, openErr := os.OpenFile(runtimeLog, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
				if openErr != nil {
					continue
				}
				devCommand, devArgs := runtimeDevCommand(runtimeDir, runtimePort, projectID)
				next := exec.Command(devCommand, devArgs...)
				next.Dir = runtimeDir
				next.Stdout = logFile
				next.Stderr = logFile
				next.Env = append(os.Environ(), "CI=1")
				next.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
				if startErr := next.Start(); startErr != nil {
					_ = logFile.Close()
					continue
				}
				_ = logFile.Close()
				runtimeDev.Lock()
				if runtimeDev.items[projectID] == current {
					runtimeDev.items[projectID] = next
					current = next
					runtimeDev.Unlock()
				} else {
					runtimeDev.Unlock()
					_ = syscall.Kill(-next.Process.Pid, syscall.SIGTERM)
					return
				}
			}
		}(cmd, p.ID, dir, port, logPath)
		ready := runtimeWaitReady(port, 20*time.Second)
		previewToken := issueRuntimePreviewToken(p.ID, c.GetUint("userID"))
		if !ready { c.JSON(503, gin.H{"status": "failed", "phase": "runtime", "error": "runtime tidak membuka port", "log": "runtime-dev.log"}); return }
		c.JSON(200, gin.H{"status": "running", "port": port, "previewPath": fmt.Sprintf("/api/projects/%d/runtime/preview/", p.ID), "previewToken": previewToken, "log": "runtime-dev.log"})
	}
}

func runtimeDevStop(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, ok := runtimeProject(db, c)
		if !ok {
			return
		}
		runtimeDev.Lock()
		cmd := runtimeDev.items[p.ID]
		delete(runtimeDev.items, p.ID)
		delete(runtimeDev.ports, p.ID)
		runtimeDev.Unlock()
		if cmd != nil && cmd.Process != nil {
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
		}
		c.JSON(200, gin.H{"status": "stopped"})
	}
}

func runtimeDevSync(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, ok := runtimeProject(db, c)
		if !ok {
			return
		}
		if _, err := prepareRuntimeWorkspace(p); err != nil {
			c.JSON(500, gin.H{"error": err.Error()})
			return
		}
		c.JSON(200, gin.H{"status": "synced", "projectId": p.ID})
	}
}

func browserAcceptance(port int) (map[string]interface{}, error) {
	// Acceptance hanya lewat MCP (chrome-devtools-mcp). Jalur playwright
	// lama sudah dihapus: bila flag browser mati atau MCP/Chrome gagal
	// start, kembalikan error tegas (fail-closed) — tidak ada fallback.
	// Struktur hasil (http, hasBody, consoleErrors, failedAppResources,
	// sdk) dipakai pemakai di features.go:703 dan repair.go:29.
	pageURL := fmt.Sprintf("http://127.0.0.1:%d", port)
	if !browser.Enabled() {
		return nil, browser.ErrBrowserToolsDisabled
	}
	result, err := browser.RunAcceptance(context.Background(), pageURL)
	if err != nil {
		if errors.Is(err, browser.ErrAcceptanceFailed) {
			// Halaman berhasil dibuka dan dicek MCP, tapi TIDAK LOLOS —
			// ini verdict final, BUKAN kegagalan infrastruktur.
			return result, err
		}
		// Kegagalan infrastruktur (MCP/Chrome gagal start): error tegas,
		// tanpa fallback.
		return result, err
	}
	return result, nil
}

func runtimeDevStatus(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, ok := runtimeProject(db, c)
		if !ok {
			return
		}
		runtimeDev.Lock()
		cmd := runtimeDev.items[p.ID]
		port := runtimeDev.ports[p.ID]
		runtimeDev.Unlock()
		running := cmd != nil && cmd.Process != nil
		c.JSON(200, gin.H{"status": map[bool]string{true: "running", false: "stopped"}[running], "port": port, "previewPath": fmt.Sprintf("/api/projects/%d/runtime/preview/", p.ID)})
	}
}

func runtimeDevPreview(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, ok := runtimeProject(db, c)
		if !ok {
			return
		}
		// The iframe cannot attach the app Authorization header. Require the
		// short-lived, project/user-bound preview grant instead.
		previewToken := c.Query("token")
		grant, valid := getRuntimePreviewGrant(previewToken)
		if !valid || grant.ProjectID != p.ID || grant.UserID != c.GetUint("userID") {
			// Fallback cookie wb_preview: WebSocket HMR Vite mengirim
			// ?token=<wsToken internal Vite> di query — bukan token
			// preview — sehingga grant query gagal. Coba grant dari
			// cookie (sama seperti fallback di authMiddleware).
			if ck, err := c.Cookie("wb_preview"); err == nil && ck != "" {
				previewToken = ck
				grant, valid = getRuntimePreviewGrant(previewToken)
			}
		}
		if !valid || grant.ProjectID != p.ID || grant.UserID != c.GetUint("userID") {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "preview token tidak valid atau sudah kedaluwarsa"})
			return
		}
		// Set cookie preview (HttpOnly, Path = prefix preview): browser
		// mengirimkannya otomatis pada semua sub-request di bawah prefix
		// itu — import bersarang modul JS, CSS, gambar, fetch aplikasi,
		// WebSocket HMR — yang tidak membawa ?token= (lihat authMiddleware).
		// Tanpa ini, modul-modul itu ditolak 401 dan aplikasi tidak render.
		// Cookie hanya berlaku 24 jam (sama dengan masa grant) dan tidak
		// dibaca JavaScript (HttpOnly). Header diset sebelum proxy: header
		// yang sudah ada di ResponseWriter dipertahankan ReverseProxy.
		c.Header("Set-Cookie", "wb_preview="+previewToken+"; Path="+runtimePreviewBasePath(p.ID)+"/; Max-Age=86400; HttpOnly; SameSite=Lax")
		runtimeDev.Lock()
		port := runtimeDev.ports[p.ID]
		running := runtimeDev.items[p.ID] != nil
		runtimeDev.Unlock()
		if !running || port == 0 {
			c.JSON(409, gin.H{"error": "runtime dev belum berjalan"})
			return
		}
		target, _ := url.Parse(fmt.Sprintf("http://127.0.0.1:%d", port))
		proxy := httputil.NewSingleHostReverseProxy(target)
		// Dev server Vite dijalankan dengan --base = prefix proxy ini
		// (runtimeDevCommand), jadi path diteruskan APA ADANYA ke Vite —
		// JANGAN strip prefix seperti dulu: Vite membalas request "/" yang
		// di-strip dengan 302 ke base path, dan browser mengikuti redirect
		// itu TANPA token sehingga authMiddleware menolaknya 401 dan
		// iframe preview kosong.
		originalDirector := proxy.Director
		proxy.Director = func(r *http.Request) {
			originalDirector(r)
			// JANGAN strip ?token= pada upgrade WebSocket HMR: Vite
			// memvalidasi token itu pada handshake (hasValidToken di
			// createWebSocketServer — token harus sama dengan wsToken
			// internal Vite) dan menolak tanpa token dengan 400. Token
			// di sini adalah wsToken Vite, bukan token preview — auth
			// Go sudah lolos lewat cookie wb_preview sebelum proxy
			// (fallback authMiddleware). Untuk request HTTP biasa token
			// tetap di-strip (JWT mengandung '.' yang merusak deteksi
			// ekstensi Vite untuk modul .tsx).
			if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
				r.URL.RawQuery = stripPreviewTokenQuery(c.Request.URL.RawQuery)
			}
		}
		proxy.ModifyResponse = func(resp *http.Response) error {
			if shouldInjectPreviewBridge(resp.Header.Get("Content-Type")) {
				body, readErr := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
				if readErr != nil {
					return readErr
				}
				_ = resp.Body.Close()
				prefix := runtimePreviewBasePath(p.ID)
				// Vite emits root-relative module and stylesheet URLs. Prefix them
				// so the browser requests them through this authenticated proxy.
				text := string(body)
				// URL aset: tempeli prefix proxy bila belum ada (Vite dengan
				// --base sudah mengeluarkannya berprefix) + tempeli token
				// supaya sub-request top-level lolos authMiddleware.
				// Import bersarang di DALAM modul memakai URL absolut dan
				// tidak mewarisi query ini — ditanggung cookie wb_preview
				// (lihat atas dan authMiddleware).
				text = rewritePreviewAssetURLs(text, prefix, previewToken)
				// Visual editor klik-elemen: suntikkan bridge (mode pilih +
				// pelaporan error) ke preview Live Runtime. Bridge tidak
				// ditulis ke file proyek dan tidak ikut ke build production.
				text = injectPreviewBridge(text)
				body = []byte(text)
				resp.Body = io.NopCloser(strings.NewReader(text))
				resp.ContentLength = int64(len(body))
				resp.Header.Set("Content-Length", fmt.Sprint(len(body)))
				resp.Header.Del("ETag")
			}
			return nil
		}
		proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, e error) {
			c.JSON(502, gin.H{"error": "preview runtime tidak tersedia"})
		}
		proxy.ServeHTTP(c.Writer, c.Request)
	}
}

// stripPreviewTokenQuery membuang parameter ?token= (token preview
// pv_...) dari query yang diteruskan ke Vite. Token hanya dipakai
// auth middleware WebBuilder sebelum proxy; bila diteruskan, nilai
// JWT yang mengandung '.' merusak deteksi ekstensi Vite untuk modul
// .tsx (transform gagal "JSX syntax is disabled"). Parameter query
// lain milik aplikasi diteruskan apa adanya.
func stripPreviewTokenQuery(rawQuery string) string {
	if rawQuery == "" {
		return ""
	}
	q, err := url.ParseQuery(rawQuery)
	if err != nil {
		return rawQuery
	}
	if _, ok := q["token"]; !ok {
		return rawQuery
	}
	q.Del("token")
	return q.Encode()
}

// rewritePreviewAssetURLs menulis ulang URL aset root-relative di dokumen
// HTML preview:
//   - URL yang belum berprefix ditempeli prefix proxy. Dev server Vite
//     dijalankan dengan --base prefix yang sama, jadi URL hasil transform
//     Vite sudah berprefix dan TIDAK digandakan.
//   - Semua URL aset ditempeli ?token= (atau &token= bila sudah punya
//     query) supaya sub-request browser lolos authMiddleware. Tanpa ini
//     iframe preview hanya memuat kerangka HTML sementara semua JS/CSS
//     ditolak 401 dan aplikasi tidak pernah dirender. Import relatif di
//     dalam modul mewarisi query string ini secara otomatis, jadi satu
//     tempelan di dokumen utama cukup.
func rewritePreviewAssetURLs(text, prefix, token string) string {
	rewriteOne := func(attr, u, closer string) string {
		if !strings.HasPrefix(u, prefix+"/") {
			u = prefix + u
		}
		if token == "" {
			return attr + u + closer
		}
		if strings.Contains(u, "?") {
			return attr + u + "&token=" + url.QueryEscape(token) + closer
		}
		return attr + u + "?token=" + url.QueryEscape(token) + closer
	}
	attrRe := regexp.MustCompile(`((?:src|href)=")(/[^"]*)(")`)
	text = attrRe.ReplaceAllStringFunc(text, func(m string) string {
		p := attrRe.FindStringSubmatch(m)
		return rewriteOne(p[1], p[2], p[3])
	})
	cssRe := regexp.MustCompile(`(url\()(/[^)]*)(\))`)
	text = cssRe.ReplaceAllStringFunc(text, func(m string) string {
		p := cssRe.FindStringSubmatch(m)
		return rewriteOne(p[1], p[2], p[3])
	})
	return text
}

func runtimeDevLogStream(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, ok := runtimeProject(db, c)
		if !ok {
			return
		}
		c.Header("Content-Type", "text/event-stream")
		c.Header("Cache-Control", "no-cache")
		c.Header("Connection", "keep-alive")
		last := ""
		ticker := time.NewTicker(800 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-c.Request.Context().Done():
				return
			case <-ticker.C:
				data, _ := os.ReadFile(filepath.Join(projectRuntimeRoot(p.ID), "runtime-dev.log"))
				if len(data) > 16000 {
					data = data[len(data)-16000:]
				}
				output := string(data)
				if output == last {
					continue
				}
				last = output
				payload, _ := json.Marshal(gin.H{"output": output, "bytes": len(data)})
				_, _ = c.Writer.Write([]byte("event: runtime\\ndata: " + string(payload) + "\\n\\n"))
				c.Writer.Flush()
			}
		}
	}
}

func runtimeDevLogs(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, ok := runtimeProject(db, c)
		if !ok {
			return
		}
		data, err := os.ReadFile(filepath.Join(projectRuntimeRoot(p.ID), "runtime-dev.log"))
		if err != nil && !os.IsNotExist(err) {
			c.JSON(500, gin.H{"error": err.Error()})
			return
		}
		if len(data) > 16000 {
			data = data[len(data)-16000:]
		}
		output := string(data)
		errors := []string{}
		for _, line := range strings.Split(output, "\n") {
			lower := strings.ToLower(line)
			if strings.Contains(lower, "error") || strings.Contains(lower, "failed") || strings.Contains(lower, "missing script") {
				line = strings.TrimSpace(line)
				if line != "" && len(errors) < 20 {
					errors = append(errors, line)
				}
			}
		}
		c.JSON(200, gin.H{"output": output, "bytes": len(data), "errors": errors})
	}
}

type runtimeMatrixCheck struct {
	Name string `json:"name"`
	Status string `json:"status"`
	Detail string `json:"detail"`
}

func runtimeFrameworkMatrix(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, ok := runtimeProject(db, c)
		if !ok { return }
		var files map[string]string
		_ = json.Unmarshal([]byte(p.Files), &files)
		dir := projectRuntimeRoot(p.ID)
		command, installArgs, buildArgs := runtimeToolchain(dir)
		if _, err := os.Stat(filepath.Join(dir, "package.json")); err != nil { command, installArgs, buildArgs = runtimeToolchainFromFiles(files) }
		framework := strings.ToLower(p.Framework)
		if framework == "" { framework = "auto" }
		checks := []runtimeMatrixCheck{}
		add := func(name, status, detail string) { checks = append(checks, runtimeMatrixCheck{Name:name, Status:status, Detail:detail}) }
		for _, required := range frameworkRequiredFiles(framework, files) {
			if strings.TrimSpace(files[required]) != "" { add("file:"+required, "pass", "tersedia") } else { add("file:"+required, "fail", "belum ada") }
		}
		if _, err := exec.LookPath(command); err == nil { add("tool:"+command, "pass", "tersedia") } else { add("tool:"+command, "fail", "tidak tersedia di runtime") }
		add("install", "info", command+" "+strings.Join(installArgs, " "))
		add("build", "info", command+" "+strings.Join(buildArgs, " "))
		passed := true
		for _, check := range checks { if check.Status == "fail" { passed = false } }
		c.JSON(200, gin.H{"framework": framework, "toolchain": command, "checks": checks, "status": map[bool]string{true:"ready", false:"blocked"}[passed], "buildStatus": p.BuildStatus, "publishState": p.PublishState})
	}
}

func runtimeToolchainFromFiles(files map[string]string) (string, []string, []string) {
	if strings.TrimSpace(files["pnpm-workspace.yaml"]) != "" { return "pnpm", []string{"install", "--ignore-scripts", "--no-frozen-lockfile"}, []string{"--filter", "web", "run", "build"} }
	if strings.TrimSpace(files["requirements.txt"]) != "" { return "python3", []string{"-m", "pip", "install", "-r", "requirements.txt"}, []string{"-m", "uvicorn", "main:app", "--host", "0.0.0.0"} }
	if strings.TrimSpace(files["manage.py"]) != "" { return "python3", []string{"-m", "pip", "install", "-r", "requirements.txt"}, []string{"manage.py", "runserver", "0.0.0.0:3000"} }
	if strings.TrimSpace(files["artisan"]) != "" { return "composer", []string{"install", "--no-interaction", "--no-progress"}, []string{"install"} }
	return "npm", []string{"install", "--ignore-scripts", "--no-audit", "--no-fund"}, []string{"run", "build"}
}

func frameworkRequiredFiles(framework string, files map[string]string) []string {
	switch framework {
	case "nextjs": return []string{"package.json", "apps/web/package.json", "apps/web/app/layout.tsx", "apps/web/app/page.tsx"}
	case "nestjs": return []string{"package.json", "apps/api/src/main.ts", "apps/api/src/app.module.ts"}
	case "fastapi": return []string{"requirements.txt", "main.py"}
	case "django": return []string{"requirements.txt", "manage.py"}
	case "laravel": return []string{"composer.json", "artisan"}
	case "express": return []string{"package.json", "src/server.ts"}
	default: return []string{"package.json", "README.md"}
	}
}

func runtimeInfo(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, ok := runtimeProject(db, c)
		if !ok {
			return
		}
		dir := projectRuntimeRoot(p.ID)
		_, nodeErr := os.Stat(filepath.Join(dir, "node_modules"))
		_, pkgErr := os.Stat(filepath.Join(dir, "package.json"))
		c.JSON(200, gin.H{"projectId": p.ID, "workspace": dir, "packageJson": pkgErr == nil, "nodeModules": nodeErr == nil})
	}
}

package handler

import (
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
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"gorm.io/gorm"
	"webbuilder/internal/database/models"
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

func runtimePnpmWebFilter(dir string) string {
	content, err := os.ReadFile(filepath.Join(dir, "apps", "web", "package.json"))
	if err == nil {
		var pkg struct{ Name string `json:"name"` }
		if json.Unmarshal(content, &pkg) == nil && strings.TrimSpace(pkg.Name) != "" { return pkg.Name }
	}
	return "web"
}

func runtimeDevCommand(dir string, port int) (string, []string) {
	command, _, _ := runtimeToolchain(dir)
	if command == "pnpm" {
		filter := runtimePnpmWebFilter(dir)
		args := []string{"--filter", filter, "dev", "--host", "127.0.0.1", "--port", fmt.Sprint(port)}
		if _, err := exec.LookPath("pnpm"); err == nil { return "pnpm", args }
		return "npx", append([]string{"--yes", "pnpm@9.15.0"}, args...)
	}
	if command == "python3" {
		return "python3", []string{"-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", fmt.Sprint(port)}
	}
	if command == "composer" {
		return "php", []string{"artisan", "serve", "--host", "127.0.0.1", "--port", fmt.Sprint(port)}
	}
	return "npm", []string{"run", "dev", "--", "--host", "127.0.0.1", "--port", fmt.Sprint(port)}
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
		files[".env.example"] = "VITE_API_BASE_URL=http://localhost:18082\nVITE_APP_NAME=WebBuilder App\n# Isi secret hanya di .env.local, jangan commit credential.\n"
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
	if err := os.WriteFile(filepath.Join(dir, ".env.local"), []byte(activeEnv), 0600); err != nil {
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
		if err := os.WriteFile(target, []byte(content), 0644); err != nil {
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
				_ = os.WriteFile(pkg, encoded, 0644)
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
	viteCfg := filepath.Join(dir, "vite.config.ts")
	if _, err := os.Stat(viteCfg); os.IsNotExist(err) {
		content := `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({ plugins: [react()], server: { allowedHosts: true, proxy: { "/api": { target: "http://127.0.0.1:18082", changeOrigin: true } } } });
`
		if err := os.WriteFile(viteCfg, []byte(content), 0644); err != nil {
			return "", err
		}
	} else if b, err := os.ReadFile(viteCfg); err == nil {
		// Dev server harus bisa memanggil backend WebBuilder. Tanpa proxy,
		// aplikasi yang dibuka di port Vite memanggil /api relatif ke dirinya
		// sendiri dan menerima 404 (cloudDb/cloudAuth gagal total).
		s := string(b)
		needsHosts := !strings.Contains(s, "allowedHosts")
		needsProxy := !strings.Contains(s, `"/api"`) && !strings.Contains(s, `'/api'`)
		if needsHosts || needsProxy {
			extra := ""
			if needsHosts {
				extra += " allowedHosts: true,"
			}
			if needsProxy {
				extra += ` proxy: { "/api": { target: "http://127.0.0.1:18082", changeOrigin: true } },`
			}
			if strings.Contains(s, "server: {") {
				s = strings.Replace(s, "server: {", "server: {"+extra, 1)
			} else {
				s = strings.Replace(s, "defineConfig({", "defineConfig({\n  server: {"+extra+" },", 1)
			}
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
		script := `const {chromium}=require('/home/hatch/workspace/tools/waview/node_modules/playwright-core');(async()=>{const b=await chromium.launch({headless:true,executablePath:'/home/hatch/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',args:['--no-sandbox','--ignore-certificate-errors']});const p=await b.newPage({viewport:{width:1440,height:900}});await p.goto(process.argv[1],{waitUntil:'networkidle',timeout:20000});await p.screenshot({path:process.argv[2],fullPage:true});await b.close()})().catch(e=>{console.error(e);process.exit(1)})`
		ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, "node", "-e", script, fmt.Sprintf("http://127.0.0.1:%d", port), out)
		raw, err := cmd.CombinedOutput()
		if err != nil {
			c.JSON(502, gin.H{"error": "Screenshot gagal", "output": string(raw)})
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
		devCommand, devArgs := runtimeDevCommand(dir, port)
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
				devCommand, devArgs := runtimeDevCommand(runtimeDir, runtimePort)
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
	script := `const {chromium}=require('/opt/webbuilder/tools/waview/node_modules/playwright-core');(async()=>{const b=await chromium.launch({headless:true,executablePath:'/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',args:['--no-sandbox','--ignore-certificate-errors']});const p=await b.newPage({viewport:{width:1280,height:800}});const errors=[],failedResources=[];const origin=new URL(process.argv[1]).origin;p.on('console',m=>{if(m.type()==='error')errors.push(m.text())});p.on('pageerror',e=>errors.push('PAGEERROR: '+e.message));const isAuthProbe=u=>u.indexOf('/api/app-api/')>=0;const isExpected401=(u,s)=>s===401&&isAuthProbe(u);p.on('requestfailed',r=>{if(new URL(r.url()).origin===origin&&!isAuthProbe(r.url()))failedResources.push({url:r.url(),error:r.failure()?.errorText})});p.on('response',r=>{const u=r.url();if(new URL(u).origin===origin&&r.status()>=400&&!isExpected401(u,r.status()))failedResources.push({url:u,status:r.status()})});const r=await p.goto(process.argv[1],{waitUntil:'networkidle',timeout:20000});const body=(await p.locator('body').innerText()).trim();const sdk=await p.evaluate(async()=>{const has=typeof window.cloudAuth==='object'&&typeof window.cloudDb==='object';if(!has)return{installed:false};try{await window.cloudAuth.me();return{installed:true,loggedOut:false}}catch(e){return{installed:true,loggedOut:true}}});const out={http:r&&r.status(),hasBody:body.length>0,consoleErrors:errors.slice(0,10),failedAppResources:failedResources,sdk};console.log(JSON.stringify(out));await b.close();const fatal=errors.filter(e=>e.indexOf('Failed to load resource')<0);if(!out.http||out.http>=400||!out.hasBody||failedResources.length||fatal.length)process.exit(2)})().catch(e=>{console.error(e.message);process.exit(1)})`
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "node", "-e", script, fmt.Sprintf("http://127.0.0.1:%d", port))
	raw, err := cmd.CombinedOutput()
	if err != nil {
		return map[string]interface{}{"output": string(raw)}, errors.New("browser acceptance gagal")
	}
	var result map[string]interface{}
	if json.Unmarshal(raw, &result) != nil {
		return map[string]interface{}{"output": string(raw)}, errors.New("browser acceptance output invalid")
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
		grant, valid := getRuntimePreviewGrant(c.Query("token"))
		if !valid || grant.ProjectID != p.ID || grant.UserID != c.GetUint("userID") {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "preview token tidak valid atau sudah kedaluwarsa"})
			return
		}
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
		// Vite mengeluarkan asset absolute (/src/main.tsx, /@vite/client,
		// /assets/*). Lepas prefix API WebBuilder sebelum meneruskan request,
		// jika tidak Vite menganggapnya sebagai route SPA dan mengembalikan HTML
		// untuk file JavaScript sehingga preview terlihat "tidak merespons".
		basePath := fmt.Sprintf("/api/projects/%d/runtime/preview", p.ID)
		originalDirector := proxy.Director
		proxy.Director = func(r *http.Request) {
			originalDirector(r)
			path := r.URL.Path
			if strings.HasPrefix(path, basePath) {
				path = strings.TrimPrefix(path, basePath)
				if path == "" {
					path = "/"
				}
				r.URL.Path = path
				r.URL.RawPath = ""
			}
			r.URL.RawQuery = c.Request.URL.RawQuery
		}
		proxy.ModifyResponse = func(resp *http.Response) error {
			if strings.HasPrefix(resp.Header.Get("Content-Type"), "text/html") {
				body, readErr := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
				if readErr != nil {
					return readErr
				}
				_ = resp.Body.Close()
				prefix := basePath
				// Vite emits root-relative module and stylesheet URLs. Prefix them
				// so the browser requests them through this authenticated proxy.
				text := string(body)
				text = strings.ReplaceAll(text, `src="/`, `src="`+prefix+`/`)
				text = strings.ReplaceAll(text, `href="/`, `href="`+prefix+`/`)
				text = strings.ReplaceAll(text, `url(/`, `url(`+prefix+`/`)
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

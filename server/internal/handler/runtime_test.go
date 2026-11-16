// Tes perbaikan "vite: not found" di prepareRuntimeWorkspace.
//
// package.json hasil model sering tidak memuat vite/react/react-dom,
// padahal script build yang ditambahkan adalah `vite build` — install
// lolos lalu build gagal `sh: 1: vite: not found` (exit 127).
// prepareRuntimeWorkspace wajib menambahkan ketiganya (versi "latest",
// sama seperti scaffold saat package.json belum ada) dan menghormati
// versi yang sudah ada di dependencies MAUPUN devDependencies.
package handler

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"webbuilder/internal/database/models"
)

func readWorkspaceManifest(t *testing.T, dir string) map[string]interface{} {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(dir, "package.json"))
	if err != nil {
		t.Fatalf("baca package.json workspace: %v", err)
	}
	var manifest map[string]interface{}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatalf("parse package.json workspace: %v", err)
	}
	return manifest
}

func manifestDeps(t *testing.T, manifest map[string]interface{}, key string) map[string]interface{} {
	t.Helper()
	deps, _ := manifest[key].(map[string]interface{})
	if deps == nil {
		return map[string]interface{}{}
	}
	return deps
}

func TestStripPreviewTokenQuery(t *testing.T) {
	cases := map[string]string{
		"":                       "",
		"foo=bar":                "foo=bar",
		"token=pv_abc":           "",
		"token=pv_a.b.c&foo=bar": "foo=bar",
		"foo=bar&token=pv_x":     "foo=bar",
		"token=pv_x&token=pv_y":  "",
	}
	for in, want := range cases {
		if got := stripPreviewTokenQuery(in); got != want {
			t.Fatalf("stripPreviewTokenQuery(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestPrepareRuntimeWorkspaceAddsViteReactDeps(t *testing.T) {
	db := openAgentTestDB(t)
	user := makeAdminUser(t, db, "uji-vite-deps@example.com")
	// Manifest minimal persis seperti contractFiles(): tanpa script,
	// tanpa vite/react/react-dom.
	files := map[string]string{
		"package.json": `{"name":"uji","private":true,"version":"0.0.0","type":"module"}`,
		"index.html":   "<!doctype html><html><head><meta charset=\"utf-8\"></head><body><div id=\"root\"></div><script type=\"module\" src=\"/src/main.tsx\"></script></body></html>",
		"src/main.tsx": "import App from './App';\nexport default App;\n",
		"src/App.tsx":  "export default function App() { return <h1>Halo</h1>; }\n",
	}
	fj, _ := json.Marshal(files)
	p := models.Project{UserID: user.ID, Name: "Uji Vite Deps", Slug: "uji-vite-" + randHex(6), Files: string(fj)}
	if err := db.Create(&p).Error; err != nil {
		t.Fatalf("create project: %v", err)
	}
	dir := projectRuntimeRoot(p.ID)
	t.Cleanup(func() { _ = os.RemoveAll(dir) })

	if _, err := prepareRuntimeWorkspace(&p); err != nil {
		t.Fatalf("prepareRuntimeWorkspace: %v", err)
	}
	manifest := readWorkspaceManifest(t, dir)
	scripts := manifestDeps(t, manifest, "scripts")
	if scripts["build"] != "vite build" {
		t.Fatalf("harapkan script build 'vite build', dapat %v", scripts["build"])
	}
	deps := manifestDeps(t, manifest, "dependencies")
	for _, name := range []string{"vite", "react", "react-dom"} {
		if deps[name] != "latest" {
			t.Fatalf("harapkan dependencies[%q] = 'latest', dapat %v", name, deps[name])
		}
	}
	// vite "latest" -> major tak diketahui -> plugin-react ikut "latest",
	// konsisten dengan scaffold saat package.json belum ada.
	if deps["@vitejs/plugin-react"] != "latest" {
		t.Fatalf("harapkan @vitejs/plugin-react 'latest', dapat %v", deps["@vitejs/plugin-react"])
	}
	if deps["typescript"] != "latest" {
		t.Fatalf("harapkan typescript 'latest', dapat %v", deps["typescript"])
	}
}

// Versi yang sudah ada — di dependencies atau devDependencies — tidak
// boleh ditimpa atau diduplikasi ke sisi lain, dan penyelarasan
// plugin-react terhadap major vite yang sudah ada harus tetap jalan.
func TestPrepareRuntimeWorkspaceKeepsExistingViteDeps(t *testing.T) {
	db := openAgentTestDB(t)
	user := makeAdminUser(t, db, "uji-vite-ada@example.com")
	files := map[string]string{
		"package.json": `{"name":"uji","private":true,"version":"0.0.0","type":"module","dependencies":{"react":"^18.3.1"},"devDependencies":{"vite":"^5.4.0","react-dom":"^18.3.1"}}`,
		"index.html":   "<!doctype html><html><head><meta charset=\"utf-8\"></head><body><div id=\"root\"></div><script type=\"module\" src=\"/src/main.tsx\"></script></body></html>",
		"src/main.tsx": "import App from './App';\nexport default App;\n",
		"src/App.tsx":  "export default function App() { return <h1>Halo</h1>; }\n",
	}
	fj, _ := json.Marshal(files)
	p := models.Project{UserID: user.ID, Name: "Uji Vite Ada", Slug: "uji-vite-ada-" + randHex(6), Files: string(fj)}
	if err := db.Create(&p).Error; err != nil {
		t.Fatalf("create project: %v", err)
	}
	dir := projectRuntimeRoot(p.ID)
	t.Cleanup(func() { _ = os.RemoveAll(dir) })

	if _, err := prepareRuntimeWorkspace(&p); err != nil {
		t.Fatalf("prepareRuntimeWorkspace: %v", err)
	}
	manifest := readWorkspaceManifest(t, dir)
	deps := manifestDeps(t, manifest, "dependencies")
	devDeps := manifestDeps(t, manifest, "devDependencies")
	if deps["react"] != "^18.3.1" {
		t.Fatalf("react di dependencies harus tetap '^18.3.1', dapat %v", deps["react"])
	}
	if _, exists := deps["vite"]; exists {
		t.Fatalf("vite sudah ada di devDependencies, tidak boleh diduplikasi ke dependencies (dapat %v)", deps["vite"])
	}
	if _, exists := deps["react-dom"]; exists {
		t.Fatalf("react-dom sudah ada di devDependencies, tidak boleh diduplikasi ke dependencies (dapat %v)", deps["react-dom"])
	}
	if devDeps["vite"] != "^5.4.0" {
		t.Fatalf("vite di devDependencies harus tetap '^5.4.0', dapat %v", devDeps["vite"])
	}
	if devDeps["react-dom"] != "^18.3.1" {
		t.Fatalf("react-dom di devDependencies harus tetap '^18.3.1', dapat %v", devDeps["react-dom"])
	}
	// vite major 5 -> plugin-react ^4.3.4 (penyelarasan yang sudah ada).
	if deps["@vitejs/plugin-react"] != "^4.3.4" {
		t.Fatalf("harapkan @vitejs/plugin-react '^4.3.4' untuk vite 5, dapat %v", deps["@vitejs/plugin-react"])
	}
}

// Tes perbaikan gambar hero rusak di screenshot verifikasi MCP
// (trek A, 16 Nov 2026).
//
// Akar: browser verifikasi membuka Vite dev langsung, dan di sana
// /app-files/... dijawab SPA-fallback HTML — prepareRuntimeWorkspace
// hanya mem-proxy "/api" ke server API. ensureViteDevProxy wajib
// menambahkan "/app-files" (target = port listen server, bukan
// hardcode) di semua bentuk vite.config.ts hasil generate, tanpa
// menduplikasi entri dan tanpa menimpa proxy "/api" yang sudah ada.
func TestEnsureViteDevProxy(t *testing.T) {
	const port = "18093"
	target := `"http://127.0.0.1:` + port + `"`
	cases := []struct {
		name string
		in   string
	}{
		{
			"tanpa server",
			"import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({ plugins: [react()] });\n",
		},
		{
			"server tanpa proxy (scaffold tools.go)",
			"import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\n\nexport default defineConfig({\n  plugins: [react()],\n  server: { allowedHosts: true },\n})",
		},
		{
			"proxy hanya /api",
			"export default defineConfig({ plugins: [react()], server: { allowedHosts: true, proxy: { \"/api\": { target: \"http://127.0.0.1:18093\", changeOrigin: true } } } });",
		},
		{
			"proxy hanya /app-files",
			"export default defineConfig({ plugins: [react()], server: { proxy: { \"/app-files\": { target: \"http://127.0.0.1:18093\", changeOrigin: true } } } });",
		},
		{
			"sudah lengkap",
			"export default defineConfig({ plugins: [react()], server: { allowedHosts: true, proxy: { \"/api\": { target: \"http://127.0.0.1:18093\", changeOrigin: true }, \"/app-files\": { target: \"http://127.0.0.1:18093\", changeOrigin: true } } } });",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ensureViteDevProxy(tc.in, port)
			for _, entry := range []string{`"/api": { target: ` + target, `"/app-files": { target: ` + target} {
				if !strings.Contains(got, entry) {
					t.Fatalf("hasil harus memuat %s, dapat:\n%s", entry, got)
				}
			}
			// Tiap entri tepat satu kali (idempotent, tanpa duplikat).
			if n := strings.Count(got, `"/api"`); n != 1 {
				t.Fatalf("harapkan tepat 1 entri \"/api\", dapat %d:\n%s", n, got)
			}
			if n := strings.Count(got, `"/app-files"`); n != 1 {
				t.Fatalf("harapkan tepat 1 entri \"/app-files\", dapat %d:\n%s", n, got)
			}
			// Satu kunci proxy saja: kunci kedua akan menimpa yang pertama.
			if n := strings.Count(got, "proxy:"); n != 1 {
				t.Fatalf("harapkan tepat 1 kunci proxy:, dapat %d:\n%s", n, got)
			}
			// Idempotent: aplikasi kedua tidak mengubah apa pun.
			if again := ensureViteDevProxy(got, port); again != got {
				t.Fatalf("tidak idempotent, aplikasi kedua mengubah:\n%s", again)
			}
			// Kasus "sudah lengkap" tidak boleh diubah sama sekali.
			if tc.name == "sudah lengkap" && got != tc.in {
				t.Fatalf("config yang sudah lengkap harus dibiarkan apa adanya, dapat:\n%s", got)
			}
		})
	}
}

// Integrasi: prepareRuntimeWorkspace menulis vite.config.ts workspace
// dengan proxy /app-files, baik saat file tidak ada (default scaffold)
// maupun saat config hasil model hanya mem-proxy /api.
func TestPrepareRuntimeWorkspaceProxiesAppFiles(t *testing.T) {
	db := openAgentTestDB(t)
	user := makeAdminUser(t, db, "uji-appfiles-proxy@example.com")
	base := map[string]string{
		"package.json": `{"name":"uji","private":true,"version":"0.0.0","type":"module"}`,
		"index.html":   "<!doctype html><html><head><meta charset=\"utf-8\"></head><body><div id=\"root\"></div><script type=\"module\" src=\"/src/main.tsx\"></script></body></html>",
		"src/main.tsx": "import App from './App';\nexport default App;\n",
		"src/App.tsx":  "export default function App() { return <h1>Halo</h1>; }\n",
	}
	mkProject := func(name string, files map[string]string) *models.Project {
		fj, _ := json.Marshal(files)
		p := models.Project{UserID: user.ID, Name: name, Slug: name + "-" + randHex(6), Files: string(fj)}
		if err := db.Create(&p).Error; err != nil {
			t.Fatalf("create project: %v", err)
		}
		return &p
	}
	wantTarget := `"http://127.0.0.1:` + serverPort() + `"`
	check := func(t *testing.T, p *models.Project) {
		t.Helper()
		dir := projectRuntimeRoot(p.ID)
		t.Cleanup(func() { _ = os.RemoveAll(dir) })
		if _, err := prepareRuntimeWorkspace(p); err != nil {
			t.Fatalf("prepareRuntimeWorkspace: %v", err)
		}
		raw, err := os.ReadFile(filepath.Join(dir, "vite.config.ts"))
		if err != nil {
			t.Fatalf("baca vite.config.ts workspace: %v", err)
		}
		cfg := string(raw)
		for _, entry := range []string{`"/api": { target: ` + wantTarget, `"/app-files": { target: ` + wantTarget} {
			if !strings.Contains(cfg, entry) {
				t.Fatalf("vite.config.ts workspace harus memuat %s, dapat:\n%s", entry, cfg)
			}
		}
		if n := strings.Count(cfg, "proxy:"); n != 1 {
			t.Fatalf("harapkan tepat 1 kunci proxy:, dapat %d:\n%s", n, cfg)
		}
	}

	t.Run("config tidak ada (default scaffold)", func(t *testing.T) {
		check(t, mkProject("uji-appfiles-default", base))
	})
	t.Run("config hasil model hanya proxy /api", func(t *testing.T) {
		files := map[string]string{}
		for k, v := range base {
			files[k] = v
		}
		files["vite.config.ts"] = "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({ plugins: [react()], server: { allowedHosts: true, proxy: { \"/api\": { target: \"http://127.0.0.1:" + serverPort() + "\", changeOrigin: true } } } });\n"
		check(t, mkProject("uji-appfiles-api-saja", files))
	})
}

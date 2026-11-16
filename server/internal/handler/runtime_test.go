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
	"strconv"
	"strings"
	"testing"
	"time"

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

// Normalisasi tsconfig solution-style di prepareRuntimeWorkspace.
//
// Bentuk hasil model yang pecah di `tsc -b` (proyek uji "Uji Fix B
// 15 Nov", TS 7.0.2): tsconfig.node.json tanpa "include" membuat proyek
// node ikut mengompilasi src/*.tsx tanpa flag jsx -> 12x
// `error TS17004: Cannot use JSX unless the '--jsx' flag is provided`.
// `tsc -p tsconfig.app.json` lolos karena proyek app memang punya jsx.
// Perbaikan: batasi proyek node ke ["vite.config.ts"] (template Vite).
func TestPrepareRuntimeWorkspaceNormalizesSolutionTsconfig(t *testing.T) {
	db := openAgentTestDB(t)
	user := makeAdminUser(t, db, "uji-tsc-b@example.com")
	files := map[string]string{
		"package.json":   `{"name":"uji","private":true,"version":"1.0.0","type":"module","scripts":{"dev":"vite","build":"tsc -b && vite build","preview":"vite preview"},"dependencies":{"react":"latest","react-dom":"latest","vite":"latest","typescript":"latest"}}`,
		"index.html":     "<!doctype html><html><head><meta charset=\"utf-8\"></head><body><div id=\"root\"></div><script type=\"module\" src=\"/src/main.tsx\"></script></body></html>",
		"src/main.tsx":   "import App from './App';\nexport default App;\n",
		"src/App.tsx":    "export default function App() { return <h1>Halo</h1>; }\n",
		"vite.config.ts": "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({ plugins: [react()] });\n",
		// Persis bentuk proyek 3: root solution-style, app lengkap,
		// node composite TANPA include.
		"tsconfig.json":      `{"compilerOptions":{"jsx":"react-jsx"},"files":[],"references":[{"path":"./tsconfig.app.json"},{"path":"./tsconfig.node.json"}]}`,
		"tsconfig.app.json":  `{"compilerOptions":{"target":"ES2020","lib":["ES2020","DOM","DOM.Iterable"],"module":"ESNext","skipLibCheck":true,"moduleResolution":"Bundler","isolatedModules":true,"noEmit":true,"jsx":"react-jsx","strict":true},"include":["src/**/*.ts","src/**/*.tsx"]}`,
		"tsconfig.node.json": `{"compilerOptions":{"composite":true,"skipLibCheck":true,"module":"ESNext","moduleResolution":"Bundler","allowSyntheticDefaultImports":true}}`,
	}
	fj, _ := json.Marshal(files)
	p := models.Project{UserID: user.ID, Name: "Uji Tsc B", Slug: "uji-tsc-b-" + randHex(6), Files: string(fj)}
	if err := db.Create(&p).Error; err != nil {
		t.Fatalf("create project: %v", err)
	}
	dir := projectRuntimeRoot(p.ID)
	t.Cleanup(func() { _ = os.RemoveAll(dir) })

	if _, err := prepareRuntimeWorkspace(&p); err != nil {
		t.Fatalf("prepareRuntimeWorkspace: %v", err)
	}
	// (1) Proyek node dibatasi ke vite.config.ts — ini yang mematikan TS17004.
	raw, err := os.ReadFile(filepath.Join(dir, "tsconfig.node.json"))
	if err != nil {
		t.Fatalf("baca tsconfig.node.json: %v", err)
	}
	var nodeCfg map[string]interface{}
	if err := json.Unmarshal(raw, &nodeCfg); err != nil {
		t.Fatalf("parse tsconfig.node.json: %v", err)
	}
	inc, _ := nodeCfg["include"].([]interface{})
	if len(inc) != 1 || inc[0] != "vite.config.ts" {
		t.Fatalf("harapkan tsconfig.node.json include [vite.config.ts], dapat %v", nodeCfg["include"])
	}
	// Opsi node yang sudah ada tidak boleh berubah.
	opts, _ := nodeCfg["compilerOptions"].(map[string]interface{})
	if opts["composite"] != true {
		t.Fatalf("harapkan tsconfig.node.json composite tetap true, dapat %v", opts["composite"])
	}
	// (2) Proyek app tidak disentuh: jsx yang sudah ada dihormati.
	raw, err = os.ReadFile(filepath.Join(dir, "tsconfig.app.json"))
	if err != nil {
		t.Fatalf("baca tsconfig.app.json: %v", err)
	}
	var appCfg map[string]interface{}
	if err := json.Unmarshal(raw, &appCfg); err != nil {
		t.Fatalf("parse tsconfig.app.json: %v", err)
	}
	appOpts, _ := appCfg["compilerOptions"].(map[string]interface{})
	if appOpts["jsx"] != "react-jsx" {
		t.Fatalf("harapkan tsconfig.app.json jsx tetap react-jsx, dapat %v", appOpts["jsx"])
	}
	// (3) Root solution-style tidak disentuh.
	raw, err = os.ReadFile(filepath.Join(dir, "tsconfig.json"))
	if err != nil {
		t.Fatalf("baca tsconfig.json: %v", err)
	}
	var rootCfg map[string]interface{}
	if err := json.Unmarshal(raw, &rootCfg); err != nil {
		t.Fatalf("parse tsconfig.json: %v", err)
	}
	refs, _ := rootCfg["references"].([]interface{})
	if len(refs) != 2 {
		t.Fatalf("harapkan tsconfig.json references tetap 2, dapat %v", rootCfg["references"])
	}
}

// Varian kedua: tsconfig.app.json TANPA jsx (model hanya menulis jsx di
// root — `tsc -b` tidak mewariskan opsi root ke proyek referensi).
// Normalisasi mengisi "react-jsx"; node yang SUDAH punya include tidak
// ditulis ulang sama sekali.
func TestPrepareRuntimeWorkspaceFillsMissingJsxInAppConfig(t *testing.T) {
	db := openAgentTestDB(t)
	user := makeAdminUser(t, db, "uji-tsc-jsx@example.com")
	nodeCfg := `{"compilerOptions":{"composite":true,"skipLibCheck":true,"module":"ESNext","moduleResolution":"Bundler","allowSyntheticDefaultImports":true},"include":["vite.config.ts"]}`
	files := map[string]string{
		"package.json":       `{"name":"uji","private":true,"version":"1.0.0","type":"module","scripts":{"dev":"vite","build":"tsc -b && vite build","preview":"vite preview"},"dependencies":{"react":"latest","react-dom":"latest","vite":"latest","typescript":"latest"}}`,
		"index.html":         "<!doctype html><html><head><meta charset=\"utf-8\"></head><body><div id=\"root\"></div><script type=\"module\" src=\"/src/main.tsx\"></script></body></html>",
		"src/main.tsx":       "import App from './App';\nexport default App;\n",
		"src/App.tsx":        "export default function App() { return <h1>Halo</h1>; }\n",
		"vite.config.ts":     "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({ plugins: [react()] });\n",
		"tsconfig.json":      `{"files":[],"references":[{"path":"./tsconfig.app.json"},{"path":"./tsconfig.node.json"}]}`,
		"tsconfig.app.json":  `{"compilerOptions":{"target":"ES2020","strict":true,"noEmit":true},"include":["src"]}`,
		"tsconfig.node.json": nodeCfg,
	}
	fj, _ := json.Marshal(files)
	p := models.Project{UserID: user.ID, Name: "Uji Tsc Jsx", Slug: "uji-tsc-jsx-" + randHex(6), Files: string(fj)}
	if err := db.Create(&p).Error; err != nil {
		t.Fatalf("create project: %v", err)
	}
	dir := projectRuntimeRoot(p.ID)
	t.Cleanup(func() { _ = os.RemoveAll(dir) })

	if _, err := prepareRuntimeWorkspace(&p); err != nil {
		t.Fatalf("prepareRuntimeWorkspace: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "tsconfig.app.json"))
	if err != nil {
		t.Fatalf("baca tsconfig.app.json: %v", err)
	}
	var appCfg map[string]interface{}
	if err := json.Unmarshal(raw, &appCfg); err != nil {
		t.Fatalf("parse tsconfig.app.json: %v", err)
	}
	appOpts, _ := appCfg["compilerOptions"].(map[string]interface{})
	if appOpts["jsx"] != "react-jsx" {
		t.Fatalf("harapkan tsconfig.app.json jsx diisi react-jsx, dapat %v", appOpts["jsx"])
	}
	if appOpts["strict"] != true || appOpts["noEmit"] != true {
		t.Fatalf("opsi app yang sudah ada tidak boleh berubah: %v", appOpts)
	}
	// Node sudah benar -> file tidak ditulis ulang (byte-identik).
	raw, err = os.ReadFile(filepath.Join(dir, "tsconfig.node.json"))
	if err != nil {
		t.Fatalf("baca tsconfig.node.json: %v", err)
	}
	if string(raw) != nodeCfg {
		t.Fatalf("tsconfig.node.json yang sudah benar tidak boleh ditulis ulang, dapat %s", string(raw))
	}
}

// Edge case normalizeSolutionTsconfigs: referensi ke luar workspace,
// file referensi hilang, dan JSON rusak semuanya dilewati tanpa panic;
// root tanpa references = no-op.
func TestNormalizeSolutionTsconfigsSkipsUnsafeRefs(t *testing.T) {
	dir := t.TempDir()
	write := func(name, content string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0644); err != nil {
			t.Fatalf("tulis %s: %v", name, err)
		}
	}
	write("tsconfig.json", `{"files":[],"references":[{"path":"./tsconfig.node.json"},{"path":"../evil.json"},{"path":"./hilang.json"},{"path":"./rusak.json"}]}`)
	write("tsconfig.node.json", `{"compilerOptions":{"composite":true}}`)
	write("rusak.json", `{bukan json`)
	// File di luar workspace: normalisasi tidak boleh menyentuhnya.
	if err := os.WriteFile(filepath.Join(dir, "..", "evil.json"), []byte(`{"compilerOptions":{}}`), 0644); err != nil {
		t.Fatalf("tulis evil: %v", err)
	}
	t.Cleanup(func() { _ = os.Remove(filepath.Join(dir, "..", "evil.json")) })

	normalizeSolutionTsconfigs(dir) // tidak boleh panic

	raw, err := os.ReadFile(filepath.Join(dir, "tsconfig.node.json"))
	if err != nil {
		t.Fatalf("baca tsconfig.node.json: %v", err)
	}
	var nodeCfg map[string]interface{}
	if err := json.Unmarshal(raw, &nodeCfg); err != nil {
		t.Fatalf("parse tsconfig.node.json: %v", err)
	}
	inc, _ := nodeCfg["include"].([]interface{})
	if len(inc) != 1 || inc[0] != "vite.config.ts" {
		t.Fatalf("harapkan node include [vite.config.ts], dapat %v", nodeCfg["include"])
	}
	evil, _ := os.ReadFile(filepath.Join(dir, "..", "evil.json"))
	if string(evil) != `{"compilerOptions":{}}` {
		t.Fatalf("referensi ke luar workspace tidak boleh disentuh, dapat %s", string(evil))
	}
	// Root tanpa references dan root JSON rusak = no-op, tanpa panic.
	write("tsconfig.json", `{"compilerOptions":{"jsx":"react-jsx"},"include":["src"]}`)
	normalizeSolutionTsconfigs(dir)
	write("tsconfig.json", `{rusak`)
	normalizeSolutionTsconfigs(dir)
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
// Unit: rewritePreviewAssetURLs menempeli prefix proxy + token preview
// ke URL aset HTML, tanpa menggandakan prefix yang sudah ada (Vite
// --base) dan tanpa merusak URL yang sudah punya query.
func TestRewritePreviewAssetURLs(t *testing.T) {
	const prefix = "/api/projects/1/runtime/preview"
	const token = "pv_test123"
	html := `<script type="module" src="/src/main.tsx"></script>` +
		`<script type="module" src="/@vite/client"></script>` +
		`<link rel="stylesheet" href="/src/index.css?v=1">` +
		`<img src="` + prefix + `/assets/hero.png">` +
		`<div style="background: url(/assets/bg.png)"></div>` +
		`<img src="">`
	got := rewritePreviewAssetURLs(html, prefix, token)
	for _, want := range []string{
		`src="` + prefix + `/src/main.tsx?token=` + token + `"`,
		`src="` + prefix + `/@vite/client?token=` + token + `"`,
		`href="` + prefix + `/src/index.css?v=1&token=` + token + `"`,
		// Sudah berprefix: jangan digandakan, cukup tempeli token.
		`src="` + prefix + `/assets/hero.png?token=` + token + `"`,
		`url(` + prefix + `/assets/bg.png?token=` + token + `)`,
		`src=""`,
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("hasil harus memuat %s, dapat:\n%s", want, got)
		}
	}
	if n := strings.Count(got, prefix); n != 5 {
		t.Fatalf("harapkan prefix tepat 5 kali, dapat %d:\n%s", n, got)
	}
	// Tanpa token: prefix tetap ditempel, tanpa ?token=.
	plain := rewritePreviewAssetURLs(`<script src="/src/main.tsx"></script>`, prefix, "")
	if !strings.Contains(plain, `src="`+prefix+`/src/main.tsx"`) || strings.Contains(plain, "token=") {
		t.Fatalf("tanpa token harus hanya prefix, dapat:\n%s", plain)
	}
}

// Unit: dev server Vite dijalankan dengan --base prefix proxy preview
// (hanya dev — build production tidak memakai flag ini).
func TestRuntimeDevCommandBase(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{"name":"x","scripts":{"dev":"vite"}}`), 0644); err != nil {
		t.Fatal(err)
	}
	_, args := runtimeDevCommand(dir, 19001, 1)
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "--base /api/projects/1/runtime/preview/") {
		t.Fatalf("argumen harus memuat --base prefix preview, dapat: %s", joined)
	}
}

// Unit: writeFileIfChanged hanya menulis bila isi berubah — sync()
// berulang tanpa perubahan file tidak boleh menyentuh mtime (Vite
// me-restart dev server pada setiap penulisan vite.config.ts /
// .env.local, dan restart itu membuat request iframe gagal 502).
func TestWriteFileIfChanged(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "a.txt")
	if err := writeFileIfChanged(p, []byte("satu"), 0644); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(p)
	if string(b) != "satu" {
		t.Fatalf("file baru harus ditulis, dapat %q", b)
	}
	st1, _ := os.Stat(p)
	time.Sleep(1100 * time.Millisecond)
	// Isi sama: tidak ditulis ulang (mtime tetap).
	if err := writeFileIfChanged(p, []byte("satu"), 0644); err != nil {
		t.Fatal(err)
	}
	st2, _ := os.Stat(p)
	if !st1.ModTime().Equal(st2.ModTime()) {
		t.Fatalf("isi sama tidak boleh menulis ulang (mtime berubah %v -> %v)", st1.ModTime(), st2.ModTime())
	}
	// Isi berubah: ditulis.
	if err := writeFileIfChanged(p, []byte("dua"), 0644); err != nil {
		t.Fatal(err)
	}
	b, _ = os.ReadFile(p)
	if string(b) != "dua" {
		t.Fatalf("isi berubah harus ditulis, dapat %q", b)
	}
}

func TestEnsureViteDevProxy(t *testing.T) {
	const port = "18093"
	const previewPrefix = "/api/projects/1/runtime/preview"
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
			// Entri /api tanpa bypass harus DITAMBAH bypass-nya (tanpa itu
			// Vite memantulkan permintaan preview balik ke server Go
			// tanpa token dan preview 401 — trek wb265-preview-empty).
			"sudah lengkap tanpa bypass",
			"export default defineConfig({ plugins: [react()], server: { allowedHosts: true, proxy: { \"/api\": { target: \"http://127.0.0.1:18093\", changeOrigin: true }, \"/app-files\": { target: \"http://127.0.0.1:18093\", changeOrigin: true } } } });",
		},
		{
			// Bypass lama (mengembalikan false) harus DIPERBARUI: di
			// Vite 5, false dijawab 404 kosong, bukan dilayani sendiri.
			"sudah lengkap dengan bypass lama",
			"export default defineConfig({ plugins: [react()], server: { allowedHosts: true, proxy: { \"/api\": { target: \"http://127.0.0.1:18093\", changeOrigin: true, bypass: (req) => (req.url || \"\").startsWith(\"/api/projects/1/runtime/preview\") ? false : undefined }, \"/app-files\": { target: \"http://127.0.0.1:18093\", changeOrigin: true } } } });",
		},
		{
			"sudah lengkap dengan bypass benar",
			"export default defineConfig({ plugins: [react()], server: { allowedHosts: true, proxy: { \"/api\": { target: \"http://127.0.0.1:18093\", changeOrigin: true, bypass: (req) => (req.url || \"\").startsWith(\"/api/projects/1/runtime/preview\") ? req.url : undefined }, \"/app-files\": { target: \"http://127.0.0.1:18093\", changeOrigin: true } } } });",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ensureViteDevProxy(tc.in, port, previewPrefix)
			for _, entry := range []string{`"/api": { target: ` + target, `"/app-files": { target: ` + target} {
				if !strings.Contains(got, entry) {
					t.Fatalf("hasil harus memuat %s, dapat:\n%s", entry, got)
				}
			}
			// Entri /api wajib membawa bypass prefix preview (yang
			// mengembalikan req.url — bukan false, yang di Vite 5
			// dijawab 404 kosong).
			if !strings.Contains(got, `bypass: (req) => (req.url || "").startsWith("`+previewPrefix+`") ? req.url : undefined`) {
				t.Fatalf("entri /api harus memuat bypass prefix preview, dapat:\n%s", got)
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
			if again := ensureViteDevProxy(got, port, previewPrefix); again != got {
				t.Fatalf("tidak idempotent, aplikasi kedua mengubah:\n%s", again)
			}
			// Kasus "sudah lengkap dengan bypass benar" tidak boleh diubah sama sekali.
			if tc.name == "sudah lengkap dengan bypass benar" && got != tc.in {
				t.Fatalf("config yang sudah lengkap harus dibiarkan apa adanya, dapat:\n%s", got)
			}
		})
	}
}

// Integrasi: prepareRuntimeWorkspace menulis vite.config.ts workspace
// dengan proxy /app-files, baik saat file tidak ada (default scaffold)
// maupun saat config hasil model hanya mem-proxy /api.
// Integrasi: sync() berulang tanpa perubahan file DB tidak boleh menulis
// ulang vite.config.ts / .env.local — setiap penulisan me-restart Vite
// dan request iframe yang sedang dimuat gagal 502 (trek
// wb265-preview-empty). Termasuk kasus vite.config.ts DB yang belum
// ter-patch: workspace menyimpan versi ter-patch, dan sync kedua harus
// mengenalinya sebagai sudah sinkron.
func TestPrepareRuntimeWorkspaceSyncIsIdempotent(t *testing.T) {
	db := openAgentTestDB(t)
	user := makeAdminUser(t, db, "uji-sync-idempotent@example.com")
	files := map[string]string{
		"package.json":    `{"name":"uji","private":true,"version":"0.0.0","type":"module"}`,
		"index.html":      `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>`,
		"src/main.tsx":    "import App from './App';\nexport default App;\n",
		"src/App.tsx":     "export default function App() { return <h1>Halo</h1>; }\n",
		"vite.config.ts":  "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({ plugins: [react()], server: { allowedHosts: true, proxy: { \"/api\": { target: \"http://127.0.0.1:" + serverPort() + "\", changeOrigin: true } } } });\n",
	}
	fj, _ := json.Marshal(files)
	p := models.Project{UserID: user.ID, Name: "uji-sync-idempotent", Slug: "uji-sync-idempotent-" + randHex(6), Files: string(fj)}
	if err := db.Create(&p).Error; err != nil {
		t.Fatalf("create project: %v", err)
	}
	dir := projectRuntimeRoot(p.ID)
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	if _, err := prepareRuntimeWorkspace(&p); err != nil {
		t.Fatalf("prepare pertama: %v", err)
	}
	cfgPath := filepath.Join(dir, "vite.config.ts")
	envPath := filepath.Join(dir, ".env.local")
	// vite.config.ts workspace harus membawa bypass prefix preview.
	cfg, _ := os.ReadFile(cfgPath)
	if !strings.Contains(string(cfg), `bypass: (req) => (req.url || "").startsWith("/api/projects/`+strconv.Itoa(int(p.ID))+`/runtime/preview") ? req.url : undefined`) {
		t.Fatalf("vite.config.ts workspace harus memuat bypass preview, dapat:\n%s", cfg)
	}
	stCfg1, _ := os.Stat(cfgPath)
	stEnv1, _ := os.Stat(envPath)
	time.Sleep(1100 * time.Millisecond)
	if _, err := prepareRuntimeWorkspace(&p); err != nil {
		t.Fatalf("prepare kedua: %v", err)
	}
	stCfg2, _ := os.Stat(cfgPath)
	stEnv2, _ := os.Stat(envPath)
	if !stCfg1.ModTime().Equal(stCfg2.ModTime()) {
		t.Fatalf("sync kedua tidak boleh menulis ulang vite.config.ts (mtime %v -> %v)", stCfg1.ModTime(), stCfg2.ModTime())
	}
	if !stEnv1.ModTime().Equal(stEnv2.ModTime()) {
		t.Fatalf("sync kedua tidak boleh menulis ulang .env.local (mtime %v -> %v)", stEnv1.ModTime(), stEnv2.ModTime())
	}
}

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

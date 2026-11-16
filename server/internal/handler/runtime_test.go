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

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

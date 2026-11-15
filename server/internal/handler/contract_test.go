package handler

import (
	"strings"
	"testing"
)

func validTSProject() map[string]string {
	return map[string]string{
		"package.json":   `{"name":"app","dependencies":{"react":"^18.3.1"}}`,
		"tsconfig.json":  `{"compilerOptions":{"strict":true,"jsx":"react-jsx"}}`,
		"vite.config.ts": `export default {}`,
		"index.html":     `<div id="root"></div><script type="module" src="/src/main.tsx"></script>`,
		"src/main.tsx":   `import App from "./App";`,
		"src/App.tsx":       `export default function App(){return null}`,
		"src/pages/Home.tsx": `export default function Home(){return null}`,
		"src/index.css":      `:root{font-family:Inter}`,
		"src/vite-env.d.ts":  `/// <reference types="vite/client" />`,
		".env.example":       `VITE_API_BASE_URL=http://localhost:18082`,
		"README.md":           `# App`,
		"docs/plan.md":        `# Plan`,
		"docs/architecture.md": `# Architecture`,
		"docs/data-model.md":  `# Data model`,
		"docs/acceptance.md":   `# Acceptance`,
	}
}

func TestContractAcceptsRealApp(t *testing.T) {
	if issues := validateProjectContract(validTSProject()); len(issues) != 0 {
		t.Fatalf("proyek TS sah malah ditolak: %v", issues)
	}
}

func TestContractRejectsSingleFileHTML(t *testing.T) {
	files := map[string]string{
		"index.html": `<html><body><div id="app"></div><script>
			const app = document.getElementById("app"); app.innerHTML = "<h1>Halo</h1>";
		</script></body></html>`,
	}
	issues := validateProjectContract(files)
	joined := strings.Join(issues, " | ")
	for _, want := range []string{"package.json", "src/main.tsx", "script> inline"} {
		if !strings.Contains(joined, want) {
			t.Errorf("pelanggaran %q tidak terdeteksi; dapat: %s", want, joined)
		}
	}
}

func TestContractRejectsJavaScriptInSrc(t *testing.T) {
	files := validTSProject()
	files["src/utils/format.js"] = "export const x = 1;"
	issues := validateProjectContract(files)
	if !strings.Contains(strings.Join(issues, "|"), "src/utils/format.js") {
		t.Fatalf("file .js di src tidak ditolak: %v", issues)
	}
}

func TestContractRejectsTooFewTypeScriptFiles(t *testing.T) {
	files := map[string]string{
		"package.json": "{}", "tsconfig.json": "{}", "vite.config.ts": "export default {}",
		"index.html":   `<div id="root"></div><script type="module" src="/src/main.tsx"></script>`,
		"src/main.tsx": "import App from './App'",
		"src/App.tsx":  "export default function App(){return null}",
	}
	if issues := validateProjectContract(files); !strings.Contains(strings.Join(issues, "|"), "file TypeScript") {
		t.Fatalf("proyek 2 file TS seharusnya ditandai: %v", issues)
	}
}

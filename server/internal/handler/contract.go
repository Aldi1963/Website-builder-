package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"gorm.io/gorm"

	"webbuilder/internal/database/models"
)

// Kontrak proyek: hasil generate WAJIB berupa aplikasi Vite + React + TypeScript
// multi-file. Tanpa pemeriksaan ini model kadang mengembalikan satu file HTML
// dengan <script> inline — cepat terlihat jadi, tapi bukan aplikasi.
var requiredProjectFiles = []string{
	"package.json", "tsconfig.json", "vite.config.ts",
	"index.html", "src/main.tsx", "src/App.tsx",
	"src/index.css", "src/vite-env.d.ts", ".env.example", "README.md",
	"docs/plan.md", "docs/architecture.md", "docs/data-model.md", "docs/acceptance.md",
}

// enterpriseProject mendeteksi monorepo SaaS yang memisahkan web/api/worker.
func enterpriseProject(files map[string]string) bool {
	markers := 0
	for _, name := range []string{"pnpm-workspace.yaml", "apps/web/package.json", "apps/api/package.json", "packages/shared-types/package.json", "packages/database/prisma/schema.prisma", "prisma/schema.prisma"} {
		if strings.TrimSpace(files[name]) != "" { markers++ }
	}
	return markers >= 2 || strings.TrimSpace(files["apps/web/src/main.tsx"]) != ""
}

// validateProjectContract mengembalikan daftar pelanggaran (kosong = lolos).
func validateProjectContract(files map[string]string) []string {
	var issues []string
	enterprise := enterpriseProject(files)
	required := requiredProjectFiles
	if enterprise {
		required = []string{"package.json", "tsconfig.base.json", "apps/web/package.json", "apps/web/app/layout.tsx", "apps/web/app/page.tsx", "apps/api/src/main.ts", "packages/database/prisma/schema.prisma", "pnpm-workspace.yaml"}
	}
	for _, name := range required {
		if strings.TrimSpace(files[name]) == "" {
			issues = append(issues, "file wajib belum ada: "+name)
		}
	}
	html := files["index.html"]
	if enterprise && strings.TrimSpace(files["apps/web/index.html"]) != "" { html = files["apps/web/index.html"] }
	if strings.TrimSpace(html) != "" {
		trimmed := strings.TrimSpace(html)
		if !strings.Contains(trimmed, "/src/main.tsx") {
			issues = append(issues, "index.html tidak memuat <script type=\"module\" src=\"/src/main.tsx\">")
		}
		if len(trimmed) > 2500 {
			issues = append(issues, fmt.Sprintf("index.html terlalu besar (%d byte) — UI harus di src/, bukan di HTML", len(trimmed)))
		}
		// Script inline tanpa src = aplikasi ditulis di dalam HTML.
		// (RE2 tidak punya lookahead, jadi periksa atribut setiap tag <script>.)
		tagRe := regexp.MustCompile(`(?i)<script([^>]*)>`)
		for _, m := range tagRe.FindAllStringSubmatch(trimmed, -1) {
			attrs := strings.ToLower(m[1])
			if strings.Contains(attrs, "src=") || strings.Contains(attrs, "application/ld+json") {
				continue
			}
			issues = append(issues, "index.html berisi <script> inline — kode aplikasi harus di file .tsx")
			break
		}
	}
	// Kode aplikasi di src/ wajib TypeScript.
	var jsFiles []string
	tsxCount := 0
	sourceRoots := []string{"src/"}
	if enterprise { sourceRoots = []string{"apps/web/src/", "apps/api/src/", "apps/worker/src/", "packages/"} }
	for name := range files {
		lower := strings.ToLower(name)
		inSource := false
		for _, root := range sourceRoots { if strings.HasPrefix(lower, root) { inSource = true; break } }
		if !inSource { continue }
		if strings.HasSuffix(lower, ".js") || strings.HasSuffix(lower, ".jsx") { jsFiles = append(jsFiles, name) }
		if strings.HasSuffix(lower, ".tsx") || strings.HasSuffix(lower, ".ts") { tsxCount++ }
	} 
	if enterprise {
		for _, name := range []string{"apps/api/src/main.ts", "apps/worker/src/main.ts", "packages/shared-types/package.json", "packages/database/prisma/schema.prisma", "pnpm-workspace.yaml", "README.md"} {
			if strings.TrimSpace(files[name]) == "" { issues = append(issues, "file enterprise wajib belum ada: "+name) }
		}
	}
	sort.Strings(jsFiles)
	if len(jsFiles) > 0 {
		issues = append(issues, "file JavaScript di src/ (harus .ts/.tsx): "+strings.Join(jsFiles, ", "))
	}
	if tsxCount < 3 {
		issues = append(issues, fmt.Sprintf("hanya %d file TypeScript — aplikasi harus dipecah ke beberapa file .tsx/.ts", tsxCount))
	}
	return issues
}

// ensureProjectScaffolding menambahkan file operasional non-secret yang sering
// dilupakan model. File ini tetap terlihat di Code dan ikut ke workspace.
func ensureProjectScaffolding(files map[string]string) []string {
	added := []string{}
	defaults := map[string]string{
		".env.example": "VITE_API_BASE_URL=http://localhost:18082\nVITE_APP_NAME=WebBuilder App\n# Secret hanya di .env.local; jangan commit credential.\n",
		"README.md": `# WebBuilder App

> A production-ready React + TypeScript application generated and verified by WebBuilder.

[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-5-646CFF)](https://vitejs.dev/)
[![Status](https://img.shields.io/badge/status-in%20development-orange)](./docs/acceptance.md)

## Overview

WebBuilder App is a modular, responsive web application. The UI is composed of typed React components, business logic lives in services, and persistent data is accessed through the project data layer. This repository is intended to be opened and continued like a normal VS Code project.

## Product scope

- **Users and roles:** See [the product plan](./docs/plan.md) for the target users, permissions, and assumptions.
- **Main flows:** Authentication, navigation, data entry, loading/error/empty states, and the primary business workflow are documented in the project docs.
- **Data:** Tables, fields, relationships, indexes, and access rules are documented in [data-model.md](./docs/data-model.md).

## Tech stack

- React + TypeScript with strict type checking
- Vite for local development and production bundling
- Typed service layer for authentication and persistence
- PostgreSQL-backed project data when database features are enabled
- Mobile-first responsive UI

## Quick start

### Requirements

- Node.js 20 or newer
- npm 10 or pnpm 9, depending on the package manager in package.json

### Install and run

--- bash ---
npm install
npm run dev
---

Open the local URL printed by Vite. For a clean production check:

--- bash ---
npm run typecheck
npm run build
npm run preview
---

## Environment

Copy env.example to env.local for local-only configuration. Never commit env files, passwords, API keys, database URLs, or other secrets.

| Variable | Purpose | Example |
| --- | --- | --- |
| VITE_APP_NAME | Browser application name | WebBuilder App |
| VITE_API_BASE_URL | API base URL | http://localhost:18082 |

## Project structure

---text
src/
  components/   Reusable UI components
  pages/        Route-level screens
  services/     Auth and data access
  hooks/        Reusable React hooks
  interfaces/   Shared TypeScript contracts
  utils/        Formatting and pure helpers
  App.tsx       Application shell and routes
  main.tsx      Vite entry point
public/         Static assets and project SDK
public/wb-cloud.js  Project auth and database client
---

See docs/architecture.md for the data flow and module boundaries.

## Scripts

| Command | Purpose |
| --- | --- |
| npm run dev | Start the development server |
| npm run typecheck | Validate TypeScript without emitting files |
| npm run lint | Check code quality when configured |
| npm run test | Run automated tests when configured |
| npm run build | Create the production bundle |

## Verification checklist

The generated application is considered ready only after the checks in docs/acceptance.md pass: dependency install, TypeScript validation, production build, authentication, the primary mutation flow, persistence, mobile layout, and runtime preview.

## Development workflow

1. Read the plan and architecture docs before changing a feature.
2. Update the typed interface and service/data contract first.
3. Implement the page and loading, error, and empty states.
4. Run typecheck and build before opening a review.
5. Update the relevant docs when roles, routes, schema, or environment variables change.

## Troubleshooting

- If dependencies are missing, run npm install again and check the Node.js version.
- If the app loads without data, verify env.local, the project session, and the database migration status.
- If a build fails, fix the first TypeScript or Vite error, then rerun the complete verification checklist.
- Do not put secrets in browser-exposed VITE_* values.

## Documentation

- [Product plan](./docs/plan.md)
- [Architecture](./docs/architecture.md)
- [Data model](./docs/data-model.md)
- [Acceptance criteria](./docs/acceptance.md)
`,
		"src/vite-env.d.ts": "/// <reference types=\"vite/client\" />\n",
		"src/index.css": "@tailwind base;\n@tailwind components;\n@tailwind utilities;\n\n:root { font-family: Inter, system-ui, sans-serif; }\n",
		"docs/plan.md": "# Product plan\n\n## Tujuan\nDokumen ini menjelaskan tujuan, pengguna, dan scope aplikasi.\n\n## Scope versi pertama\n- Alur utama aplikasi\n- Auth dan role\n- Data persistence\n",
		"docs/architecture.md": "# Architecture\n\n## Overview\nReact + TypeScript + Vite dengan service layer untuk auth dan data.\n\n## Boundaries\nUI memanggil service ter-typed; secret hanya di environment server.\n",
		"docs/data-model.md": "# Data model\n\nCatat tabel, kolom, relationship, index, dan aturan akses yang dipakai aplikasi.\n",
		"docs/acceptance.md": "# Acceptance criteria\n\n- Install dependency\n- TypeScript check\n- Production build\n- Auth dan alur utama\n- Mobile responsive\n",
	}
	for name, content := range defaults {
		// README dan dokumentasi yang terlalu pendek biasanya berasal dari
		// scaffold lama. Upgrade otomatis agar Code selalu terasa seperti repo
		// sungguhan, bukan sekadar README satu paragraf.
		minLen := 0
		if name == "README.md" {
			minLen = 800
		}
		if strings.TrimSpace(files[name]) == "" || len(strings.TrimSpace(files[name])) < minLen {
			files[name] = content
			added = append(added, name)
		}
	}
	sort.Strings(added)
	return added
}

// contractViolated cepat: apakah perlu perbaikan.
func contractViolated(files map[string]string) bool { return len(validateProjectContract(files)) > 0 }

// enforceProjectContract meminta model mengonversi hasil menjadi proyek
// React+TypeScript yang sah. Satu percobaan saja; kalau masih gagal, hasil
// dibiarkan apa adanya tapi dilaporkan agar admin tahu.
func enforceProjectContract(db *gorm.DB, p *models.Project, provider *AIProvider) ([]string, []string, error) {
	files := map[string]string{}
	if err := json.Unmarshal([]byte(p.Files), &files); err != nil {
		return nil, nil, fmt.Errorf("file project tidak terbaca")
	}
	issues := validateProjectContract(files)
	if len(issues) == 0 {
		return nil, nil, nil
	}

	// Kirim hanya file yang relevan agar konteks tidak meledak.
	priority := []string{"index.html", "src/main.tsx", "src/App.tsx", "package.json", "tsconfig.json", "vite.config.ts"}
	seen := map[string]bool{}
	var order []string
	for _, n := range priority {
		if _, ok := files[n]; ok {
			order = append(order, n)
			seen[n] = true
		}
	}
	var rest []string
	for n := range files {
		if !seen[n] {
			rest = append(rest, n)
		}
	}
	sort.Strings(rest)
	order = append(order, rest...)
	if len(order) > 12 {
		order = order[:12]
	}

	var dump strings.Builder
	for _, n := range order {
		content := files[n]
		if len(content) > 6000 {
			content = content[:6000] + "\n…dipotong"
		}
		dump.WriteString("<<<FILE: " + n + ">>>\n" + content + "\n<<<END>>>\n")
	}

	msg := "PROYEK INI BELUM MEMENUHI KONTRAK APLIKASI. Ubah menjadi aplikasi Vite + React + TypeScript yang sah.\n\n" +
		"PELANGGARAN:\n- " + strings.Join(issues, "\n- ") + "\n\n" +
		"ATURAN KERAS:\n" +
		"- index.html hanya bootstrap: <div id=\"root\"></div> + <script type=\"module\" src=\"/src/main.tsx\"></script>. Tanpa <script> inline, tanpa UI di HTML.\n" +
		"- Semua kode aplikasi di src/ sebagai .tsx/.ts (TypeScript, bukan .js/.jsx), dipecah ke components/, pages/, services/, hooks/.\n" +
		"- package.json memakai react, react-dom, vite, @vitejs/plugin-react, typescript; tsconfig.json dengan jsx: react-jsx, strict: true.\n" +
		"- Pertahankan fitur & desain yang sudah ada; pindahkan logika dari HTML ke komponen React.\n" +
		"- Kembalikan HANYA file yang berubah/baru, lengkap, dengan format <<<FILE: path>>>...<<<END>>>.\n\n" +
		"FILE SAAT INI:\n" + dump.String()

	sys := "You convert projects into strict React + TypeScript (Vite) apps. Never output single-file HTML. Respond in Indonesian for any prose."
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()

	out := ""
	if err := provider.streamChatWithHistory(ctx, sys, nil, msg, "", func(chunk string) { out += chunk }); err != nil {
		return issues, nil, err
	}
	newFiles := parseFileBlocks(out, files)
	changed := []string{}
	for name, content := range newFiles {
		if files[name] != content {
			changed = append(changed, name)
		}
	}
	if len(changed) == 0 {
		return issues, nil, nil
	}
	fj, _ := json.Marshal(newFiles)
	db.Model(p).Update("files", string(fj))
	db.Create(&models.ProjectVersion{ProjectID: p.ID, Label: "Kontrak TypeScript (" + itoa(len(changed)) + " file)", Files: string(fj)})
	return issues, changed, nil
}

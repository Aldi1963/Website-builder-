// Command generate-openapi membangkitkan server/openapi.yaml (dan blok rute
// di packages/types/src/index.ts) dari route Gin yang benar-benar
// terdaftar — bukan dari tebakan atau dokumentasi yang sudah basi.
//
// Cara pakai (kanonik):
//
//	cd server && go run ./cmd/generate-openapi
//
// Generator ini hanya MEMBACA route: ia membangun engine Gin yang sama
// dengan server (handler.RegisterRoutes + 4 rute publik di server/main.go),
// lalu memanggil engine.Routes(). Tidak ada endpoint yang diubah, tidak ada
// perilaku live yang disentuh. Output deterministik: route diurutkan, tidak
// ada timestamp, jalankan dua kali hasilnya identik byte-per-byte.
//
// Yang sengaja TIDAK masuk spec:
//   - GET / dan NoRoute (SPA fallback) serta /assets (file statis) —
//     bukan API.
//   - Skema request/response: handler memakai struct anonim per endpoint,
//     jadi spec ini adalah inventaris route + parameter path + model auth,
//     bukan kontrak body. Bila suatu endpoint butuh skema body, tambahkan
//     secara eksplisit di docs/api-contracts.md, jangan ditebak generator.
//
// Hermetic: generator memakai HOME sementara + WEBBUILDER_KEY dummy supaya
// tidak membaca/menulis ~/.webbuilder-key milik developer.
package main

import (
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"webbuilder/internal/handler"

	"github.com/gin-gonic/gin"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

// authKind mengklasifikasikan model autentikasi satu route.
type authKind string

const (
	authPublic         authKind = "public"          // tanpa auth
	authJWTOrAPIKey    authKind = "jwt-or-apikey"   // JWT builder atau API key wb_* via Authorization: Bearer
	authProjectSession authKind = "project-session" // header X-Project-Session (sesi aplikasi hasil generate)
)

type route struct {
	Method string
	Path   string // path OpenAPI: :id -> {id}, *filepath -> {filepath}
	Auth   authKind
	Params []string // nama parameter path, sesuai urutan di path
}

var methodOrder = map[string]int{
	"GET": 0, "POST": 1, "PUT": 2, "PATCH": 3, "DELETE": 4,
	"HEAD": 5, "OPTIONS": 6, "CONNECT": 7, "TRACE": 8,
}

func classifyAuth(path string) authKind {
	switch {
	case path == "/api/health",
		path == "/healthz",
		path == "/readyz",
		path == "/metrics",
		path == "/api/public-settings",
		path == "/api/billing/webhook",
		strings.HasPrefix(path, "/api/auth/"),
		strings.HasPrefix(path, "/f/"),
		strings.HasPrefix(path, "/app-files/"),
		strings.HasPrefix(path, "/api/app-api/") && strings.Contains(path, "/auth/"),
		strings.HasPrefix(path, "/pub/"),
		strings.HasPrefix(path, "/pub-assets/"),
		strings.HasPrefix(path, "/share/"),
		strings.HasPrefix(path, "/share-assets/"):
		return authPublic
	case strings.HasPrefix(path, "/api/app-api/") && strings.Contains(path, "/db/"):
		return authProjectSession
	default:
		return authJWTOrAPIKey
	}
}

// ginPathToOpenAPI mengubah /api/projects/:id/chat dan
// /pub-assets/:slug/*filepath menjadi /api/projects/{id}/chat dan
// /pub-assets/{slug}/{filepath}.
func ginPathToOpenAPI(p string) (string, []string) {
	parts := strings.Split(p, "/")
	var params []string
	for i, seg := range parts {
		switch {
		case strings.HasPrefix(seg, ":"):
			name := seg[1:]
			params = append(params, name)
			parts[i] = "{" + name + "}"
		case strings.HasPrefix(seg, "*"):
			name := seg[1:]
			params = append(params, name)
			parts[i] = "{" + name + "}"
		}
	}
	return strings.Join(parts, "/"), params
}

func titleCase(s string) string {
	if s == "" {
		return ""
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// operationID: POST /api/projects/:id/chat -> postApiProjectsIdChat.
// Unik karena (method, path) unik di Gin.
func operationID(method, ginPath string) string {
	var b strings.Builder
	b.WriteString(strings.ToLower(method))
	for _, seg := range strings.Split(ginPath, "/") {
		if seg == "" {
			continue
		}
		seg = strings.TrimPrefix(seg, ":")
		seg = strings.TrimPrefix(seg, "*")
		// buang karakter non-alnum (mis. -, _)
		clean := strings.Map(func(r rune) rune {
			if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
				return r
			}
			return -1
		}, seg)
		b.WriteString(titleCase(clean))
	}
	return b.String()
}

func collectRoutes() []route {
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open("file:openapi?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		fatalf("buka sqlite in-memory: %v", err)
	}
	r := gin.New()
	handler.RegisterRoutes(r, db)
	// Rute publik di server/main.go (di luar RegisterRoutes).
	r.GET("/pub/:slug", handler.ServePublished(db))
	r.GET("/pub-assets/:slug/*filepath", handler.ServePublishedAsset(db))
	r.GET("/share/:token", handler.ServeShared(db))
	r.GET("/share-assets/:token/:filepath", handler.ServeSharedAsset(db))

	var out []route
	for _, ri := range r.Routes() {
		p, params := ginPathToOpenAPI(ri.Path)
		out = append(out, route{Method: ri.Method, Path: p, Auth: classifyAuth(ri.Path), Params: params})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Path != out[j].Path {
			return out[i].Path < out[j].Path
		}
		return methodOrder[out[i].Method] < methodOrder[out[j].Method]
	})
	return out
}

// yamlQuote mengutip string bila mengandung karakter yang butuh quoting YAML.
func yamlQuote(s string) string {
	if s == "" {
		return `""`
	}
	safe := true
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' ||
			r == '/' || r == '-' || r == '_' || r == '.' || r == '{' || r == '}' || r == ' ') {
			safe = false
		}
	}
	if safe {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}

// yamlText selalu mengutip teks bebas (deskripsi/summary) dengan single
// quote YAML, karena teks boleh mengandung ": " yang merusak plain scalar.
func yamlText(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}

func renderYAML(routes []route) string {
	var b strings.Builder
	b.WriteString("# GENERATED — jangan edit manual. Regenerasi: cd server && go run ./cmd/generate-openapi\n")
	b.WriteString("# Sumber: route Gin (handler.RegisterRoutes + rute publik di server/main.go).\n")
	b.WriteString("# Lihat docs/api-contracts.md untuk cara kerja dan batasannya.\n")
	b.WriteString("openapi: 3.0.3\n")
	b.WriteString("info:\n")
	b.WriteString("  title: WebBuilder API\n")
	b.WriteString("  version: 0.1.0\n")
	b.WriteString("  description: " + yamlText("API builder WebBuilder (build.clipku.my.id). Spec ini adalah inventaris route + parameter path + model auth; skema body tidak dimodelkan (lihat docs/api-contracts.md).") + "\n")
	b.WriteString("servers:\n")
	b.WriteString("  - url: https://build.clipku.my.id\n")
	b.WriteString("paths:\n")
	lastPath := ""
	for _, rt := range routes {
		if rt.Path != lastPath {
			b.WriteString("  " + yamlQuote(rt.Path) + ":\n")
			lastPath = rt.Path
		}
		method := strings.ToLower(rt.Method)
		b.WriteString("    " + method + ":\n")
		b.WriteString("      operationId: " + operationID(rt.Method, rt.Path) + "\n")
		b.WriteString("      x-auth: " + string(rt.Auth) + "\n")
		b.WriteString("      summary: " + yamlText(rt.Method+" "+rt.Path) + "\n")
		if rt.Auth == authJWTOrAPIKey {
			b.WriteString("      security:\n")
			b.WriteString("        - bearerAuth: []\n")
		}
		if len(rt.Params) > 0 {
			b.WriteString("      parameters:\n")
			for _, p := range rt.Params {
				b.WriteString("        - name: " + p + "\n")
				b.WriteString("          in: path\n")
				b.WriteString("          required: true\n")
				b.WriteString("          schema:\n")
				b.WriteString("            type: string\n")
			}
		}
		b.WriteString("      responses:\n")
		b.WriteString("        '200':\n")
		b.WriteString("          description: OK\n")
		if rt.Auth == authJWTOrAPIKey {
			b.WriteString("        '401':\n")
			b.WriteString("          description: Unauthorized — token JWT / API key tidak valid atau tidak ada\n")
		}
		if rt.Auth == authProjectSession {
			b.WriteString("        '401':\n")
			b.WriteString("          description: Unauthorized — header X-Project-Session tidak valid atau kedaluwarsa\n")
		}
	}
	b.WriteString("components:\n")
	b.WriteString("  securitySchemes:\n")
	b.WriteString("    bearerAuth:\n")
	b.WriteString("      type: http\n")
	b.WriteString("      scheme: bearer\n")
	b.WriteString("      bearerFormat: JWT\n")
	b.WriteString("      description: " + yamlText("Header Authorization: Bearer <token>. Token berupa JWT builder (klaim uid, 30 hari) atau API key pribadi wb_* (hash sha256 disimpan di DB).") + "\n")
	return b.String()
}

// renderTSRouteTable menurunkan tabel rute TypeScript dari route yang sama.
func renderTSRouteTable(routes []route) string {
	var b strings.Builder
	b.WriteString("export type ApiAuthKind = \"public\" | \"jwt-or-apikey\" | \"project-session\";\n\n")
	b.WriteString("export interface ApiRoute {\n  method: string;\n  path: string;\n  auth: ApiAuthKind;\n}\n\n")
	b.WriteString("export const API_ROUTES: ApiRoute[] = [\n")
	for _, rt := range routes {
		fmt.Fprintf(&b, "  { method: %q, path: %q, auth: %q },\n", rt.Method, rt.Path, string(rt.Auth))
	}
	b.WriteString("];\n\n")
	b.WriteString(`/** Ganti parameter path {id} dengan nilai, mis. apiPath("/api/projects/{id}/chat", { id: "12" }). */` + "\n")
	b.WriteString("export function apiPath(path: string, params: Record<string, string | number> = {}): string {\n")
	b.WriteString("  let out = path;\n")
	b.WriteString("  for (const [k, v] of Object.entries(params)) out = out.replace(`{${k}}`, encodeURIComponent(String(v)));\n")
	b.WriteString("  return out;\n")
	b.WriteString("}\n")
	return b.String()
}

const (
	tsBeginMarker = "// BEGIN GENERATED — API_ROUTES dari server/openapi.yaml (go run ./cmd/generate-openapi)"
	tsEndMarker   = "// END GENERATED"
)

// updateTypesIndex mengganti blok GENERATED di packages/types/src/index.ts
// dengan tabel rute terbaru. File harus sudah punya kedua marker.
func updateTypesIndex(root string, routes []route) {
	p := filepath.Join(root, "packages", "types", "src", "index.ts")
	raw, err := os.ReadFile(p)
	if err != nil {
		fatalf("baca %s: %v", p, err)
	}
	src := string(raw)
	begin := strings.Index(src, tsBeginMarker)
	end := strings.Index(src, tsEndMarker)
	if begin < 0 || end < 0 || end < begin {
		fatalf("%s: marker GENERATED tidak ditemukan — tambahkan blok\n%s\n...\n%s\nlalu jalankan ulang generator", p, tsBeginMarker, tsEndMarker)
	}
	endLine := strings.Index(src[end:], "\n")
	if endLine < 0 {
		fatalf("%s: marker END tanpa newline", p)
	}
	end = end + endLine + 1
	next := tsBeginMarker + "\n" + renderTSRouteTable(routes) + tsEndMarker + "\n"
	if err := os.WriteFile(p, []byte(src[:begin]+next+src[end:]), 0644); err != nil {
		fatalf("tulis %s: %v", p, err)
	}
	fmt.Println("updated", p)
}

func fatalf(format string, args ...interface{}) {
	fmt.Fprintf(os.Stderr, "generate-openapi: "+format+"\n", args...)
	os.Exit(1)
}

func main() {
	// Hermetic: HOME sementara + kunci enkripsi dummy, supaya generator
	// tidak membaca/menulis ~/.webbuilder-key milik developer.
	tmpHome, err := os.MkdirTemp("", "webbuilder-openapi-home-")
	if err != nil {
		fatalf("mktemp HOME: %v", err)
	}
	defer os.RemoveAll(tmpHome)
	os.Setenv("HOME", tmpHome)
	dummyKey := base64.StdEncoding.EncodeToString(make([]byte, 32))
	os.Setenv("WEBBUILDER_KEY", dummyKey)

	cwd, err := os.Getwd()
	if err != nil {
		fatalf("getwd: %v", err)
	}
	if _, err := os.Stat(filepath.Join(cwd, "go.mod")); err != nil {
		fatalf("jalankan dari server/ (cd server && go run ./cmd/generate-openapi); go.mod tidak ditemukan di %s", cwd)
	}
	root := filepath.Dir(cwd)

	routes := collectRoutes()
	yaml := renderYAML(routes)
	outPath := filepath.Join(cwd, "openapi.yaml")
	if err := os.WriteFile(outPath, []byte(yaml), 0644); err != nil {
		fatalf("tulis %s: %v", outPath, err)
	}
	fmt.Printf("wrote %s (%d routes)\n", outPath, len(routes))
	updateTypesIndex(root, routes)
}

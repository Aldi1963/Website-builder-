package browser

import (
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestParseConsoleErrorsVerify(t *testing.T) {
	out := `## Console messages
Showing 1-4 of 4 (Page 1 of 1).
msgid=1 [log] LOG-PROBE: ok (1 args)
msgid=2 [warn] WARN-PROBE: hati-hati (1 args)
msgid=3 [error] ERR-PROBE: undefined is not a function di render (1 args)
msgid=4 [error] Failed to load resource: the server responded with a status of 404 (File not found) (0 args) [3 times]`
	got := ParseConsoleErrors(out)
	if len(got) != 1 {
		t.Fatalf("hanya 1 console error nyata yang boleh lolos, dapat %d: %+v", len(got), got)
	}
	if !strings.Contains(got[0], "ERR-PROBE: undefined is not a function di render") {
		t.Fatalf("isi console error harus utuh, dapat %q", got[0])
	}

	// Halaman sehat: satu-satunya error adalah 404 favicon (diagregasi
	// jadi baris "Failed to load resource") → 0 error.
	healthy := `## Console messages
Showing 1-1 of 1 (Page 1 of 1).
msgid=1 [error] Failed to load resource: the server responded with a status of 404 (File not found) (0 args)`
	if got := ParseConsoleErrors(healthy); len(got) != 0 {
		t.Fatalf("404 favicon saja tidak boleh dihitung error, dapat %+v", got)
	}
	// Baris error yang menyebut favicon secara eksplisit juga diabaikan.
	fav := "msgid=1 [error] Failed to load resource: http://127.0.0.1:18082/favicon.ico 404"
	if got := ParseConsoleErrors(fav); len(got) != 0 {
		t.Fatalf("baris favicon eksplisit harus diabaikan, dapat %+v", got)
	}
	if got := ParseConsoleErrors(""); len(got) != 0 {
		t.Fatalf("output kosong harus 0 error, dapat %+v", got)
	}
}

func TestParseFailedRequests(t *testing.T) {
	out := `## Network requests
Showing 1-7 of 7 (Page 1 of 1).
reqid=1 GET http://127.0.0.1:18098/index.html [200]
reqid=2 GET http://127.0.0.1:18098/tidak-ada.json [404]
reqid=3 GET http://127.0.0.1:18098/api/data-gagal [500]
reqid=4 GET http://127.0.0.1:18098/favicon.ico [404]
reqid=5 GET http://127.0.0.1:18098/api/app-api/me [401]
reqid=6 GET http://127.0.0.1:18098/putus [net::ERR_CONNECTION_REFUSED]
reqid=7 GET data:image/png;base64,AAAA [404]`
	got := ParseFailedRequests(out)
	if len(got) != 3 {
		t.Fatalf("harus 3 request gagal (404 json + 500 api + net::ERR; favicon, 401 auth-probe, dan data: dikecualikan), dapat %d: %+v", len(got), got)
	}
	if !strings.Contains(got[0], "tidak-ada.json [404]") || !strings.Contains(got[1], "data-gagal [500]") || !strings.Contains(got[2], "putus [net::ERR_CONNECTION_REFUSED]") {
		t.Fatalf("request gagal harus menyebut URL + status/error, dapat %+v", got)
	}
	if got := ParseFailedRequests("reqid=1 GET http://127.0.0.1:18098/ [200]\n"); len(got) != 0 {
		t.Fatalf("semua 200 harus 0 gagal, dapat %+v", got)
	}
}

func TestVerificationResultDiagnostic(t *testing.T) {
	r := VerificationResult{
		Passed: false,
		ConsoleErrors: []string{
			"msgid=2 [error] ERR-PROBE: undefined is not a function di render (1 args)",
		},
		FailedRequests:  []string{"GET http://127.0.0.1:18098/tidak-ada.json [404]"},
		SnapshotSummary: "heading \"Halo Probe\"",
	}
	diag := r.Diagnostic()
	for _, want := range []string{"ERR-PROBE: undefined is not a function", "tidak-ada.json [404]", "Halo Probe"} {
		if !strings.Contains(diag, want) {
			t.Fatalf("diagnostik harus memuat %q, dapat:\n%s", want, diag)
		}
	}
	if s := buildVerifySummary(r); !strings.Contains(s, "1 console error") || !strings.Contains(s, "1 request gagal") {
		t.Fatalf("ringkasan harus menyebut jumlah temuan, dapat %q", s)
	}
	ok := VerificationResult{Passed: true, ScreenshotPath: "/x/shot.png"}
	if !strings.Contains(ok.Diagnostic(), "lolos") || !strings.Contains(buildVerifySummary(ok), "0 console error") {
		t.Fatalf("hasil lolos harus diringkas sebagai lolos, dapat %q / %q", ok.Diagnostic(), buildVerifySummary(ok))
	}
}

func TestMissingActiveTools(t *testing.T) {
	// Server yang hanya mengenal 2 tool: 19 alat aktif lain harus
	// dilaporkan hilang (fail-closed, bukan diam-diam).
	partial := []*mcp.Tool{
		{Name: "list_console_messages"},
		{Name: "navigate_page"},
	}
	missing := MissingActiveTools(partial)
	if len(missing) != len(AllowlistTools)-2 {
		t.Fatalf("harus %d alat hilang, dapat %d: %+v", len(AllowlistTools)-2, len(missing), missing)
	}
	for _, want := range []string{"take_screenshot", "lighthouse_audit", "take_snapshot"} {
		found := false
		for _, m := range missing {
			if m == want {
				found = true
			}
		}
		if !found {
			t.Fatalf("alat hilang harus memuat %q, dapat %+v", want, missing)
		}
	}
	full := make([]*mcp.Tool, 0, len(AllowlistTools))
	for _, n := range AllowlistTools {
		full = append(full, &mcp.Tool{Name: n})
	}
	if got := MissingActiveTools(full); len(got) != 0 {
		t.Fatalf("server lengkap tidak boleh ada yang hilang, dapat %+v", got)
	}
}

func TestSpecsFromToolsFullAllowlist(t *testing.T) {
	// Server MCP 1.13.0 mengembalikan 33 tool; 21 di antaranya allowlist
	// §5, sisanya (heap, click, dst.) harus tetap tertutup.
	tools := []*mcp.Tool{}
	for _, n := range AllowlistTools {
		tools = append(tools, &mcp.Tool{Name: n, Description: n, InputSchema: map[string]interface{}{"type": "object", "properties": map[string]interface{}{}}})
	}
	tools = append(tools,
		&mcp.Tool{Name: "take_heapsnapshot", Description: "heap"},
		&mcp.Tool{Name: "click", Description: "input"},
	)
	specs := SpecsFromTools(tools)
	if len(specs) != len(AllowlistTools) {
		t.Fatalf("katalog Fase 2 harus memuat seluruh allowlist §5, dapat %d (allowlist %d)", len(specs), len(AllowlistTools))
	}
	seen := map[string]bool{}
	for _, s := range specs {
		if !strings.HasPrefix(s.Name, "browser_") {
			t.Fatalf("nama katalog harus berprefix browser_, dapat %q", s.Name)
		}
		seen[s.Name] = true
	}
	for _, n := range AllowlistTools {
		if !seen["browser_"+n] {
			t.Fatalf("katalog harus memuat browser_%s", n)
		}
	}
	if seen["browser_take_heapsnapshot"] || seen["browser_click"] {
		t.Fatal("alat di luar allowlist tidak boleh masuk katalog")
	}
}

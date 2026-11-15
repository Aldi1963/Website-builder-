package browser

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// TestMain: bila dijalankan sebagai subproses dengan BROWSER_FAKE_MCP=1,
// proses ini MENJADI server MCP palsu (stdio JSON-RPC minimal) dan tidak
// menjalankan test. Pola helper-process standar: test Start/Stop memakai
// os.Args[0] sebagai command server.
func TestMain(m *testing.M) {
	if os.Getenv("BROWSER_FAKE_MCP") == "1" {
		runFakeMCPServer()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func runFakeMCPServer() {
	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 64*1024), 1024*1024)
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()
	for in.Scan() {
		line := strings.TrimSpace(in.Text())
		if line == "" {
			continue
		}
		var req struct {
			JSONRPC string          `json:"jsonrpc"`
			ID      json.RawMessage `json:"id"`
			Method  string          `json:"method"`
			Params  json.RawMessage `json:"params"`
		}
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			continue
		}
		if len(req.ID) == 0 {
			continue // notifikasi (mis. notifications/initialized): tanpa balasan
		}
		var result any
		var rpcErr any
		switch req.Method {
		case "initialize":
			result = map[string]any{
				"protocolVersion": "2025-03-26",
				"capabilities":    map[string]any{},
				"serverInfo":      map[string]any{"name": "fake-chrome-devtools", "version": "0.0.0"},
			}
		case "ping":
			result = map[string]any{}
		case "tools/list":
			// Daftar ini SELARAS dengan tools/call di bawah: 6 tool yang
			// ditangani fake + take_heapsnapshot sebagai umpan tool di
			// luar allowlist (harus terbuang oleh FilterAllowlist).
			result = map[string]any{"tools": []any{
				map[string]any{"name": "list_console_messages", "description": "List console messages", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{}}},
				map[string]any{"name": "navigate_page", "description": "Navigate", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{"url": map[string]any{"type": "string"}}}},
				map[string]any{"name": "take_snapshot", "description": "Snapshot", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{}}},
				map[string]any{"name": "list_network_requests", "description": "List network requests", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{}}},
				map[string]any{"name": "evaluate_script", "description": "Evaluate script", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{}}},
				map[string]any{"name": "take_screenshot", "description": "Screenshot", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{}}},
				map[string]any{"name": "take_heapsnapshot", "description": "Heap (bukan allowlist)", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{}}},
			}}
		case "tools/call":
			var params struct {
				Name      string                 `json:"name"`
				Arguments map[string]interface{} `json:"arguments"`
			}
			_ = json.Unmarshal(req.Params, &params)
			mode := os.Getenv("BROWSER_FAKE_MCP_MODE") // "healthy" (default) atau "error"
			origin := "http://127.0.0.1:18098"
			switch params.Name {
			case "list_console_messages":
				if mode == "error" {
					result = map[string]any{"content": []any{
						map[string]any{"type": "text", "text": "## Console messages\nShowing 1-3 of 3 (Page 1 of 1).\nmsgid=1 [error] SENGAJA_ERROR_XYZ (1 args)\nmsgid=2 [error] Uncaught ReferenceError: undefinedFunctionYangTidakAda is not defined (0 args)\nmsgid=3 [error] Failed to load resource: the server responded with a status of 404 (File not found) (0 args)"},
					}}
				} else {
					result = map[string]any{"content": []any{
						map[string]any{"type": "text", "text": "## Console messages\nShowing 1-2 of 2 (Page 1 of 1).\nmsgid=1 [log] hello from fake page (1 args)\nmsgid=2 [error] Failed to load resource: the server responded with a status of 404 (File not found) (0 args)"},
					}}
				}
			case "navigate_page":
				u, _ := params.Arguments["url"].(string)
				result = map[string]any{"content": []any{
					map[string]any{"type": "text", "text": "Successfully navigated to " + u + ".\n## Pages\n1: Fake (" + u + ") [selected]"},
				}}
			case "take_snapshot":
				result = map[string]any{"content": []any{
					map[string]any{"type": "text", "text": "## Latest page snapshot\nuid=1_0 RootWebArea \"Fake\" url=\"" + origin + "/\"\n  uid=1_1 heading \"Halo sehat\" level=\"1\"\n  uid=1_2 \"Ini halaman sehat.\""},
				}}
			case "list_network_requests":
				if mode == "error" {
					result = map[string]any{"content": []any{
						map[string]any{"type": "text", "text": "## Network requests\nShowing 1-4 of 4 (Page 1 of 1).\nreqid=1 GET " + origin + "/error.html [200]\nreqid=2 GET " + origin + "/tidak-ada.json [404]\nreqid=3 GET " + origin + "/favicon.ico [404]\nreqid=4 GET " + origin + "/api/app-api/me [401]"},
					}}
				} else {
					result = map[string]any{"content": []any{
						map[string]any{"type": "text", "text": "## Network requests\nShowing 1-2 of 2 (Page 1 of 1).\nreqid=1 GET " + origin + "/healthy.html [200]\nreqid=2 GET " + origin + "/favicon.ico [404]"},
					}}
				}
			case "evaluate_script":
				// Acceptance hanya memanggil evaluate sekali dengan JS
				// gabungan (navigation + body + sdk + resource timing);
				// kembalikan payload lengkap sesuai mode, dalam format
				// fence persis seperti chrome-devtools-mcp 1.13.0.
				var payload string
				if mode == "error" {
					payload = `{"status":200,"bodyLen":13,"sdk":{"installed":true,"loggedOut":true},"failed":[{"url":"` + origin + `/tidak-ada.json","status":404}],"origin":"` + origin + `"}`
				} else {
					payload = `{"status":200,"bodyLen":30,"sdk":{"installed":false},"failed":[],"origin":"` + origin + `"}`
				}
				inner, _ := json.Marshal(payload)
				result = map[string]any{"content": []any{
					map[string]any{"type": "text", "text": "Script ran on page and returned:\n```json\n" + string(inner) + "\n```"},
				}}
			case "take_screenshot":
				filePath, _ := params.Arguments["filePath"].(string)
				// PNG 1x1 minimal — cukup untuk membuktikan file tertulis.
				png := []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54, 0x08, 0xD7, 0x63, 0xF8, 0xFF, 0xFF, 0x3F, 0x00, 0x05, 0xFE, 0x02, 0xFE, 0xDC, 0xCC, 0x59, 0xE7, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82}
				if err := os.MkdirAll(filepath.Dir(filePath), 0o755); err == nil {
					_ = os.WriteFile(filePath, png, 0o644)
				}
				result = map[string]any{"content": []any{
					map[string]any{"type": "text", "text": "Took a screenshot of the current page's viewport.\nSaved screenshot to " + filePath + "."},
				}}
			default:
				result = map[string]any{"content": []any{
					map[string]any{"type": "text", "text": "unknown tool"},
				}, "isError": true}
			}
		default:
			rpcErr = map[string]any{"code": -32601, "message": "method not found: " + req.Method}
		}
		resp := map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(req.ID)}
		if rpcErr != nil {
			resp["error"] = rpcErr
		} else {
			resp["result"] = result
		}
		b, _ := json.Marshal(resp)
		fmt.Fprintln(out, string(b))
		out.Flush()
	}
}

func fakeClient(t *testing.T) *Client {
	return fakeClientMode(t, "healthy")
}

// fakeClientMode seperti fakeClient, tapi server MCP palsu berjalan dalam
// mode yang dipilih (lihat runFakeMCPServer: "healthy" atau "error").
func fakeClientMode(t *testing.T, mode string) *Client {
	t.Helper()
	t.Setenv("BROWSER_FAKE_MCP", "1")
	t.Setenv("BROWSER_FAKE_MCP_MODE", mode)
	dir := t.TempDir()
	ws := filepath.Join(dir, "workspace")
	prof := filepath.Join(dir, "chrome-profile")
	if err := os.MkdirAll(ws, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(prof, 0o755); err != nil {
		t.Fatal(err)
	}
	c := NewClient(Config{Command: os.Args[0], WorkspaceDir: ws, ProfileDir: prof})
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func TestBrowserClientStartStop(t *testing.T) {
	ctx := context.Background()
	c := fakeClient(t)
	if err := c.Start(ctx); err != nil {
		t.Fatalf("Start dengan server MCP palsu gagal: %v", err)
	}
	if !c.Started() {
		t.Fatal("Started() harus true sesudah Start")
	}
	tools, err := c.ListTools(ctx)
	if err != nil {
		t.Fatalf("ListTools gagal: %v", err)
	}
	if len(tools) != 7 {
		t.Fatalf("fake server harus mengembalikan 7 tool (6 yang ditangani + take_heapsnapshot di luar allowlist), dapat %d", len(tools))
	}
	out, err := c.CallTool(ctx, "list_console_messages", map[string]interface{}{})
	if err != nil {
		t.Fatalf("CallTool list_console_messages gagal: %v", err)
	}
	if !strings.Contains(out, "hello from fake page") {
		t.Fatalf("hasil tool harus memuat pesan console palsu, dapat %q", out)
	}
	prof := c.cfg.ProfileDir
	if err := c.Close(); err != nil {
		t.Fatalf("Close gagal: %v", err)
	}
	if _, err := os.Stat(prof); !os.IsNotExist(err) {
		t.Fatalf("profil Chrome run harus dihapus Close(), masih ada: %s", prof)
	}
	if c.cmd == nil || c.cmd.ProcessState == nil || !c.cmd.ProcessState.Exited() {
		t.Fatal("proses server MCP harus sudah exit sesudah Close() (tidak boleh yatim)")
	}
	// Close kedua aman (idempotent).
	if err := c.Close(); err != nil {
		t.Fatalf("Close kedua harus aman, dapat: %v", err)
	}
}

func TestFilterAllowlistAndActive(t *testing.T) {
	tools := []*mcp.Tool{
		{Name: "list_console_messages", Description: "console", InputSchema: map[string]interface{}{"type": "object", "properties": map[string]interface{}{}}},
		{Name: "navigate_page", Description: "nav", InputSchema: map[string]interface{}{"type": "object", "properties": map[string]interface{}{"url": map[string]interface{}{"type": "string"}}}},
		{Name: "take_heapsnapshot", Description: "heap — bukan allowlist"},
		{Name: "click", Description: "input — bukan allowlist"},
		{Name: "take_screenshot", Description: "shot"},
	}
	if got := FilterAllowlist(tools); len(got) != 3 {
		t.Fatalf("allowlist §5 harus meloloskan 3 dari 5, dapat %d", len(got))
	}
	specs := SpecsFromTools(tools)
	if len(specs) != 3 {
		t.Fatalf("Fase 2 mengekspos seluruh allowlist §5 (3 dari daftar uji ini), dapat %d: %+v", len(specs), specs)
	}
	names := map[string]bool{}
	for _, s := range specs {
		names[s.Name] = true
	}
	for _, want := range []string{"browser_list_console_messages", "browser_navigate_page", "browser_take_screenshot"} {
		if !names[want] {
			t.Fatalf("katalog harus memuat %q, dapat %+v", want, specs)
		}
	}
	if specs[0].InputSchema["type"] != "object" {
		t.Fatalf("skema harus objek, dapat %+v", specs[0].InputSchema)
	}
	// Skema hilang/rusak diganti objek kosong (model tetap dapat properties).
	broken := SpecsFromTools([]*mcp.Tool{{Name: "list_console_messages", InputSchema: "bukan-objek"}})
	if len(broken) != 1 || broken[0].InputSchema["type"] != "object" {
		t.Fatalf("skema rusak harus dinormalkan ke objek, dapat %+v", broken)
	}
}

func TestValidateURL(t *testing.T) {
	allow := []string{
		"http://127.0.0.1:18099/index.html",
		"https://localhost:3000/",
		"http://127.0.0.1/",
		"http://localhost/",
	}
	for _, u := range allow {
		if err := ValidateURL(u); err != nil {
			t.Errorf("URL preview %q harus lolos, dapat: %v", u, err)
		}
	}
	deny := []string{
		"https://example.com/",
		"http://192.168.1.1/",
		"https://clipku.com/x",
		"file:///etc/passwd",
		"/relative/path",
		"ftp://127.0.0.1/x",
		"http://127.0.0.1.evil.com/",
		"",
	}
	for _, u := range deny {
		if err := ValidateURL(u); err == nil {
			t.Errorf("URL luar %q harus ditolak", u)
		}
	}
}

func TestTruncateOutput(t *testing.T) {
	if got := TruncateOutput("abc"); got != "abc" {
		t.Fatalf("output pendek tidak boleh berubah, dapat %q", got)
	}
	exact := strings.Repeat("x", MaxOutputBytes)
	if got := TruncateOutput(exact); got != exact {
		t.Fatal("output tepat 64 KiB tidak boleh dipotong")
	}
	long := strings.Repeat("y", MaxOutputBytes+100)
	got := TruncateOutput(long)
	if len(got) > MaxOutputBytes+100 || !strings.Contains(got, "[dipotong: output melebihi 64 KiB]") {
		t.Fatalf("output panjang harus dipotong + bermarker, panjang %d", len(got))
	}
}

func TestEnabledGating(t *testing.T) {
	t.Setenv(EnvEnableBrowserTools, "1")
	t.Setenv(EnvEnableTenantExec, "1")
	if !Enabled() {
		t.Fatal("kedua flag 1 → Enabled() harus true")
	}
	t.Setenv(EnvEnableBrowserTools, "0")
	if Enabled() {
		t.Fatal("flag browser 0 → Enabled() harus false")
	}
	t.Setenv(EnvEnableBrowserTools, "1")
	t.Setenv(EnvEnableTenantExec, "true")
	if Enabled() {
		t.Fatal(`flag tenant "true" (bukan "1") → Enabled() harus false`)
	}
}

func TestNewClientForRunFailClosed(t *testing.T) {
	t.Setenv(EnvEnableBrowserTools, "0")
	t.Setenv(EnvEnableTenantExec, "0")
	if _, err := NewClientForRun(1, t.TempDir()); err == nil {
		t.Fatal("gating mati → NewClientForRun harus error")
	}
	t.Setenv(EnvEnableBrowserTools, "1")
	t.Setenv(EnvEnableTenantExec, "1")
	t.Setenv(EnvChromePath, "/tidak/ada/chrome-xyz")
	if _, err := NewClientForRun(1, t.TempDir()); err == nil {
		t.Fatal("CHROME_FOR_TESTING_PATH tak ada → harus error jelas")
	} else if !strings.Contains(err.Error(), "/tidak/ada/chrome-xyz") {
		t.Fatalf("error harus menyebut path Chrome, dapat: %v", err)
	}
}

func TestCallToolRejectsInactiveAndExternalURL(t *testing.T) {
	ctx := context.Background()
	c := fakeClient(t)
	if err := c.Start(ctx); err != nil {
		t.Fatalf("Start gagal: %v", err)
	}
	// click ada di luar allowlist §5 (alat input baru dipertimbangkan di
	// Fase 4) — harus ditolak sebelum menyentuh server.
	if _, err := c.CallTool(ctx, "click", map[string]interface{}{"uid": "1_1"}); err == nil {
		t.Fatal("tool di luar allowlist harus ditolak sebelum menyentuh server")
	}
	// take_heapsnapshot ada di tools/list server tapi bukan allowlist.
	if _, err := c.CallTool(ctx, "take_heapsnapshot", map[string]interface{}{}); err == nil {
		t.Fatal("tool server di luar allowlist harus ditolak")
	}
	// URL luar ditolak di lapis klien walau tool-nya aktif.
	if _, err := c.CallTool(ctx, "list_console_messages", map[string]interface{}{"url": "https://example.com/"}); err == nil {
		t.Fatal("argumen URL luar harus ditolak")
	}
}

func TestCallToolRequiresStart(t *testing.T) {
	c := NewClient(Config{Command: os.Args[0]})
	if _, err := c.CallTool(context.Background(), "list_console_messages", nil); err == nil {
		t.Fatal("CallTool sebelum Start harus error")
	}
	if _, err := c.ListTools(context.Background()); err == nil {
		t.Fatal("ListTools sebelum Start harus error")
	}
}

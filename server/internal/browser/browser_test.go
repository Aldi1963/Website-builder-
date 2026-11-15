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
			result = map[string]any{"tools": []any{
				map[string]any{"name": "list_console_messages", "description": "List console messages", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{}}},
				map[string]any{"name": "navigate_page", "description": "Navigate", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{"url": map[string]any{"type": "string"}}}},
				map[string]any{"name": "take_heapsnapshot", "description": "Heap (bukan allowlist)", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{}}},
			}}
		case "tools/call":
			var params struct {
				Name string `json:"name"`
			}
			_ = json.Unmarshal(req.Params, &params)
			if params.Name == "list_console_messages" {
				result = map[string]any{"content": []any{
					map[string]any{"type": "text", "text": "[log] hello from fake page\n[error] example error"},
				}}
			} else {
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
	t.Helper()
	t.Setenv("BROWSER_FAKE_MCP", "1")
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
	if len(tools) != 3 {
		t.Fatalf("fake server harus mengembalikan 3 tool, dapat %d", len(tools))
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
	if len(specs) != 1 {
		t.Fatalf("Fase 1 hanya mengekspos 1 alat, dapat %d: %+v", len(specs), specs)
	}
	if specs[0].Name != "browser_list_console_messages" {
		t.Fatalf("nama alat harus browser_list_console_messages, dapat %q", specs[0].Name)
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
	// navigate_page ada di allowlist §5 tapi BELUM aktif di Fase 1.
	if _, err := c.CallTool(ctx, "navigate_page", map[string]interface{}{"url": "http://127.0.0.1:18099/"}); err == nil {
		t.Fatal("tool belum aktif harus ditolak sebelum menyentuh server")
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

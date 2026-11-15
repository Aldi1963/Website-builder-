package browser

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// TestBrowserClientRealChrome adalah test integrasi Fase 1 dengan Chrome
// for Testing asli + server MCP asli. Di-skip bila CHROME_FOR_TESTING_PATH
// kosong (mesin tanpa Chrome). Membuktikan dua hal yang tidak bisa
// dibuktikan server palsu:
//   - flag --no-page-id-routing bekerja: navigate_page +
//     list_console_messages sukses TANPA pageId (dengan routing nyala,
//     server menolak "pageId: Invalid input");
//   - console halaman lokal benar-benar terbaca (termasuk console.error).
func TestBrowserClientRealChrome(t *testing.T) {
	chromePath := strings.TrimSpace(os.Getenv(EnvChromePath))
	if chromePath == "" {
		t.Skip("CHROME_FOR_TESTING_PATH kosong — test integrasi Chrome dilewati")
	}
	if _, err := os.Stat(chromePath); err != nil {
		t.Fatalf("CHROME_FOR_TESTING_PATH tidak ada: %s", chromePath)
	}
	// Halaman uji di 127.0.0.1 (origin preview) dengan console.* sengaja.
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, `<!doctype html><html><head><title>uji</title></head><body><h1>Halo</h1><script>console.log("log-uji-123"); console.error("error-uji-456");</script></body></html>`)
	}))
	defer ts.Close()

	ctx := context.Background()
	dir := t.TempDir()
	ws := filepath.Join(dir, "workspace")
	prof := filepath.Join(dir, "chrome-profile")
	if err := os.MkdirAll(ws, 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := DefaultConfig(ws, prof)
	c := NewClient(cfg)
	t.Cleanup(func() { _ = c.Close() })
	start := time.Now()
	if err := c.Start(ctx); err != nil {
		t.Fatalf("Start dengan Chrome asli gagal: %v", err)
	}
	t.Logf("start Chrome+MCP: %s", time.Since(start).Round(time.Millisecond))

	// Panggilan mentah sesi (tanpa pageId) — membuktikan --no-page-id-routing.
	callRaw := func(name string, args map[string]any) string {
		t.Helper()
		callCtx, cancel := context.WithTimeout(ctx, CallTimeout)
		defer cancel()
		res, err := c.session.CallTool(callCtx, &mcp.CallToolParams{Name: name, Arguments: args})
		if err != nil {
			t.Fatalf("CallTool %s gagal: %v", name, err)
		}
		return toolResultText(res)
	}
	nav := callRaw("navigate_page", map[string]any{"url": ts.URL + "/"})
	if !strings.Contains(nav, "Successfully navigated") {
		t.Fatalf("navigate_page harus sukses tanpa pageId, dapat: %q", nav)
	}
	consoleOut := callRaw("list_console_messages", map[string]any{})
	if !strings.Contains(consoleOut, "error-uji-456") {
		t.Fatalf("console harus memuat error-uji-456, dapat: %q", consoleOut)
	}
	if !strings.Contains(consoleOut, "log-uji-123") {
		t.Fatalf("console harus memuat log-uji-123, dapat: %q", consoleOut)
	}

	// Jalur publik Fase 1 (tool aktif) juga harus jalan di Chrome asli.
	out, err := c.CallTool(ctx, "list_console_messages", map[string]interface{}{})
	if err != nil {
		t.Fatalf("CallTool publik list_console_messages gagal: %v", err)
	}
	if !strings.Contains(out, "error-uji-456") {
		t.Fatalf("CallTool publik harus memuat error-uji-456, dapat: %q", out)
	}

	if err := c.Close(); err != nil {
		t.Fatalf("Close gagal: %v", err)
	}
	if _, err := os.Stat(prof); !os.IsNotExist(err) {
		t.Fatalf("profil Chrome run harus dihapus Close(), masih ada: %s", prof)
	}
	if c.cmd == nil || c.cmd.ProcessState == nil || !c.cmd.ProcessState.Exited() {
		t.Fatal("proses server MCP harus sudah exit sesudah Close() (tidak boleh yatim)")
	}
}

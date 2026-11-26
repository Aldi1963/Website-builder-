package browser

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
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

// TestVerifyPreviewRealChrome adalah bukti Fase 2 dengan Chrome for
// Testing asli: satu putaran verifikasi scripted terhadap halaman baik
// (0 console error, screenshot PNG tersimpan) dan halaman rusak
// (console.error + fetch 404 terdeteksi DENGAN isi yang benar).
// Di-skip bila CHROME_FOR_TESTING_PATH kosong.
func TestVerifyPreviewRealChrome(t *testing.T) {
	chromePath := strings.TrimSpace(os.Getenv(EnvChromePath))
	if chromePath == "" {
		t.Skip("CHROME_FOR_TESTING_PATH kosong — test integrasi Chrome dilewati")
	}
	if _, err := os.Stat(chromePath); err != nil {
		t.Fatalf("CHROME_FOR_TESTING_PATH tidak ada: %s", chromePath)
	}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		switch {
		case strings.Contains(r.URL.Path, "rusak"):
			fmt.Fprint(w, `<!doctype html><html><head><title>rusak</title></head><body><h1>Rusak</h1><script>console.error("ERR-UJI-VERIF: undefined is not a function di render"); fetch("/tidak-ada-uji.json").catch(()=>{});</script></body></html>`)
		case strings.Contains(r.URL.Path, "baik"):
			fmt.Fprint(w, `<!doctype html><html><head><title>baik</title></head><body><h1>Halo Baik</h1><p>Paragraf baik.</p><script>console.log("LOG-BAIK: ok");</script></body></html>`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer ts.Close()

	// Hook manual: WB_VERIFY_PREVIEW_URL menunjuk halaman baik ke dev
	// server Vite sungguhan (bukan httptest), mis. saat memverifikasi
	// loop terhadap preview proyek nyata. Halaman rusak tetap httptest.
	goodURL := ts.URL + "/baik"
	if envURL := strings.TrimSpace(os.Getenv("WB_VERIFY_PREVIEW_URL")); envURL != "" {
		goodURL = envURL
	}

	ctx := context.Background()
	dir := t.TempDir()
	ws := filepath.Join(dir, "workspace")
	prof := filepath.Join(dir, "chrome-profile")
	if err := os.MkdirAll(ws, 0o755); err != nil {
		t.Fatal(err)
	}
	c := NewClient(DefaultConfig(ws, prof))
	t.Cleanup(func() { _ = c.Close() })
	if err := c.Start(ctx); err != nil {
		t.Fatalf("Start dengan Chrome asli gagal: %v", err)
	}

	// Halaman baik: lolos, snapshot memuat judul, screenshot PNG ada.
	good, err := VerifyPreview(ctx, c, goodURL, "screenshot-1.png")
	if err != nil {
		t.Fatalf("VerifyPreview halaman baik gagal: %v", err)
	}
	if !good.Passed {
		t.Fatalf("halaman baik harus lolos, dapat console=%+v network=%+v", good.ConsoleErrors, good.FailedRequests)
	}
	if os.Getenv("WB_VERIFY_PREVIEW_URL") == "" && !strings.Contains(good.SnapshotSummary, "Halo Baik") {
		t.Fatalf("snapshot halaman baik harus memuat judul, dapat %q", good.SnapshotSummary)
	}
	checkPNG(t, good.ScreenshotPath)

	// Halaman rusak: gagal DENGAN isi console error yang benar + 404.
	bad, err := VerifyPreview(ctx, c, ts.URL+"/rusak", "screenshot-2.png")
	if err != nil {
		t.Fatalf("VerifyPreview halaman rusak gagal: %v", err)
	}
	if bad.Passed {
		t.Fatal("halaman rusak harus TIDAK lolos")
	}
	found := false
	for _, e := range bad.ConsoleErrors {
		if strings.Contains(e, "ERR-UJI-VERIF: undefined is not a function di render") {
			found = true
		}
	}
	if !found {
		t.Fatalf("console error harus memuat teks asli, dapat %+v", bad.ConsoleErrors)
	}
	foundNet := false
	for _, f := range bad.FailedRequests {
		if strings.Contains(f, "tidak-ada-uji.json [404]") {
			foundNet = true
		}
	}
	if !foundNet {
		t.Fatalf("request gagal harus memuat 404 aset, dapat %+v", bad.FailedRequests)
	}
	checkPNG(t, bad.ScreenshotPath)
	t.Logf("baik: %s | rusak: %s", good.Summary, bad.Summary)
}

// TestPreviewPortRealChrome adalah bukti integrasi Fase 3 dengan Chrome
// for Testing asli: navigasi ke port preview sendiri DITERIMA, navigasi
// ke port localhost lain DITOLAK di lapis klien (tidak pernah sampai ke
// Chrome), dan navigasi sebelum port diketahui DITOLAK fail-closed.
// Di-skip bila CHROME_FOR_TESTING_PATH kosong.
func TestPreviewPortRealChrome(t *testing.T) {
	chromePath := strings.TrimSpace(os.Getenv(EnvChromePath))
	if chromePath == "" {
		t.Skip("CHROME_FOR_TESTING_PATH kosong — test integrasi Chrome dilewati")
	}
	if _, err := os.Stat(chromePath); err != nil {
		t.Fatalf("CHROME_FOR_TESTING_PATH tidak ada: %s", chromePath)
	}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, `<!doctype html><html><head><title>uji</title></head><body><h1>Halo Port</h1></body></html>`)
	}))
	defer ts.Close()
	previewPort := 0
	if u, err := url.Parse(ts.URL); err == nil {
		fmt.Sscanf(u.Port(), "%d", &previewPort)
	}
	if previewPort == 0 {
		t.Fatalf("tidak bisa membaca port httptest dari %s", ts.URL)
	}
	otherPort := previewPort + 1
	if otherPort > 65535 {
		otherPort = previewPort - 1
	}

	ctx := context.Background()
	dir := t.TempDir()
	ws := filepath.Join(dir, "workspace")
	prof := filepath.Join(dir, "chrome-profile")
	if err := os.MkdirAll(ws, 0o755); err != nil {
		t.Fatal(err)
	}
	c := NewClient(DefaultConfig(ws, prof))
	t.Cleanup(func() { _ = c.Close() })
	if err := c.Start(ctx); err != nil {
		t.Fatalf("Start dengan Chrome asli gagal: %v", err)
	}

	// Sebelum port diketahui: navigate ditolak fail-closed.
	if _, err := c.CallTool(ctx, "navigate_page", map[string]any{"url": ts.URL + "/"}); err == nil {
		t.Fatal("navigate sebelum port diketahui harus ditolak fail-closed")
	}
	// Kunci port preview, lalu navigate ke port sendiri DITERIMA (Chrome
	// asli benar-benar membuka halaman).
	if err := c.SetPreviewPort(previewPort); err != nil {
		t.Fatalf("SetPreviewPort gagal: %v", err)
	}
	nav, err := c.CallTool(ctx, "navigate_page", map[string]any{"url": ts.URL + "/"})
	if err != nil {
		t.Fatalf("navigate port preview sendiri harus lolos di Chrome asli: %v", err)
	}
	if !strings.Contains(nav, "Successfully navigated") {
		t.Fatalf("navigate port sendiri harus sukses, dapat: %q", nav)
	}
	// Port localhost lain DITOLAK (server WebBuilder 18082, dsb.).
	if _, err := c.CallTool(ctx, "navigate_page", map[string]any{"url": fmt.Sprintf("http://127.0.0.1:%d/", otherPort)}); err == nil {
		t.Fatalf("navigate port lain %d harus ditolak", otherPort)
	}
	if _, err := c.CallTool(ctx, "navigate_page", map[string]any{"url": "http://127.0.0.1:18082/"}); err == nil {
		t.Fatal("navigate port 18082 (server) harus ditolak")
	}
	if _, err := c.CallTool(ctx, "navigate_page", map[string]any{"url": "https://example.com/"}); err == nil {
		t.Fatal("navigate URL luar harus ditolak")
	}
}

func checkPNG(t *testing.T, path string) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("screenshot harus tersimpan di %s: %v", path, err)
	}
	if len(data) < 8 || string(data[:8]) != "\x89PNG\r\n\x1a\n" {
		t.Fatalf("screenshot %s harus file PNG, dapat %d byte dengan header %q", path, len(data), data[:8])
	}
	t.Logf("screenshot tersimpan: %s (%d byte)", path, len(data))
}

package browser

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// Unit: parser output teks MCP (format terbukti dari spike Fase 2)
// ---------------------------------------------------------------------------

func TestCleanConsoleErrors(t *testing.T) {
	// ParseConsoleErrors (Trek A) membuang "Failed to load resource" +
	// favicon; cleanConsoleErrors membuang prefix msgid + suffix args.
	text := "## Console messages\nShowing 1-3 of 3 (Page 1 of 1).\n" +
		"msgid=1 [log] halo log (1 args)\n" +
		"msgid=2 [error] SENGAJA_ERROR_XYZ (1 args)\n" +
		"msgid=3 [error] Uncaught ReferenceError: foo is not defined (0 args)\n" +
		"msgid=4 [error] Failed to load resource: the server responded with a status of 404 (File not found) (0 args)\n" +
		"msgid=5 [warn] hati-hati (2 args)\n"
	got := cleanConsoleErrors(ParseConsoleErrors(text))
	if len(got) != 2 {
		t.Fatalf("harus 2 console error bersih, dapat %d: %v", len(got), got)
	}
	if got[0] != "SENGAJA_ERROR_XYZ" {
		t.Fatalf("prefix msgid + suffix '(N args)' harus dibuang, dapat %q", got[0])
	}
	if !strings.Contains(got[1], "Uncaught ReferenceError") {
		t.Fatalf("pageerror harus terbaca sebagai console error, dapat %q", got[1])
	}
	if len(cleanConsoleErrors(ParseConsoleErrors(""))) != 0 {
		t.Fatal("teks kosong → tidak ada error")
	}
	// Baris error yang menyebut favicon secara eksplisit juga diabaikan.
	fav := "msgid=1 [error] Failed to load resource: http://127.0.0.1:18082/favicon.ico 404"
	if got := cleanConsoleErrors(ParseConsoleErrors(fav)); len(got) != 0 {
		t.Fatalf("baris favicon eksplisit harus diabaikan, dapat %+v", got)
	}
}

func TestParseNetworkFailures(t *testing.T) {
	origin := "http://127.0.0.1:18098"
	text := "## Network requests\nShowing 1-6 of 6 (Page 1 of 1).\n" +
		"reqid=1 GET " + origin + "/healthy.html [200]\n" +
		"reqid=2 GET " + origin + "/tidak-ada.json [404]\n" +
		"reqid=3 GET " + origin + "/favicon.ico [404]\n" +
		"reqid=4 GET " + origin + "/api/app-api/me [401]\n" +
		"reqid=5 GET https://example.com/x.js [500]\n" +
		"reqid=6 GET " + origin + "/putus [net::ERR_CONNECTION_REFUSED]\n" +
		"reqid=7 GET data:image/png;base64,AAAA [200]\n"
	got := parseNetworkFailures(text, origin+"/healthy.html")
	if len(got) != 2 {
		t.Fatalf("harus 2 resource gagal (404 json + net::ERR), dapat %d: %v", len(got), got)
	}
	urls := []string{fmt.Sprint(got[0]["url"]), fmt.Sprint(got[1]["url"])}
	if !strings.Contains(urls[0], "tidak-ada.json") || got[0]["status"] != 404 {
		t.Fatalf("entri pertama harus tidak-ada.json 404, dapat %+v", got[0])
	}
	if !strings.Contains(urls[1], "/putus") || got[1]["error"] != "net::ERR_CONNECTION_REFUSED" {
		t.Fatalf("entri kedua harus /putus net::ERR, dapat %+v", got[1])
	}
}

func TestParseEvaluateResult(t *testing.T) {
	// Bentuk persis chrome-devtools-mcp 1.13.0: fence json berisi string JSON.
	text := "Script ran on page and returned:\n```json\n\"{\\\"status\\\":200,\\\"bodyLen\\\":30}\"\n```"
	var v struct {
		Status  int `json:"status"`
		BodyLen int `json:"bodyLen"`
	}
	if err := parseEvaluateResult(text, &v); err != nil {
		t.Fatalf("parse fence gagal: %v", err)
	}
	if v.Status != 200 || v.BodyLen != 30 {
		t.Fatalf("hasil parse salah: %+v", v)
	}
	// Fallback: JSON objek langsung tanpa fence.
	var v2 struct {
		Status int `json:"status"`
	}
	if err := parseEvaluateResult(`{"status": 404}`, &v2); err != nil || v2.Status != 404 {
		t.Fatalf("parse JSON langsung gagal: %v %+v", err, v2)
	}
}

func TestAcceptanceFailures(t *testing.T) {
	ok := &acceptanceResult{HTTP: 200, HasBody: true, ConsoleErrors: []string{}, FailedAppResources: []map[string]interface{}{}, SDK: map[string]interface{}{"installed": false}}
	if reasons := acceptanceFailures(ok); len(reasons) != 0 {
		t.Fatalf("halaman sehat harus lolos, dapat %v", reasons)
	}
	bad := &acceptanceResult{HTTP: 200, HasBody: true, ConsoleErrors: []string{"SENGAJA_ERROR_XYZ"}, FailedAppResources: []map[string]interface{}{{"url": "http://127.0.0.1:1/x", "status": 404}}, SDK: map[string]interface{}{"installed": false}}
	if reasons := acceptanceFailures(bad); len(reasons) != 2 {
		t.Fatalf("console fatal + resource gagal harus 2 alasan, dapat %v", reasons)
	}
	empty := &acceptanceResult{HTTP: 0, HasBody: false, ConsoleErrors: []string{}, FailedAppResources: []map[string]interface{}{}}
	if reasons := acceptanceFailures(empty); len(reasons) != 2 {
		t.Fatalf("http 0 + body kosong harus 2 alasan, dapat %v", reasons)
	}
}

func TestDedupeFailedResources(t *testing.T) {
	in := []map[string]interface{}{
		{"url": "http://127.0.0.1:1/a", "status": 404},
		{"url": "http://127.0.0.1:1/a", "status": 404},
		{"url": "http://127.0.0.1:1/b", "status": 500},
	}
	if got := dedupeFailedResources(in); len(got) != 2 {
		t.Fatalf("dedupe harus menyisakan 2, dapat %d", len(got))
	}
}

func TestSnapshotHasBody(t *testing.T) {
	snap := "## Latest page snapshot\nuid=1_0 RootWebArea \"Fake\" url=\"http://127.0.0.1:1/\"\n  uid=1_1 heading \"Halo\" level=\"1\"\n"
	if !snapshotHasBody(snap) {
		t.Fatal("snapshot berisi heading harus dianggap punya body")
	}
	if snapshotHasBody("## Latest page snapshot\nuid=1_0 RootWebArea \"Kosong\" url=\"http://127.0.0.1:1/\"\n") {
		t.Fatal("snapshot hanya RootWebArea harus dianggap kosong")
	}
}

// ---------------------------------------------------------------------------
// Fake MCP: acceptance end-to-end tanpa Chrome
// ---------------------------------------------------------------------------

func TestRunAcceptanceFakeHealthy(t *testing.T) {
	ctx := context.Background()
	c := fakeClientMode(t, "healthy")
	if err := c.Start(ctx); err != nil {
		t.Fatalf("Start fake gagal: %v", err)
	}
	res, err := RunAcceptanceWithClient(ctx, c, "http://127.0.0.1:18098/healthy.html")
	if err != nil {
		t.Fatalf("halaman sehat (fake) harus lolos, dapat: %v (hasil %+v)", err, res)
	}
	if res["http"] != float64(200) {
		t.Fatalf("http harus 200, dapat %v", res["http"])
	}
	if res["hasBody"] != true {
		t.Fatalf("hasBody harus true, dapat %v", res["hasBody"])
	}
	errs, _ := res["consoleErrors"].([]interface{})
	if len(errs) != 0 {
		t.Fatalf("consoleErrors halaman sehat harus kosong (error favicon dibuang ParseConsoleErrors), dapat %v", res["consoleErrors"])
	}
	if failed, _ := res["failedAppResources"].([]interface{}); len(failed) != 0 {
		t.Fatalf("failedAppResources halaman sehat harus kosong (favicon diabaikan), dapat %v", failed)
	}
	sdk, _ := res["sdk"].(map[string]interface{})
	if sdk["installed"] != false {
		t.Fatalf("sdk.installed harus false, dapat %v", sdk)
	}
}

func TestRunAcceptanceFakeError(t *testing.T) {
	ctx := context.Background()
	c := fakeClientMode(t, "error")
	if err := c.Start(ctx); err != nil {
		t.Fatalf("Start fake gagal: %v", err)
	}
	res, err := RunAcceptanceWithClient(ctx, c, "http://127.0.0.1:18098/error.html")
	if err == nil {
		t.Fatalf("halaman error (fake) harus gagal, dapat hasil %+v", res)
	}
	if !errors.Is(err, ErrAcceptanceFailed) {
		t.Fatalf("error halaman error harus ErrAcceptanceFailed, dapat: %v", err)
	}
	out, _ := res["output"].(string)
	if !strings.Contains(out, "SENGAJA_ERROR_XYZ") {
		t.Fatalf("output gagal harus memuat console error yang benar, dapat %q", out)
	}
	if !strings.Contains(out, "tidak-ada.json") {
		t.Fatalf("output gagal harus memuat resource 404, dapat %q", out)
	}
	if strings.Contains(out, "favicon.ico") && strings.Contains(out, "failedAppResources") {
		// favicon boleh muncul di consoleErrors, tapi TIDAK di failedAppResources.
		var decoded map[string]interface{}
		_ = json.Unmarshal([]byte(out), &decoded)
		if failed, _ := decoded["failedAppResources"].([]interface{}); len(failed) != 1 {
			t.Fatalf("failedAppResources harus tepat 1 (tidak-ada.json; favicon + 401 auth dikecualikan), dapat %v", failed)
		}
	}
}

func TestCaptureScreenshotFake(t *testing.T) {
	ctx := context.Background()
	c := fakeClientMode(t, "healthy")
	if err := c.Start(ctx); err != nil {
		t.Fatalf("Start fake gagal: %v", err)
	}
	outPath := filepath.Join(t.TempDir(), "sub", "shot.png")
	if err := CaptureScreenshotWithClient(ctx, c, "http://127.0.0.1:18098/healthy.html", outPath); err != nil {
		t.Fatalf("screenshot fake gagal: %v", err)
	}
	data, err := os.ReadFile(outPath)
	if err != nil {
		t.Fatalf("file screenshot harus ada: %v", err)
	}
	if len(data) < 8 || string(data[:8]) != "\x89PNG\r\n\x1a\n" {
		t.Fatalf("file screenshot harus PNG, dapat %d byte header %q", len(data), data[:8])
	}
}

func TestCallAcceptanceToolRejectsNonAllowlist(t *testing.T) {
	ctx := context.Background()
	c := fakeClient(t)
	if err := c.Start(ctx); err != nil {
		t.Fatalf("Start fake gagal: %v", err)
	}
	if _, err := c.callAcceptanceTool(ctx, "take_heapsnapshot", map[string]interface{}{}); err == nil {
		t.Fatal("tool di luar allowlist §5 harus ditolak")
	}
	// navigate_page ada di allowlist tapi BELUM aktif di Fase 1 — acceptance
	// internal BOLEH memakainya (bypass gate aktif, bukan allowlist).
	// Fase 3: port preview harus dikunci dulu (di sini langsung, di
	// produksi dipelajari dari pageURL di RunAcceptanceWithClient).
	if err := c.SetPreviewPort(18098); err != nil {
		t.Fatalf("SetPreviewPort gagal: %v", err)
	}
	if _, err := c.callAcceptanceTool(ctx, "navigate_page", map[string]interface{}{"url": "http://127.0.0.1:18098/healthy.html"}); err != nil {
		t.Fatalf("navigate_page (allowlist, internal) harus lolos gate aktif: %v", err)
	}
	if _, err := c.callAcceptanceTool(ctx, "navigate_page", map[string]interface{}{"url": "https://example.com/"}); err == nil {
		t.Fatal("navigasi ke URL luar harus ditolak ValidateURL")
	}
}

func TestRunAcceptanceRejectsExternalURL(t *testing.T) {
	if _, err := RunAcceptanceWithClient(context.Background(), NewClient(Config{}), "https://example.com/"); err == nil {
		t.Fatal("URL luar harus ditolak sebelum menyentuh browser")
	}
}

// ---------------------------------------------------------------------------
// (c) MCP gagal start → error jelas, bukan sukses palsu
// ---------------------------------------------------------------------------

func TestRunAcceptanceBadChromePath(t *testing.T) {
	t.Setenv(EnvEnableBrowserTools, "1")
	t.Setenv(EnvEnableTenantExec, "1")
	t.Setenv(EnvChromePath, "/tidak/ada/chrome-xyz")
	_, err := RunAcceptance(context.Background(), "http://127.0.0.1:18098/healthy.html")
	if err == nil {
		t.Fatal("Chrome path salah → RunAcceptance harus error, bukan sukses palsu")
	}
	if !strings.Contains(err.Error(), "/tidak/ada/chrome-xyz") {
		t.Fatalf("error harus menyebut path Chrome yang salah, dapat: %v", err)
	}
	if errors.Is(err, ErrAcceptanceFailed) {
		t.Fatal("gagal start MCP bukan ErrAcceptanceFailed (itu verdict halaman)")
	}
}

func TestRunAcceptanceBadMCPCommand(t *testing.T) {
	t.Setenv(EnvEnableBrowserTools, "1")
	t.Setenv(EnvEnableTenantExec, "1")
	t.Setenv(EnvMCPCommand, "/tidak/ada/mcp-xyz")
	_, err := RunAcceptance(context.Background(), "http://127.0.0.1:18098/healthy.html")
	if err == nil {
		t.Fatal("command MCP salah → RunAcceptance harus error, bukan sukses palsu")
	}
	if errors.Is(err, ErrAcceptanceFailed) {
		t.Fatal("gagal start MCP bukan ErrAcceptanceFailed")
	}
}

func TestRunAcceptanceGatingOff(t *testing.T) {
	t.Setenv(EnvEnableBrowserTools, "0")
	t.Setenv(EnvEnableTenantExec, "0")
	_, err := RunAcceptance(context.Background(), "http://127.0.0.1:18098/healthy.html")
	if err == nil {
		t.Fatal("gating mati → RunAcceptance harus error (handler mengembalikan error tegas, tanpa fallback)")
	}
	if !errors.Is(err, ErrBrowserToolsDisabled) {
		t.Fatalf("error harus ErrBrowserToolsDisabled, dapat: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Integrasi: Chrome asli + server MCP asli (di-skip bila
// CHROME_FOR_TESTING_PATH kosong — pola Fase 1)
// ---------------------------------------------------------------------------

const (
	healthyPageHTML = `<!doctype html><html><head><title>Sehat</title></head><body><h1>Halo sehat</h1><p>Ini halaman sehat.</p><script>console.log('halo log');</script></body></html>`
	errorPageHTML   = `<!doctype html><html><head><title>Error</title></head><body><h1>Halaman error</h1><script>fetch('/tidak-ada.json').catch(()=>{}); console.error('SENGAJA_ERROR_XYZ'); undefinedFunctionYangTidakAda();</script></body></html>`
	sdkPageHTML     = `<!doctype html><html><head><title>SDK</title></head><body><h1>SDK</h1><script>window.cloudAuth={me:async()=>{throw new Error('logged out')}}; window.cloudDb={};</script></body></html>`
)

func acceptanceTestServer() *httptest.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthy.html", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, healthyPageHTML)
	})
	mux.HandleFunc("/error.html", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, errorPageHTML)
	})
	mux.HandleFunc("/sdk.html", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, sdkPageHTML)
	})
	return httptest.NewServer(mux)
}

func TestAcceptanceRealChrome(t *testing.T) {
	if strings.TrimSpace(os.Getenv(EnvChromePath)) == "" {
		t.Skip("CHROME_FOR_TESTING_PATH kosong — test acceptance Chrome dilewati")
	}
	t.Setenv(EnvEnableBrowserTools, "1")
	t.Setenv(EnvEnableTenantExec, "1")
	srv := acceptanceTestServer()
	defer srv.Close()
	ctx := context.Background()

	// (b) one-shot: halaman sehat lolos.
	healthyURL := srv.URL + "/healthy.html"
	res, err := RunAcceptance(ctx, healthyURL)
	if err != nil {
		t.Fatalf("halaman sehat harus lolos acceptance MCP, dapat: %v (hasil %+v)", err, res)
	}
	if res["http"] != float64(200) || res["hasBody"] != true {
		t.Fatalf("halaman sehat: http/hasBody salah: %+v", res)
	}
	if failed, _ := res["failedAppResources"].([]interface{}); len(failed) != 0 {
		t.Fatalf("halaman sehat: failedAppResources harus kosong, dapat %v", failed)
	}
	t.Logf("BUKTI sehat: %+v", res)

	// Satu klien per acceptance (pola produksi RunAcceptance: budget
	// per run maks 15 panggilan, satu acceptance memakai 5 — klien yang
	// dipakai ulang untuk 3 acceptance akan kehabisan budget di tengah
	// jalan, dan itu perilaku yang benar, bukan bug test).
	newClient := func() *Client {
		t.Helper()
		tmpDir := t.TempDir()
		client, err := NewClientForRun(0, tmpDir)
		if err != nil {
			t.Fatalf("NewClientForRun gagal: %v", err)
		}
		t.Cleanup(func() { _ = client.Close() })
		if err := client.Start(ctx); err != nil {
			t.Fatalf("Start Chrome gagal: %v", err)
		}
		return client
	}

	// (b) halaman error terdeteksi dengan isi console error yang benar.
	resErr, err := RunAcceptanceWithClient(ctx, newClient(), srv.URL+"/error.html")
	if err == nil {
		t.Fatalf("halaman error harus gagal acceptance, dapat %+v", resErr)
	}
	if !errors.Is(err, ErrAcceptanceFailed) {
		t.Fatalf("error halaman error harus ErrAcceptanceFailed, dapat: %v", err)
	}
	out, _ := resErr["output"].(string)
	for _, want := range []string{"SENGAJA_ERROR_XYZ", "Uncaught ReferenceError", "tidak-ada.json"} {
		if !strings.Contains(out, want) {
			t.Fatalf("output gagal harus memuat %q, dapat %q", want, out)
		}
	}
	t.Logf("BUKTI error: %s", out)

	// Halaman dengan SDK cloudAuth/cloudDb: installed + loggedOut.
	resSDK, err := RunAcceptanceWithClient(ctx, newClient(), srv.URL+"/sdk.html")
	if err != nil {
		t.Fatalf("halaman SDK harus lolos, dapat: %v (%+v)", err, resSDK)
	}
	sdk, _ := resSDK["sdk"].(map[string]interface{})
	if sdk["installed"] != true || sdk["loggedOut"] != true {
		t.Fatalf("sdk harus {installed:true loggedOut:true}, dapat %v", sdk)
	}

	// Screenshot satu tembakan: PNG asli tersimpan.
	shotPath := filepath.Join(t.TempDir(), "acceptance-shot.png")
	if err := CaptureScreenshotWithClient(ctx, newClient(), healthyURL, shotPath); err != nil {
		t.Fatalf("screenshot Chrome gagal: %v", err)
	}
	data, err := os.ReadFile(shotPath)
	if err != nil {
		t.Fatalf("file screenshot harus ada: %v", err)
	}
	if len(data) < 1000 || string(data[:8]) != "\x89PNG\r\n\x1a\n" {
		t.Fatalf("screenshot harus PNG asli >1KB, dapat %d byte", len(data))
	}
	t.Logf("BUKTI screenshot: %s (%d byte PNG)", shotPath, len(data))
}

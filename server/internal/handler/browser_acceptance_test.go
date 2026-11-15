package handler

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"

	"webbuilder/internal/browser"
)

// ---------------------------------------------------------------------------
// Migrasi browserAcceptance ke MCP (Trek B, Fase 2)
// ---------------------------------------------------------------------------

// TestBrowserAcceptanceFlagOffUsesLegacy: flag mati → jalur playwright lama
// dipakai (perilaku persis seperti sebelum Fase 2). Di VM ini skrip lama
// gagal di require (path /opt/webbuilder/... tidak ada) — error itu
// sendiri buktinya jalur lama yang jalan, bukan MCP.
func TestBrowserAcceptanceFlagOffUsesLegacy(t *testing.T) {
	t.Setenv(browser.EnvEnableBrowserTools, "0")
	t.Setenv(browser.EnvEnableTenantExec, "0")
	res, err := browserAcceptance(19998)
	if err == nil {
		t.Fatalf("jalur lama di VM ini harus gagal (path playwright tidak ada), dapat %+v", res)
	}
	out, _ := res["output"].(string)
	if !strings.Contains(out, "playwright-core") && !strings.Contains(out, "Cannot find module") {
		t.Fatalf("error jalur lama harus menyebut playwright-core, dapat %q", out)
	}
}

// TestBrowserAcceptanceFlagOnBadChromeFallsBack: flag nyala tapi Chrome
// tidak ada → fallback ke playwright (deprecated), BUKAN diam-diam sukses
// palsu. Bukti fallback: error yang sama seperti jalur lama.
func TestBrowserAcceptanceFlagOnBadChromeFallsBack(t *testing.T) {
	t.Setenv(browser.EnvEnableBrowserTools, "1")
	t.Setenv(browser.EnvEnableTenantExec, "1")
	t.Setenv(browser.EnvChromePath, "/tidak/ada/chrome-xyz")
	res, err := browserAcceptance(19998)
	if err == nil {
		t.Fatalf("Chrome hilang + fallback playwright rusak harus error, bukan sukses, dapat %+v", res)
	}
	out, _ := res["output"].(string)
	if !strings.Contains(out, "playwright-core") && !strings.Contains(out, "Cannot find module") {
		t.Fatalf("fallback harus menjalankan skrip playwright lama, dapat %q", out)
	}
}

// TestBrowserAcceptanceFlagOnRealChrome: routing ujung-ke-ujung handler →
// MCP (sehat lolos, error terdeteksi dengan console error yang benar).
// Di-skip bila CHROME_FOR_TESTING_PATH kosong (pola Fase 1).
func TestBrowserAcceptanceFlagOnRealChrome(t *testing.T) {
	if strings.TrimSpace(os.Getenv(browser.EnvChromePath)) == "" {
		t.Skip("CHROME_FOR_TESTING_PATH kosong — test acceptance handler dilewati")
	}
	t.Setenv(browser.EnvEnableBrowserTools, "1")
	t.Setenv(browser.EnvEnableTenantExec, "1")
	mux := http.NewServeMux()
	// browserAcceptance(port) membuka root "/" — seperti dev server proyek.
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, `<!doctype html><html><head><title>Sehat</title></head><body><h1>Halo sehat</h1><script>console.log('halo');</script></body></html>`)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	port := 0
	fmt.Sscanf(u.Port(), "%d", &port)

	// Halaman sehat: lolos dengan format hasil lama.
	res, err := browserAcceptance(port)
	if err != nil {
		t.Fatalf("halaman sehat harus lolos via MCP, dapat: %v (%+v)", err, res)
	}
	if res["http"] != float64(200) || res["hasBody"] != true {
		t.Fatalf("format hasil harus {http:200 hasBody:true}, dapat %+v", res)
	}
	if _, ok := res["consoleErrors"]; !ok {
		t.Fatal("format hasil harus punya kunci consoleErrors")
	}
	if _, ok := res["failedAppResources"]; !ok {
		t.Fatal("format hasil harus punya kunci failedAppResources")
	}
	if _, ok := res["sdk"]; !ok {
		t.Fatal("format hasil harus punya kunci sdk")
	}
	t.Logf("BUKTI handler sehat: %+v", res)

	// Halaman error: gagal dengan console error yang benar, TANPA fallback
	// (verdict MCP final — errornya ErrAcceptanceFailed, bukan error infra).
	errSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/tidak-ada.json" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, `<!doctype html><html><head><title>Error</title></head><body><h1>Error</h1><script>fetch('/tidak-ada.json').catch(()=>{}); console.error('SENGAJA_ERROR_XYZ'); undefinedFunctionYangTidakAda();</script></body></html>`)
	}))
	defer errSrv.Close()
	eu, _ := url.Parse(errSrv.URL)
	eport := 0
	fmt.Sscanf(eu.Port(), "%d", &eport)
	resErr, err := browserAcceptance(eport)
	if err == nil {
		t.Fatalf("halaman error harus gagal, dapat %+v", resErr)
	}
	if !strings.Contains(err.Error(), "browser acceptance gagal") {
		t.Fatalf("error harus menyebut 'browser acceptance gagal', dapat: %v", err)
	}
	out, _ := resErr["output"].(string)
	for _, want := range []string{"SENGAJA_ERROR_XYZ", "Uncaught ReferenceError", "tidak-ada.json"} {
		if !strings.Contains(out, want) {
			t.Fatalf("output gagal harus memuat %q, dapat %q", want, out)
		}
	}
	t.Logf("BUKTI handler error: %s", out)
}

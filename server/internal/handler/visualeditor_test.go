package handler

import (
	"strings"
	"testing"
)

func TestInjectPreviewBridge(t *testing.T) {
	html := "<html><head><title>x</title></head><body><div id=\"root\"></div></body></html>"
	out := injectPreviewBridge(html)
	if !strings.Contains(out, previewBridgeMarker) {
		t.Fatal("bridge tidak disisipkan")
	}
	if !strings.Contains(out, `"wb-select"`) || !strings.Contains(out, "wb-set-select") {
		t.Fatal("bridge harus memuat protokol wb-select/wb-set-select")
	}
	if !strings.Contains(out, "getComputedStyle") {
		t.Fatal("bridge harus mengirim gaya terhitung elemen")
	}
	// Disisipkan sebelum </body>, isi asli tetap utuh.
	if !strings.Contains(out, `<div id="root"></div>`) {
		t.Fatal("isi HTML asli berubah")
	}
	if strings.Index(out, previewBridgeMarker) > strings.Index(out, "</body>") {
		t.Fatal("bridge harus berada sebelum </body>")
	}
}

func TestInjectPreviewBridgeNoBody(t *testing.T) {
	out := injectPreviewBridge("<html><p>halo</p></html>")
	if !strings.Contains(out, previewBridgeMarker) {
		t.Fatal("bridge harus ditambahkan di akhir bila tidak ada </body>")
	}
	if !strings.HasSuffix(strings.TrimSpace(out), "</script>") {
		t.Fatal("bridge harus menjadi akhir dokumen bila tidak ada </body>")
	}
}

func TestInjectPreviewBridgeIdempotent(t *testing.T) {
	once := injectPreviewBridge("<html><body><p>x</p></body></html>")
	twice := injectPreviewBridge(once)
	if once != twice {
		t.Fatal("injeksi kedua harus mengembalikan HTML apa adanya")
	}
	if strings.Count(twice, previewBridgeMarker) != 1 {
		t.Fatalf("bridge harus muncul tepat 1x, muncul %d", strings.Count(twice, previewBridgeMarker))
	}
}

func TestShouldInjectPreviewBridge(t *testing.T) {
	cases := map[string]bool{
		"text/html":                 true,
		"text/html; charset=utf-8":  true,
		"TEXT/HTML":                 true,
		"application/javascript":    false,
		"text/css":                  false,
		"application/json":          false,
		"":                          false,
	}
	for ct, want := range cases {
		if got := shouldInjectPreviewBridge(ct); got != want {
			t.Fatalf("shouldInjectPreviewBridge(%q) = %v, want %v", ct, got, want)
		}
	}
}

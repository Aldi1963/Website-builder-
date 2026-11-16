package handler

// Test baris URL preview di system prompt (Trek C):
// previewURLPromptLine hanya menghasilkan baris bila port valid
// (dev server sudah jalan); port 0/tidak valid → "" supaya model
// tidak diberi URL kosong/tebakan (lihat agentpipeline.go).
import (
	"strings"
	"testing"
)

func TestPreviewURLPromptLineNoPort(t *testing.T) {
	for _, port := range []int{0, -1, -18086, 65536, 100000} {
		if got := previewURLPromptLine(port); got != "" {
			t.Fatalf("port %d: harus \"\" (dev server belum jalan), dapat %q", port, got)
		}
	}
}

func TestPreviewURLPromptLineValidPort(t *testing.T) {
	got := previewURLPromptLine(18095)
	for _, want := range []string{
		"http://127.0.0.1:18095/",
		"browser_navigate_page",
		"browser_take_snapshot",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("port valid: baris harus memuat %q, dapat %q", want, got)
		}
	}
	if strings.Contains(got, "about:blank") {
		t.Fatalf("baris tidak boleh menyebut about:blank, dapat %q", got)
	}
}

func TestPreviewURLPromptLineExactURL(t *testing.T) {
	// URL harus persis host+port dev server — bukan tebakan port lain.
	got := previewURLPromptLine(19991)
	if !strings.Contains(got, "http://127.0.0.1:19991/") {
		t.Fatalf("URL harus persis http://127.0.0.1:19991/, dapat %q", got)
	}
	if strings.Contains(got, "19992") || strings.Contains(got, "18086") {
		t.Fatalf("baris tidak boleh memuat port lain, dapat %q", got)
	}
}

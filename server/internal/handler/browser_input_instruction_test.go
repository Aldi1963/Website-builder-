package handler

// Test instruksi alat input browser di system prompt (Fase 4):
// placeholder {{BROWSER_INPUT_INSTRUCTION}} di builderSystemPrompt
// diganti executeAgentPipeline dengan teks yang konsisten dengan flag
// WEBBUILDER_ENABLE_BROWSER_INPUT_TOOLS (lihat agentpipeline.go:310).
import (
	"os"
	"strings"
	"testing"
)

func TestBrowserInputInstructionFlagOff(t *testing.T) {
	t.Setenv("WEBBUILDER_ENABLE_BROWSER_INPUT_TOOLS", "0")
	got := browserInputInstruction()
	if !strings.Contains(got, "Do NOT click") {
		t.Fatalf("flag mati: instruksi harus melarang klik/isi form, dapat %q", got)
	}
	if strings.Contains(got, "browser_click") {
		t.Fatalf("flag mati: instruksi tidak boleh menyebut alat input aktif, dapat %q", got)
	}
}

func TestBrowserInputInstructionFlagOn(t *testing.T) {
	t.Setenv("WEBBUILDER_ENABLE_BROWSER_INPUT_TOOLS", "1")
	got := browserInputInstruction()
	for _, want := range []string{"browser_click", "browser_fill", "browser_fill_form", "browser_press_key", "5 interaction"} {
		if !strings.Contains(got, want) {
			t.Fatalf("flag nyala: instruksi harus menyebut %q, dapat %q", want, got)
		}
	}
	if !strings.Contains(got, "test accounts only") {
		t.Fatalf("flag nyala: instruksi harus melarang kredensial nyata, dapat %q", got)
	}
}

func TestBrowserInputInstructionPlaceholderPresent(t *testing.T) {
	// Tanpa placeholder ini, penggantian di agentpipeline.go tidak
	// terjadi dan prompt akan membawa teks mentah {{...}} ke model.
	if !strings.Contains(builderSystemPrompt, browserInputInstructionPlaceholder) {
		t.Fatal("builderSystemPrompt harus memuat placeholder {{BROWSER_INPUT_INSTRUCTION}}")
	}
	if os.Getenv("WEBBUILDER_ENABLE_BROWSER_INPUT_TOOLS") == "1" {
		t.Skip("flag input nyala di env luar — lewati cek teks mati")
	}
	if strings.Contains(browserInputInstruction(), browserInputInstructionPlaceholder) {
		t.Fatal("hasil browserInputInstruction tidak boleh memuat placeholder mentah")
	}
}

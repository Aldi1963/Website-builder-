package handler

import (
	"strings"
	"testing"

	"webbuilder/internal/database/models"
)

func TestChooseDesignByPrompt(t *testing.T) {
	cases := []struct {
		prompt string
		want   string
	}{
		{"Buatkan aplikasi kasir (POS) dengan login, produk, transaksi, dan laporan", "console"},
		{"Buatkan toko online dengan katalog produk, keranjang, dan checkout", "retail"},
		{"Landing page untuk studio arsitektur dengan portfolio proyek", "editorial"},
		{"Dashboard monitoring realtime untuk crypto trading", "dark-data"},
		{"buatkan crm untuk tim sales", "console"},
	}
	for _, c := range cases {
		got := chooseDesign(&models.Project{}, c.prompt).Name
		if got != c.want {
			t.Errorf("prompt %q -> %s, mau %s", c.prompt, got, c.want)
		}
	}
}

func TestChooseDesignRespectsLockedMemory(t *testing.T) {
	p := &models.Project{Memory: "Brand: Kopi Kita\nDESIGN: retail (Retail / katalog / kasir)"}
	if got := chooseDesign(p, "buatkan dashboard admin dengan grafik"); got.Name != "retail" {
		t.Fatalf("preset terkunci harus dipakai, dapat %s", got.Name)
	}
}

func TestDesignBriefHasTokens(t *testing.T) {
	for name, preset := range designPresets {
		brief := DesignBrief(preset)
		if !strings.Contains(brief, ":root{") || !strings.Contains(brief, "--accent:") {
			t.Errorf("brief %s tidak memuat token CSS", name)
		}
		if len(brief) < 400 {
			t.Errorf("brief %s terlalu pendek: %d", name, len(brief))
		}
		t.Logf("%s: %d byte, accent %s", name, len(brief), preset.Tokens["--accent"])
	}
}

func TestEnsureDesignTokens(t *testing.T) {
	preset := designPresets["editorial"]

	// Proyek yang memakai var(--bg) tanpa mendefinisikannya (kasus nyata).
	files := map[string]string{
		"src/index.css": ".hero{background:var(--bg);color:var(--ink)}",
		"src/main.tsx":  "import React from 'react';",
	}
	path, ok := ensureDesignTokens(files, preset)
	if !ok || path != "src/index.css" {
		t.Fatalf("token tidak disuntik: ok=%v path=%s", ok, path)
	}
	if !strings.Contains(files["src/index.css"], "--accent: #B4472B") {
		t.Fatal("nilai aksen preset tidak masuk")
	}
	if !strings.Contains(files["src/index.css"], ".hero{background:var(--bg)") {
		t.Fatal("CSS asli hilang")
	}
	// Idempoten: pemanggilan kedua tidak boleh menambah apa pun.
	if _, again := ensureDesignTokens(files, preset); again {
		t.Fatal("harus idempoten")
	}
	// Tanpa file CSS sama sekali: dibuatkan dan diimpor dari entry.
	empty := map[string]string{"src/main.tsx": "import App from './App';"}
	if p2, ok2 := ensureDesignTokens(empty, preset); !ok2 || p2 != "src/index.css" {
		t.Fatalf("gagal membuat css baru: %v %s", ok2, p2)
	}
	if !strings.Contains(empty["src/main.tsx"], "import \"./index.css\"") {
		t.Fatal("entry tidak mengimpor index.css")
	}
}

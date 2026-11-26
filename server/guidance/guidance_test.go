package guidance

import (
	"strings"
	"testing"
)

func TestCorpusLoaded(t *testing.T) {
	if n := Count(); n < 150 {
		t.Fatalf("korpus terlalu kecil: %d guide", n)
	}
	t.Logf("guide tersedia: %d", Count())
}

func TestSearchRelevance(t *testing.T) {
	cases := []struct {
		query string
		want  string
	}{
		{"buat modal dialog konfirmasi hapus", "dialog"},
		{"tabel responsif dengan pencarian", "table"},
		{"animasi transisi halaman", "transition"},
		{"form validasi input email", "form"},
		{"dark mode toggle tema", "dark"},
		{"scroll parallax reveal saat scroll", "parallax"},
	}
	for _, c := range cases {
		got := Search(c.query, 3)
		if len(got) == 0 {
			t.Errorf("query %q: tidak ada hasil", c.query)
			continue
		}
		ids := make([]string, 0, len(got))
		match := false
		for _, g := range got {
			ids = append(ids, g.ID)
			if strings.Contains(g.ID, c.want) {
				match = true
			}
		}
		t.Logf("%-42s -> %v", c.query, ids)
		if !match {
			t.Errorf("query %q: tidak ada id mengandung %q (hasil: %v)", c.query, c.want, ids)
		}
	}
}

func TestPromptSectionBudget(t *testing.T) {
	sec, ids := PromptSection("buat landing page dengan modal, animasi transisi, dan tabel harga responsif", 7000)
	if sec == "" || len(ids) == 0 {
		t.Fatal("PromptSection kosong untuk query yang jelas relevan")
	}
	if len(sec) > 7500 {
		t.Fatalf("blok melebihi budget: %d byte", len(sec))
	}
	t.Logf("ids=%v bytes=%d", ids, len(sec))
}

func TestNoMatch(t *testing.T) {
	if sec, _ := PromptSection("zzz qqq xxx", 4000); sec != "" {
		t.Fatalf("query tanpa relevansi seharusnya kosong, dapat %d byte", len(sec))
	}
}

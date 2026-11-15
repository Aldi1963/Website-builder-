// Package guidance memuat korpus "Modern Web Guidance" (GoogleChrome/modern-web-guidance,
// Apache-2.0) dan memilih panduan paling relevan untuk sebuah prompt.
//
// Tujuannya: model bahasa cenderung menghasilkan pola web lama (mis. modal berbasis
// div+transform, polyfill berat). Panduan ini disuntik ke system prompt hanya untuk
// topik yang benar-benar diminta, supaya hemat token dan tepat sasaran.
package guidance

import (
	"embed"
	"io/fs"
	"path"
	"sort"
	"strings"
	"unicode"
)

//go:embed all:guides
var corpus embed.FS

// Guide adalah satu dokumen panduan.
type Guide struct {
	ID          string
	Title       string
	Description string
	Body        string
}

var (
	all   []Guide
	built bool
	// Kosakata Indonesia → istilah Inggris yang dipakai korpus. Tanpa ini prompt
	// berbahasa Indonesia hampir tidak pernah cocok dengan judul guide.
	synonym = map[string][]string{
		"tabel": {"table"}, "responsif": {"responsive"}, "pencarian": {"search"},
		"cari": {"search"}, "animasi": {"animate", "animation"}, "transisi": {"transition"},
		"halaman": {"page"}, "validasi": {"validate", "validation"}, "galat": {"error"},
		"tombol": {"button"}, "gelap": {"dark"}, "terang": {"light"}, "tema": {"theme"},
		"formulir": {"form"}, "isian": {"input", "field"}, "unggah": {"upload"},
		"gambar": {"image"}, "gulir": {"scroll"}, "geser": {"swipe"}, "tarik": {"pull"},
		"notifikasi": {"notification"}, "pemberitahuan": {"notification"},
		"laci": {"drawer"}, "modal": {"dialog"}, "kartu": {"card"},
		"kalender": {"calendar"}, "tanggal": {"date"}, "waktu": {"time"},
		"zona": {"timezone"}, "sorot": {"highlight"}, "pilih": {"select"},
		"daftar": {"list"}, "menu": {"menu"}, "dialog": {"dialog"}, "popover": {"popover"},
		"aksesibilitas": {"accessibility"}, "keamanan": {"security"}, "kinerja": {"performance"},
		"privasi": {"privacy"}, "uang": {"payment"}, "pembayaran": {"payment"},
		"login": {"sign-in"}, "masuk": {"sign-in"}, "daftarakun": {"sign-up"},
		"otomatis": {"autofill"}, "isi-otomatis": {"autofill"},
	}
	stopword = map[string]bool{
		"the": true, "and": true, "for": true, "with": true, "that": true, "this": true,
		"yang": true, "dan": true, "untuk": true, "dengan": true, "saya": true, "bisa": true,
		"buat": true, "buatkan": true, "buatlah": true, "tolong": true, "ingin": true,
		"adalah": true, "akan": true, "dari": true, "pada": true, "juga": true, "nya": true,
		"app": true, "aplikasi": true, "website": true, "web": true, "halaman": true,
		"membuat": true, "sebuah": true, "agar": true, "dalam": true, "tidak": true,
	}
)

// load membaca seluruh korpus sekali (dipanggil lazy saat pencarian pertama).
func load() {
	if built {
		return
	}
	built = true
	_ = fs.WalkDir(corpus, "guides", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(p, ".md") {
			return nil
		}
		raw, rerr := corpus.ReadFile(p)
		if rerr != nil {
			return nil
		}
		id := strings.TrimSuffix(strings.TrimPrefix(p, "guides/"), ".md")
		all = append(all, Guide{
			ID:          id,
			Title:       firstHeading(string(raw), id),
			Description: firstParagraph(string(raw)),
			Body:        string(raw),
		})
		return nil
	})
}

func firstHeading(s, fallback string) string {
	for _, line := range strings.Split(s, "\n") {
		if strings.HasPrefix(line, "# ") {
			return strings.TrimSpace(line[2:])
		}
	}
	base := path.Base(fallback)
	return strings.ReplaceAll(base, "-", " ")
}

func firstParagraph(s string) string {
	lines := strings.Split(s, "\n")
	var b strings.Builder
	started := false
	for _, line := range lines {
		t := strings.TrimSpace(line)
		if strings.HasPrefix(t, "## Overview") {
			started = true
			continue
		}
		if !started {
			if t == "" || strings.HasPrefix(t, "#") {
				continue
			}
			started = true
		}
		if t == "" {
			if b.Len() > 0 {
				break
			}
			continue
		}
		if strings.HasPrefix(t, "#") {
			continue
		}
		if b.Len() > 0 {
			b.WriteByte(' ')
		}
		b.WriteString(t)
		if b.Len() > 400 {
			break
		}
	}
	out := b.String()
	if len(out) > 400 {
		out = out[:400] + "…"
	}
	return out
}

func tokens(s string) []string {
	fields := strings.FieldsFunc(strings.ToLower(s), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	})
	out := make([]string, 0, len(fields)*2)
	seen := map[string]bool{}
	add := func(t string) {
		if len(t) < 3 || stopword[t] || seen[t] {
			return
		}
		seen[t] = true
		out = append(out, t)
	}
	for _, f := range fields {
		add(f)
		for _, alt := range synonym[f] {
			for _, a := range strings.Split(alt, " ") {
				add(a)
			}
		}
	}
	return out
}

// Search mengembalikan guide paling relevan (maks k) untuk query bebas.
// Skor: judul/path lebih kuat daripada isi; hanya guide berskor > 0 yang dipakai.
func Search(query string, k int) []Guide {
	load()
	if k <= 0 {
		return nil
	}
	qTok := tokens(query)
	if len(qTok) == 0 {
		return nil
	}
	type scored struct {
		g Guide
		s float64
	}
	var hits []scored
	for _, g := range all {
		title := strings.ToLower(g.Title)
		id := strings.ToLower(g.ID)
		desc := strings.ToLower(g.Description)
		body := strings.ToLower(g.Body)
		var score float64
		strong := false // minimal satu kecocokan judul/id/deskripsi
		for _, t := range qTok {
			if strings.Contains(title, t) {
				score += 3
				strong = true
			}
			if strings.Contains(id, t) {
				score += 2
				strong = true
			}
			if strings.Contains(desc, t) {
				score += 1.5
				strong = true
			}
			if n := strings.Count(body, t); n > 0 {
				if n > 6 {
					n = 6
				}
				score += 0.3 * float64(n)
			}
		}
		// Kecocokan isi saja tidak cukup: kata acak sering muncul sekali di contoh
		// kode dan dulu membuat query tak relevan tetap menyuntik panduan.
		if strong && score >= 2.5 {
			hits = append(hits, scored{g, score})
		}
	}
	sort.SliceStable(hits, func(i, j int) bool {
		if hits[i].s == hits[j].s {
			return len(hits[i].g.Body) < len(hits[j].g.Body)
		}
		return hits[i].s > hits[j].s
	})
	if len(hits) > k {
		hits = hits[:k]
	}
	out := make([]Guide, 0, len(hits))
	for _, h := range hits {
		out = append(out, h.g)
	}
	return out
}

// trim memotong body pada batas heading agar tidak memutus kalimat/kode.
func trim(body string, limit int) string {
	if len(body) <= limit {
		return body
	}
	cut := body[:limit]
	if i := strings.LastIndex(cut, "\n## "); i > limit/3 {
		cut = cut[:i]
	} else if i := strings.LastIndex(cut, "\n\n"); i > limit/2 {
		cut = cut[:i]
	}
	return cut + "\n\n[petunjuk dipotong — bagian lain tetap berlaku]"
}

// PromptSection membangun blok system-prompt untuk query tertentu.
// Mengembalikan "" bila tidak ada guide relevan. maxBytes membatasi ukuran total.
func PromptSection(query string, maxBytes int) (string, []string) {
	if maxBytes <= 0 {
		maxBytes = 7000
	}
	guides := Search(query, 3)
	if len(guides) == 0 {
		return "", nil
	}
	var b strings.Builder
	ids := make([]string, 0, len(guides))
	b.WriteString("MODERN WEB GUIDANCE (korpus resmi GoogleChrome/modern-web-guidance; WAJIB diikuti saat menulis HTML/CSS/JS klien):\n")
	b.WriteString("- Utamakan API platform modern daripada library/polyfill; gunakan fallback ringan bila fitur belum didukung.\n")
	b.WriteString("- Jangan mengarang API. Terapkan pola pada panduan di bawah bila relevan dengan permintaan user.\n")
	for _, g := range guides {
		remaining := maxBytes - b.Len()
		if remaining < 900 {
			break
		}
		body := trim(g.Body, remaining-200)
		b.WriteString("\n--- GUIDE: " + g.ID + " (" + g.Title + ") ---\n")
		b.WriteString(body)
		b.WriteString("\n")
		ids = append(ids, g.ID)
	}
	if len(ids) == 0 {
		return "", nil
	}
	return b.String(), ids
}

// Count mengembalikan jumlah guide yang tersedia (untuk diagnosa).
func Count() int {
	load()
	return len(all)
}

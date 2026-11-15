package handler

import (
	"fmt"
	"sort"
	"strings"

	"webbuilder/internal/database/models"
)

// DesignBrief adalah lapisan "design system" yang menentukan token nyata
// (warna, tipografi, radius, ritme spasi) untuk satu proyek. Tujuannya
// menghapus output seragam ala template: satu preset dipilih dari permintaan
// user, dikunci di memory proyek, lalu dipatuhi pada setiap iterasi.
type DesignPreset struct {
	Name       string
	Label      string
	Tokens     map[string]string
	Rules      []string
	FontImport string
}

var designPresets = map[string]DesignPreset{
	"editorial": {
		Name:       "editorial",
		Label:      "Editorial / brand",
		FontImport: `@import url("https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@400;500;600;700&display=swap");`, 
		Tokens: map[string]string{
			"--bg":     "#FBF9F4",
			"--surface": "#FFFFFF",
			"--ink":    "#14120F",
			"--muted":  "#6F6A62",
			"--line":   "#E4DED2",
			"--accent": "#B4472B",
			"--accent-ink": "#FFFFFF",
			"--radius": "3px",
			"--font-display": "Instrument Serif, Georgia, serif",
			"--font-body":    "Inter, system-ui, sans-serif",
			"--shadow": "0 1px 2px rgba(20,18,15,.06)",
		},
		Rules: []string{
			"Headline besar dengan serif display, body 16-17px/1.7 sans; ukuran judul minimal 2.2x body.",
			"Banyak ruang kosong: section padding minimal 88px desktop, 56px mobile; lebar teks maksimal 68ch.",
			"Border 1px sebagai pemisah utama, hindari bayangan tebal.",
		},
	},
	"console": {
		Name:  "console",
		Label: "Product console / dashboard",
		Tokens: map[string]string{
			"--bg":     "#F5F7F5",
			"--surface": "#FFFFFF",
			"--ink":    "#101418",
			"--muted":  "#5C6660",
			"--line":   "#E3E8E3",
			"--accent": "#16653F",
			"--accent-ink": "#FFFFFF",
			"--radius": "10px",
			"--font-display": "Inter, system-ui, sans-serif",
			"--font-body":    "Inter, system-ui, sans-serif",
			"--shadow": "0 1px 3px rgba(16,20,24,.08)",
		},
		Rules: []string{
			"UI padat tapi lapang: body 13-14px, tabel 13px dengan font-variant-numeric: tabular-nums.",
			"Sidebar 240px dengan label 13px; konten utama maksimal 1280px; jarak antar kartu 16px.",
			"Angka penting pakai 28-32px semibold; status pakai badge kecil, bukan teks berwarna penuh.",
			"Setiap halaman wajib punya state loading (skeleton), kosong (ajakan aksi), dan error (cara pulih).",
		},
	},
	"retail": {
		Name:  "retail",
		Label: "Retail / katalog / kasir",
		Tokens: map[string]string{
			"--bg":     "#FFFDF8",
			"--surface": "#FFFFFF",
			"--ink":    "#1B1714",
			"--muted":  "#6B625B",
			"--line":   "#EDE4D8",
			"--accent": "#C2410C",
			"--accent-ink": "#FFFFFF",
			"--radius": "14px",
			"--font-display": "Inter, system-ui, sans-serif",
			"--font-body":    "Inter, system-ui, sans-serif",
			"--shadow": "0 6px 24px rgba(27,23,20,.07)",
		},
		Rules: []string{
			"Kartu produk dengan gambar 4:3, nama 14px semibold, harga 15px semibold, stok sebagai teks kecil.",
			"Tombol aksi utama lebar penuh di mobile, 44px tinggi minimum; target sentuh tidak di bawah 40px.",
			"Grid produk: 2 kolom di mobile, 3 di tablet, 4 di desktop; gap 16px.",
		},
	},
	"dark-data": {
		Name:  "dark-data",
		Label: "Dark analytics",
		Tokens: map[string]string{
			"--bg":     "#0B0F0E",
			"--surface": "#121917",
			"--ink":    "#E9F1EA",
			"--muted":  "#93A29A",
			"--line":   "#222C28",
			"--accent": "#A3E635",
			"--accent-ink": "#0B0F0E",
			"--radius": "12px",
			"--font-display": "Inter, system-ui, sans-serif",
			"--font-body":    "Inter, system-ui, sans-serif",
			"--shadow": "0 8px 30px rgba(0,0,0,.35)",
		},
		Rules: []string{
			"Latar gelap, panel sedikit lebih terang, border 1px sebagai pemisah; jangan pakai bayangan besar.",
			"Grafik: aksen tunggal + turunan opacity, garis grid halus, label sumbu 11px.",
			"Kontras teks minimal 4.5:1; jangan memakai teks abu di atas panel gelap tanpa uji kontras.",
		},
	},
}

var designKeywords = map[string][]string{
	"console":   {"dashboard", "admin", "crm", "saas", "pos", "kasir", "erp", "inventory", "inventaris", "laporan", "analitik", "hrd", "keuangan", "booking", "manajemen", "panel"},
	"retail":    {"toko", "katalog", "produk", "belanja", "keranjang", "checkout", "restoran", "menu", "kasir", "retail", "e-commerce", "ecommerce", "jualan", "order"},
	"dark-data": {"monitoring", "realtime", "trading", "crypto", "iot", "log", "devops", "fintech", "analytics", "dashboard gelap"},
	"editorial": {"portfolio", "agency", "studio", "arsitek", "brand", "blog", "artikel", "landing", "company profile", "undangan", "sekolah", "kursus", "yayasan", "event"},
}

// chooseDesign menentukan preset secara deterministik:
// 1) memory proyek bila sudah pernah dikunci, 2) skor kata kunci dari prompt,
// 3) fallback editorial. Tanpa langkah ini setiap proyek memakai palet yang sama.
func chooseDesign(p *models.Project, prompt string) DesignPreset {
	if p != nil && p.Memory != "" {
		for name := range designPresets {
			if strings.Contains(strings.ToLower(p.Memory), "design: "+name) {
				return designPresets[name]
			}
		}
	}
	l := strings.ToLower(prompt)
	best, bestScore := "editorial", 0
	names := make([]string, 0, len(designKeywords))
	for n := range designKeywords {
		names = append(names, n)
	}
	sort.Strings(names) // deterministik saat skor imbang
	for _, name := range names {
		score := 0
		for _, kw := range designKeywords[name] {
			if strings.Contains(l, kw) {
				score++
			}
		}
		if score > bestScore {
			best, bestScore = name, score
		}
	}
	return designPresets[best]
}

// DesignBrief menghasilkan blok system-prompt berisi token dan aturan preset.
func DesignBrief(d DesignPreset) string {
	var b strings.Builder
	b.WriteString("DESIGN SYSTEM (WAJIB, preset: " + d.Label + ")\n")
	b.WriteString("Pakai token ini sebagai sumber tunggal warna/jarak; tulis sebagai CSS variables di src/index.css lalu rujuk lewat Tailwind arbitrary value, misal bg-[var(--bg)] text-[var(--ink)] border-[var(--line)].\n")
	keys := make([]string, 0, len(d.Tokens))
	for k := range d.Tokens {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	b.WriteString(":root{\n")
	for _, k := range keys {
		b.WriteString(fmt.Sprintf("  %s: %s;\n", k, d.Tokens[k]))
	}
	b.WriteString("}\nATURAN:\n")
	for _, r := range d.Rules {
		b.WriteString("- " + r + "\n")
	}
	b.WriteString("- Satu aksen saja untuk aksi utama; jangan pakai ungu/biru bawaan, jangan gradient text.\n")
	b.WriteString("- Ikon dari Lucide, tanpa emoji sebagai ikon; radius konsisten memakai --radius.\n")
	b.WriteString("- Fokus keyboard wajib terlihat: outline 2px var(--accent) offset 2px.\n")
	b.WriteString("- Tipografi: maksimal 2 keluarga font, skala 12/13/14/16/20/28/40px; line-height 1.5 body, 1.1 judul.\n")
	b.WriteString("- Responsif nyata: uji lebar 390px; tidak boleh ada scroll horizontal.\n")
	return b.String()
}

// ensureDesignTokens menjamin token preset benar-benar ADA di CSS proyek.
// Model sering memakai var(--bg)/var(--line) tanpa mendefinisikannya, sehingga
// aplikasi tampil transparan/hitam. Fungsi ini menambahkan :root{...} bila hilang.
func ensureDesignTokens(files map[string]string, d DesignPreset) (string, bool) {
	target := ""
	for _, cand := range []string{"src/index.css", "src/styles.css", "src/app.css", "src/App.css"} {
		if _, ok := files[cand]; ok {
			target = cand
			break
		}
	}
	if target == "" {
		target = "src/index.css"
		files[target] = ""
		// Pastikan CSS benar-benar dimuat oleh bundler.
		for _, entry := range []string{"src/main.tsx", "src/main.jsx", "src/index.tsx"} {
			if src, ok := files[entry]; ok {
				if !strings.Contains(src, "index.css") {
					files[entry] = "import \"./index.css\";\n" + src
				}
				break
			}
		}
	}
	if strings.Contains(files[target], "--accent") {
		// Token sudah ada (biasanya karena model menaati brief). Font & guard
		// tetap dipasang sekali agar hasilnya sesuai preset.
		changed := false
		if d.FontImport != "" && !strings.Contains(files[target], "fonts.googleapis.com") {
			files[target] = d.FontImport + "\n" + files[target]
			changed = true
		}
		if !strings.Contains(files[target], "Design guard") {
			files[target] += designGuard()
			changed = true
		}
		if changed {
			return target, true
		}
		return "", false
	}
	keys := make([]string, 0, len(d.Tokens))
	for k := range d.Tokens {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	if d.FontImport != "" && !strings.Contains(files[target], "fonts.googleapis.com") {
		b.WriteString(d.FontImport + "\n")
	}
	b.WriteString("/* Design tokens (preset " + d.Name + ") — sumber tunggal warna & jarak. */\n:root{\n")
	for _, k := range keys {
		b.WriteString(fmt.Sprintf("  %s: %s;\n", k, d.Tokens[k]))
	}
	b.WriteString("}\nhtml{background:var(--bg);color:var(--ink)}\n")
	// Aturan dasar ditempel di AKHIR file: model sering menimpa font judul dengan
	// aturan sendiri, dan pada spesifisitas sama deklarasi terakhir yang menang.
	files[target] = b.String() + "\n" + files[target] + designGuard()
	return target, true
}

// designGuard adalah aturan dasar preset yang dipasang di akhir CSS proyek.
func designGuard() string {
	return "\n/* Design guard: tipografi & permukaan konsisten dengan preset. */\n" +
		"body{margin:0;font-family:var(--font-body);background:var(--bg);color:var(--ink);-webkit-font-smoothing:antialiased}\n" +
		"h1,h2,h3{font-family:var(--font-display);letter-spacing:-.02em;line-height:1.1}\n" +
		":focus-visible{outline:2px solid var(--accent);outline-offset:2px}\n" +
		"button,input,select,textarea{font:inherit}\n"
}

// Clone dari URL: tempel URL website publik -> di-scrape (HTML + CSS +
// aset utama) -> dibangun ulang sebagai proyek React/TypeScript lewat
// pipeline agent yang sama dengan chat build (kontrak proyek, build,
// verifikasi browser).
//
// Pendekatan regenerasi (bukan salinan):
//   - Yang dikirim ke LLM hanya RINGKASAN terstruktur: judul, heading,
//     navigasi, teks terlihat (dibatasi), palet warna + font dari CSS, dan
//     daftar gambar (alt + jumlah). HTML/CSS/JS sumber TIDAK diteruskan
//     verbatim, dan aset biner (gambar/font) TIDAK diunduh/dikopi.
//   - Prompt clone memerintahkan model menulis ulang copy dengan kata-kata
//     sendiri, memakai visual placeholder (gradien/CSS, tanpa hotlink aset
//     berhak cipta), dan membangun aplikasi React/TS multi-file sesuai
//     kontrak proyek (contract.go).
//
// Batas + gagal-bersih:
//   - robots.txt WAJIB dihormati: bila path disallow -> 403, tanpa proyek.
//   - URL hanya http/https, host publik (SSRF guard: tolak loopback,
//     private, link-local, multicast, userinfo, port non-standar).
//   - Timeout fetch 15 dtk, HTML maks 2 MB, CSS maks 3 file @ 200 KB.
//   - Semua validasi + scrape jalan SEBELUM proyek dibuat: URL yang tidak
//     bisa diakses tidak meninggalkan proyek setengah jadi.
package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"

	"webbuilder/internal/database/models"
	"webbuilder/internal/queue"

	"github.com/gin-gonic/gin"
	"golang.org/x/net/html"
	"gorm.io/gorm"
)

const (
	// cloneUserAgent dipakai untuk fetch halaman + robots.txt.
	cloneUserAgent = "WebBuilder-clone-bot/1.0"

	cloneFetchTimeout   = 15 * time.Second
	cloneRobotsTimeout  = 10 * time.Second
	cloneMaxHTMLBytes   = 2 << 20 // 2 MB
	cloneMaxCSSBytes    = 200 << 10
	cloneMaxStylesheets = 3
	cloneMaxRobotsBytes = 256 << 10
	cloneMaxTextChars   = 6000
	cloneMaxRedirects   = 5
)

// cloneValidateURL adalah seam uji untuk validateCloneURL: scrape
// stylesheet memakai penunjuk ini supaya tes httptest (127.0.0.1)
// tetap bisa menguji jalur CSS tanpa melemahkan guard produksi
// (validateCloneURL sendiri diuji terpisah).
var cloneValidateURL func(string) error = func(raw string) error {
	_, err := validateCloneURL(raw)
	return err
}

// validateCloneURL memeriksa URL clone: skema http/https, tanpa userinfo,
// port standar saja, dan host harus resolve ke IP publik. Dipakai untuk
// URL awal dan setiap hop redirect (SSRF guard).
func validateCloneURL(raw string) (*url.URL, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u == nil {
		return nil, fmt.Errorf("URL tidak valid")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, fmt.Errorf("URL harus http:// atau https://")
	}
	if u.User != nil {
		return nil, fmt.Errorf("URL tidak boleh mengandung kredensial")
	}
	if u.Host == "" {
		return nil, fmt.Errorf("URL harus punya host")
	}
	if port := u.Port(); port != "" && port != "80" && port != "443" {
		return nil, fmt.Errorf("port URL tidak diizinkan")
	}
	host := strings.ToLower(u.Hostname())
	if host == "" || host == "localhost" || strings.HasSuffix(host, ".local") || strings.HasSuffix(host, ".localhost") {
		return nil, fmt.Errorf("host lokal/intranet tidak diizinkan")
	}
	ips, err := net.LookupIP(host)
	if err != nil || len(ips) == 0 {
		return nil, fmt.Errorf("host tidak bisa di-resolve: %s", host)
	}
	for _, ip := range ips {
		if !isPublicIP(ip) {
			return nil, fmt.Errorf("host mengarah ke alamat non-publik")
		}
	}
	return u, nil
}

// isPublicIP true hanya untuk alamat unicast global (bukan loopback,
// private, link-local, multicast, atau unspecified).
func isPublicIP(ip net.IP) bool {
	if ip == nil {
		return false
	}
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() {
		return false
	}
	return true
}

// cloneHTTPClient: client fetch dengan timeout, batas redirect, dan
// validasi ulang host tiap hop redirect.
func cloneHTTPClient(timeout time.Duration) *http.Client {
	return &http.Client{
		Timeout: timeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= cloneMaxRedirects {
				return fmt.Errorf("terlalu banyak redirect (maks %d)", cloneMaxRedirects)
			}
			if _, err := validateCloneURL(req.URL.String()); err != nil {
				return fmt.Errorf("redirect ke URL tidak diizinkan: %w", err)
			}
			return nil
		},
	}
}

// ── robots.txt ──

type robotsRule struct {
	pattern string // prefix path; "*" = wildcard, akhir "$" = akhir path
	allow   bool
}

type robotsRules struct {
	rules []robotsRule
}

// parseRobotsRules mengekstrak aturan yang berlaku untuk user-agent kita
// (grup "*" atau yang menyebut "webbuilder") dari isi robots.txt.
// Grup = baris-baris User-agent berurutan diikuti aturan; grup baru
// dimulai bila User-agent muncul sesudah sebuah aturan.
func parseRobotsRules(body string) robotsRules {
	var out robotsRules
	var curAgents []string
	var curApplies bool
	seenRule := false
	for _, line := range strings.Split(body, "\n") {
		if i := strings.Index(line, "#"); i >= 0 {
			line = line[:i]
		}
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		key, val, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		key = strings.ToLower(strings.TrimSpace(key))
		val = strings.TrimSpace(val)
		switch key {
		case "user-agent":
			if seenRule {
				// Grup baru: aturan grup lama sudah terkumpul.
				curAgents = nil
				curApplies = false
				seenRule = false
			}
			agent := strings.ToLower(val)
			curAgents = append(curAgents, agent)
			if agent == "*" || strings.Contains(agent, "webbuilder") {
				curApplies = true
			}
		case "disallow", "allow":
			seenRule = true
			if !curApplies || val == "" {
				continue
			}
			out.rules = append(out.rules, robotsRule{pattern: val, allow: key == "allow"})
		default:
			// Sitemap, Crawl-delay, dsb. diabaikan.
		}
	}
	return out
}

// robotsMatch: cocokkan path terhadap pola robots (prefix + "*" wildcard
// + "$" akhir). Pola kosong tidak pernah cocok.
func robotsMatch(pattern, path string) bool {
	if pattern == "" {
		return false
	}
	anchored := strings.HasSuffix(pattern, "$")
	pattern = strings.TrimSuffix(pattern, "$")
	parts := strings.Split(pattern, "*")
	if len(parts) == 1 {
		if anchored {
			return path == pattern
		}
		return strings.HasPrefix(path, pattern)
	}
	// Wildcard: semua segmen harus muncul berurutan.
	pos := 0
	for i, seg := range parts {
		if seg == "" {
			continue
		}
		idx := strings.Index(path[pos:], seg)
		if idx < 0 {
			return false
		}
		if i == 0 && idx != 0 {
			return false
		}
		pos += idx + len(seg)
	}
	if anchored && pos != len(path) {
		return false
	}
	return true
}

// allowedByRobots: aturan terpanjang yang cocok menang; bila panjang
// sama, Allow menang atas Disallow. Tanpa aturan yang cocok -> diizinkan.
func (r robotsRules) allowedByRobots(path string) bool {
	bestLen := -1
	allowed := true
	for _, rule := range r.rules {
		if !robotsMatch(rule.pattern, path) {
			continue
		}
		l := len(strings.TrimSuffix(rule.pattern, "$"))
		if l > bestLen || (l == bestLen && rule.allow) {
			bestLen = l
			allowed = rule.allow
		}
	}
	return allowed
}

// fetchRobotsAllowed mengambil robots.txt origin dan memeriksa apakah
// path diizinkan. Gagal fetch / status bukan 200 / isi kosong dianggap
// tidak ada robots.txt -> diizinkan (perilaku standar crawler).
func fetchRobotsAllowed(client *http.Client, pageURL *url.URL) (bool, error) {
	robotsURL := &url.URL{Scheme: pageURL.Scheme, Host: pageURL.Host, Path: "/robots.txt"}
	ctx, cancel := context.WithTimeout(context.Background(), cloneRobotsTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, robotsURL.String(), nil)
	if err != nil {
		return true, nil
	}
	req.Header.Set("User-Agent", cloneUserAgent)
	resp, err := client.Do(req)
	if err != nil || resp == nil {
		return true, nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return true, nil
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, cloneMaxRobotsBytes))
	if err != nil {
		return true, nil
	}
	return parseRobotsRules(string(body)).allowedByRobots(pageURL.Path), nil
}

// ── Scrape halaman ──

type cloneBrief struct {
	URL         string   `json:"url"`
	Title       string   `json:"title"`
	Description string   `json:"description"`
	Headings    []string `json:"headings"`
	NavItems    []string `json:"navItems"`
	Text        string   `json:"text"`
	Colors      []string `json:"colors"`
	Fonts       []string `json:"fonts"`
	ImageCount  int      `json:"imageCount"`
	ImageAlts   []string `json:"imageAlts"`
}

var (
	hexColorRe   = regexp.MustCompile(`#[0-9a-fA-F]{3,8}\b`)
	fontFamilyRe = regexp.MustCompile(`(?i)font-family\s*:\s*([^;}{]+)`)
)

// extractColorsFonts mengumpulkan palet (hex unik, maks 12) dan nama
// font (maks 8) dari sepotong CSS. CSS sumber tidak disimpan verbatim.
func extractColorsFonts(css string, colors, fonts map[string]bool) {
	for _, c := range hexColorRe.FindAllString(css, -1) {
		if len(colors) < 12 {
			colors[strings.ToLower(c)] = true
		}
	}
	for _, m := range fontFamilyRe.FindAllStringSubmatch(css, -1) {
		if len(fonts) >= 8 {
			break
		}
		for _, fam := range strings.Split(m[1], ",") {
			fam = strings.Trim(strings.TrimSpace(fam), `"'`)
			if fam != "" && !strings.EqualFold(fam, "sans-serif") &&
				!strings.EqualFold(fam, "serif") && !strings.EqualFold(fam, "monospace") {
				fonts[fam] = true
			}
		}
	}
}

// scrapePage mengambil HTML halaman (maks 2 MB) + sampai 3 stylesheet
// tertaut, lalu merangkumnya ke cloneBrief. Aset biner tidak diunduh.
func scrapePage(client *http.Client, pageURL *url.URL) (*cloneBrief, error) {
	ctx, cancel := context.WithTimeout(context.Background(), cloneFetchTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, pageURL.String(), nil)
	if err != nil {
		return nil, fmt.Errorf("URL tidak bisa dibuka: %w", err)
	}
	req.Header.Set("User-Agent", cloneUserAgent)
	req.Header.Set("Accept", "text/html,application/xhtml+xml")
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("URL tidak bisa diakses: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf("halaman tidak ditemukan (HTTP 404)")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 400 {
		return nil, fmt.Errorf("server sumber menjawab HTTP %d", resp.StatusCode)
	}
	ct := strings.ToLower(resp.Header.Get("Content-Type"))
	if ct != "" && !strings.Contains(ct, "html") {
		return nil, fmt.Errorf("URL bukan halaman HTML (Content-Type: %s)", resp.Header.Get("Content-Type"))
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, cloneMaxHTMLBytes+1))
	if err != nil {
		return nil, fmt.Errorf("gagal membaca halaman: %w", err)
	}
	if len(body) > cloneMaxHTMLBytes {
		return nil, fmt.Errorf("halaman terlalu besar (maks %d MB)", cloneMaxHTMLBytes>>20)
	}
	doc, err := html.Parse(strings.NewReader(string(body)))
	if err != nil {
		return nil, fmt.Errorf("HTML tidak bisa dibaca: %w", err)
	}
	brief := &cloneBrief{URL: pageURL.String()}
	colors := map[string]bool{}
	fonts := map[string]bool{}
	var cssHrefs []string
	var textParts []string
	var walk func(*html.Node, bool, bool)
	inBody := false
	// skipText: jangan kumpulkan teks dari script/style/noscript/svg/iframe.
	// Elemen itu tetap diproses sendiri (style dibaca warnanya, dst.), hanya
	// anak teksnya yang tidak masuk teks terlihat. "head" TIDAK masuk sini:
	// title/meta/link/style ada di dalam head dan wajib tetap dibaca.
	skipTextTags := map[string]bool{"script": true, "style": true, "noscript": true, "svg": true, "iframe": true}
	walk = func(n *html.Node, inNav bool, skipText bool) {
		if n.Type == html.ElementNode {
			switch n.Data {
			case "body":
				inBody = true
			case "title":
				if n.FirstChild != nil {
					brief.Title = strings.TrimSpace(n.FirstChild.Data)
				}
			case "meta":
				var name, content string
				for _, a := range n.Attr {
					if a.Key == "name" || a.Key == "property" {
						name = strings.ToLower(a.Val)
					}
					if a.Key == "content" {
						content = a.Val
					}
				}
				if (name == "description" || name == "og:description") && brief.Description == "" {
					brief.Description = strings.TrimSpace(content)
				}
			case "link":
				var rel, href string
				for _, a := range n.Attr {
					if a.Key == "rel" {
						rel = strings.ToLower(a.Val)
					}
					if a.Key == "href" {
						href = a.Val
					}
				}
				if strings.Contains(rel, "stylesheet") && href != "" && len(cssHrefs) < cloneMaxStylesheets {
					if abs, err := pageURL.Parse(href); err == nil {
						cssHrefs = append(cssHrefs, abs.String())
					}
				}
			case "style":
				if n.FirstChild != nil {
					extractColorsFonts(n.FirstChild.Data, colors, fonts)
				}
			case "img":
				brief.ImageCount++
				for _, a := range n.Attr {
					if a.Key == "alt" && strings.TrimSpace(a.Val) != "" && len(brief.ImageAlts) < 10 {
						brief.ImageAlts = append(brief.ImageAlts, strings.TrimSpace(a.Val))
					}
				}
			}
			if skipTextTags[n.Data] {
				skipText = true
			}
			if n.Data == "nav" || n.Data == "header" {
				inNav = true
			}
		}
		if n.Type == html.TextNode && inBody && !skipText {
			t := strings.TrimSpace(n.Data)
			if t != "" {
				if inNav && len(brief.NavItems) < 12 && len(t) < 60 {
					brief.NavItems = append(brief.NavItems, t)
				}
				textParts = append(textParts, t)
			}
		}
		// Heading: ambil teks langsung anak heading.
		if n.Type == html.ElementNode && (n.Data == "h1" || n.Data == "h2" || n.Data == "h3") && len(brief.Headings) < 12 {
			var sb strings.Builder
			var collect func(*html.Node)
			collect = func(x *html.Node) {
				if x.Type == html.TextNode {
					sb.WriteString(x.Data)
				}
				for c := x.FirstChild; c != nil; c = c.NextSibling {
					collect(c)
				}
			}
			collect(n)
			if h := strings.TrimSpace(sb.String()); h != "" {
				brief.Headings = append(brief.Headings, h)
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c, inNav, skipText)
		}
	}
	walk(doc, false, false)

	// Stylesheet tertaut: ambil palet + font saja (bukan isi CSS utuh).
	for _, href := range cssHrefs {
		cssURL, err := url.Parse(href)
		if err != nil {
			continue
		}
		if err := cloneValidateURL(cssURL.String()); err != nil {
			continue
		}
		cctx, ccancel := context.WithTimeout(context.Background(), cloneFetchTimeout)
		creq, err := http.NewRequestWithContext(cctx, http.MethodGet, cssURL.String(), nil)
		if err != nil {
			ccancel()
			continue
		}
		creq.Header.Set("User-Agent", cloneUserAgent)
		cresp, err := client.Do(creq)
		if err != nil || cresp == nil {
			ccancel()
			continue
		}
		if cresp.StatusCode == http.StatusOK {
			css, _ := io.ReadAll(io.LimitReader(cresp.Body, cloneMaxCSSBytes+1))
			if len(css) <= cloneMaxCSSBytes {
				extractColorsFonts(string(css), colors, fonts)
			}
		}
		cresp.Body.Close()
		ccancel()
	}

	text := strings.Join(textParts, " ")
	text = strings.Join(strings.Fields(text), " ")
	if len(text) > cloneMaxTextChars {
		text = text[:cloneMaxTextChars] + "…"
	}
	brief.Text = text
	for c := range colors {
		brief.Colors = append(brief.Colors, c)
	}
	sort.Strings(brief.Colors)
	for f := range fonts {
		brief.Fonts = append(brief.Fonts, f)
	}
	sort.Strings(brief.Fonts)
	if len(brief.Title) > 120 {
		brief.Title = brief.Title[:120]
	}
	return brief, nil
}

// buildClonePrompt menyusun pesan untuk pipeline agent: ringkasan
// terstruktur + aturan regenerasi. Bukan salinan verbatim sumber.
func buildClonePrompt(b *cloneBrief) string {
	var sb strings.Builder
	sb.WriteString("CLONE WEBSITE — bangun ulang website berikut sebagai aplikasi React + TypeScript baru di proyek ini (bukan salinan mentah).\n\n")
	sb.WriteString("SUMBER: " + b.URL + "\n")
	if b.Title != "" {
		sb.WriteString("JUDUL ASLI: " + b.Title + "\n")
	}
	if b.Description != "" {
		sb.WriteString("DESKRIPSI: " + b.Description + "\n")
	}
	if len(b.Headings) > 0 {
		sb.WriteString("STRUKTUR HEADING: " + strings.Join(b.Headings, " | ") + "\n")
	}
	if len(b.NavItems) > 0 {
		sb.WriteString("NAVIGASI: " + strings.Join(b.NavItems, " | ") + "\n")
	}
	if len(b.Colors) > 0 {
		sb.WriteString("PALET WARNA (inspirasi, boleh disesuaikan): " + strings.Join(b.Colors, ", ") + "\n")
	}
	if len(b.Fonts) > 0 {
		sb.WriteString("FONT (inspirasi): " + strings.Join(b.Fonts, ", ") + "\n")
	}
	if b.ImageCount > 0 {
		sb.WriteString(fmt.Sprintf("GAMBAR: %d gambar di sumber", b.ImageCount))
		if len(b.ImageAlts) > 0 {
			sb.WriteString(" (contoh alt: " + strings.Join(b.ImageAlts, " | ") + ")")
		}
		sb.WriteString(" — JANGAN hotlink/duplikasi gambar sumber; pakai placeholder visual (gradien, blok warna, ikon) atau gambar bebas lisensi.\n")
	}
	if b.Text != "" {
		sb.WriteString("\nKONTEN TERLIHAT (ringkasan, untuk memahami topik & struktur — TULIS ULANG dengan kata-katamu sendiri, jangan salin kalimat demi kalimat):\n" + b.Text + "\n")
	}
	sb.WriteString(`
ATURAN REGENERASI (wajib):
- Tiru STRUKTUR, LAYOUT, dan FUNGSI halamannya (seksi, navigasi, CTA, alur), bukan teks/gambar/mereknya.
- Tulis ulang semua copy dengan kata-kata sendiri; jangan salin paragraf, slogan, atau teks berhak cipta verbatim.
- Jangan memakai logo, nama brand, gambar, font berbayar, atau aset berhak cipta dari sumber. Buat identitas visual orisinal (nama generik, gradien/blok warna sebagai visual).
- Jangan hotlink aset dari domain sumber.
- Bangun sebagai aplikasi Vite + React + TypeScript multi-file sesuai kontrak proyek (components/, pages/, services/), BUKAN satu file HTML.
- Setelah build, proyek ini bisa diedit lewat chat seperti proyek biasa.`)
	return sb.String()
}

// cloneFromURL: POST /api/projects/clone-from-url
// Body: {"url": "https://contoh.com", "name": "Nama Proyek (opsional)"}
// Mengembalikan 201 + project + runId bila scrape lolos dan run agent
// di-enqueue. Gagal di tahap mana pun SEBELUM proyek dibuat -> error
// tanpa proyek setengah jadi.
func cloneFromURL(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			URL  string `json:"url" binding:"required"`
			Name string `json:"name"`
		}
		if err := c.ShouldBindJSON(&req); err != nil || strings.TrimSpace(req.URL) == "" {
			c.JSON(400, gin.H{"message": "URL wajib diisi"})
			return
		}
		uid := c.GetUint("userID")

		// 1. Validasi URL + SSRF guard.
		pageURL, err := validateCloneURL(req.URL)
		if err != nil {
			c.JSON(400, gin.H{"message": "URL tidak valid: " + err.Error()})
			return
		}
		// 2. AI harus terkonfigurasi + kuota tersedia (seperti postChat).
		// Clone tidak punya pilihan provider/model per prompt, jadi resolve
		// default: provider default + model pertama di daftarnya (atau
		// "Default" bila hanya ada konfigurasi AI lama) — sama seperti
		// chat tanpa ProviderID/Model.
		provider, providerName, err := resolveAIProvider(db, 0, "")
		if err != nil {
			c.JSON(400, gin.H{"message": err.Error()})
			return
		}
		if !provider.configured() {
			c.JSON(500, gin.H{"message": "AI belum dikonfigurasi admin. Buka Settings > AI Global."})
			return
		}
		plan := userPlan(db, uid)
		_, maxTokens := planQuota(db, plan)
		_, usedTokens := monthUsage(db, uid)
		if usedTokens >= int64(maxTokens) {
			c.JSON(402, gin.H{"error": "ai_quota_exceeded", "message": "Kuota AI bulanan habis. Upgrade paket."})
			return
		}
		// 3. Kuota proyek.
		maxProjects, _ := planQuota(db, plan)
		var n int64
		db.Model(&models.Project{}).Where("user_id = ?", uid).Count(&n)
		if int(n) >= maxProjects {
			c.JSON(402, gin.H{"error": "quota_exceeded", "message": "Batas proyek paket " + plan + " tercapai. Upgrade untuk menambah."})
			return
		}
		// 4. robots.txt — tolak bila path disallow (tanpa membuat proyek).
		client := cloneHTTPClient(cloneFetchTimeout)
		allowed, _ := fetchRobotsAllowed(client, pageURL)
		if !allowed {
			c.JSON(403, gin.H{
				"error":   "robots_disallowed",
				"message": "robots.txt situs ini melarang pengambilan halaman " + pageURL.Path + ". Clone dibatalkan.",
			})
			return
		}
		// 5. Scrape halaman.
		brief, err := scrapePage(client, pageURL)
		if err != nil {
			c.JSON(502, gin.H{"message": "Gagal mengambil URL: " + err.Error()})
			return
		}
		// 6. Buat proyek (baru di sini — semua yang bisa gagal sudah lewat).
		name := strings.TrimSpace(req.Name)
		if name == "" {
			name = brief.Title
		}
		if name == "" {
			name = pageURL.Hostname()
		}
		if name == "" {
			name = "Clone Website"
		}
		slug := makeSlug(name)
		for i := 1; ; i++ {
			try := slug
			if i > 1 {
				try = slug + "-" + itoa(i)
			}
			var count int64
			db.Model(&models.Project{}).Where("slug = ?", try).Count(&count)
			if count == 0 {
				slug = try
				break
			}
		}
		initialFiles := map[string]string{
			"README.md": fmt.Sprintf("# %s\n\nProyek hasil clone dari %s.\n\nDibangun ulang sebagai aplikasi React + TypeScript oleh WebBuilder. Konten ditulis ulang, bukan salinan mentah dari sumber.\n", name, pageURL.String()),
		}
		initialJSON, _ := json.Marshal(initialFiles)
		p := models.Project{
			UserID:      uid,
			Name:        name,
			Slug:        slug,
			Framework:   "auto",
			Files:       string(initialJSON),
			FormToken:   newFormToken(),
			FormEnabled: true,
			Memory:      "Clone dari URL: " + pageURL.String() + "\nSumber diregenerasi sebagai React/TS (struktur + fungsi ditiru, teks/gambar ditulis ulang, tanpa aset berhak cipta).",
		}
		if err := db.Create(&p).Error; err != nil {
			c.JSON(500, gin.H{"message": "Gagal membuat proyek"})
			return
		}
		saveAutoVersion(db, p.ID, p.Files, "Clone dari URL")
		// 7. Enqueue pipeline agent yang sama dengan chat build
		// (Confirm: true -> lewati gate discovery/klarifikasi; proyek
		// kosong langsung dibangun dari brief clone).
		message := buildClonePrompt(brief)
		run := createAgentRun(db, p.ID, uid, "build", message, providerName, provider.Model)
		if run == nil {
			c.JSON(500, gin.H{"message": "Proyek dibuat tetapi agent run gagal dibuat", "project": p})
			return
		}
		mgr, bus := agentQueue()
		if mgr == nil || bus == nil {
			finishAgentRun(db, run.ID, "failed", "Queue agent belum diinisialisasi", "queue agent belum diinisialisasi")
			c.JSON(500, gin.H{"message": "Proyek dibuat tetapi queue agent belum siap", "project": p, "runId": run.ID})
			return
		}
		payload, _ := json.Marshal(agentPipelineInput{
			RunID: run.ID, ProjectID: p.ID, UserID: uid,
			Message: message, Mode: "build", Confirm: true, Intent: "build",
		})
		if err := mgr.Enqueue(context.Background(), queue.Job{ID: agentJobID(run.ID), Kind: agentJobKind, Payload: payload}); err != nil {
			finishAgentRun(db, run.ID, "failed", "Gagal mengantre job agent", err.Error())
			c.JSON(500, gin.H{"message": "Proyek dibuat tetapi job agent gagal diantre: " + err.Error(), "project": p, "runId": run.ID})
			return
		}
		c.JSON(201, gin.H{
			"project": p,
			"runId":   run.ID,
			"source":  gin.H{"url": brief.URL, "title": brief.Title},
			"message": "Clone dimulai. AI sedang membangun ulang website sebagai proyek React.",
		})
	}
}

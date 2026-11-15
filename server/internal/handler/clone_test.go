package handler

import (
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestValidateCloneURLRejectsPrivate(t *testing.T) {
	bad := []string{
		"http://localhost/",
		"http://localhost:8080/x",
		"http://127.0.0.1/",
		"http://127.0.0.1:3000/",
		"http://10.0.0.5/",
		"http://192.168.1.1/",
		"http://172.16.0.9/",
		"http://169.254.169.254/latest/meta-data/",
		"http://[::1]/",
		"ftp://example.com/",
		"http://user:pass@93.184.216.34/",
		"http://93.184.216.34:8080/",
		"https://",
		"notaurl",
		"",
	}
	for _, raw := range bad {
		if _, err := validateCloneURL(raw); err == nil {
			t.Errorf("validateCloneURL(%q) seharusnya ditolak", raw)
		}
	}
}

func TestValidateCloneURLAcceptsPublicIP(t *testing.T) {
	// IP literal publik (example.com) — tanpa DNS, deterministik.
	for _, raw := range []string{"https://93.184.216.34/", "http://93.184.216.34/page"} {
		if _, err := validateCloneURL(raw); err != nil {
			t.Errorf("validateCloneURL(%q) seharusnya lolos: %v", raw, err)
		}
	}
}

func TestIsPublicIP(t *testing.T) {
	cases := map[string]bool{
		"8.8.8.8": true, "93.184.216.34": true,
		"127.0.0.1": false, "10.1.2.3": false, "192.168.0.1": false,
		"172.16.5.4": false, "169.254.169.254": false, "224.0.0.1": false,
		"0.0.0.0": false, "::1": false, "fe80::1": false,
	}
	for s, want := range cases {
		if got := isPublicIP(net.ParseIP(s)); got != want {
			t.Errorf("isPublicIP(%s) = %v, mau %v", s, got, want)
		}
	}
}

func TestParseRobotsRules(t *testing.T) {
	body := `
User-agent: *
Disallow: /private/
Disallow: /tmp
Allow: /tmp/public/
User-agent: Googlebot
Disallow: /google-only/
`
	rules := parseRobotsRules(body)
	if !rules.allowedByRobots("/") {
		t.Error("/ seharusnya diizinkan")
	}
	if rules.allowedByRobots("/private/page") {
		t.Error("/private/page seharusnya dilarang")
	}
	if rules.allowedByRobots("/tmp/public/x") != true {
		t.Error("/tmp/public/x seharusnya diizinkan (Allow terpanjang menang)")
	}
	if rules.allowedByRobots("/tmp/other") {
		t.Error("/tmp/other seharusnya dilarang")
	}
	if !rules.allowedByRobots("/google-only/x") {
		t.Error("aturan grup Googlebot tidak boleh berlaku untuk kita (path harus diizinkan)")
	}
	// Grup khusus webbuilder harus dihormati.
	body2 := "User-agent: webbuilder-clone-bot\nDisallow: /\nUser-agent: *\nDisallow: /admin/\n"
	rules2 := parseRobotsRules(body2)
	if rules2.allowedByRobots("/") {
		t.Error("Disallow: / untuk webbuilder harus melarang semua path")
	}
}

func TestRobotsMatchWildcard(t *testing.T) {
	if !robotsMatch("/foo/*.pdf", "/foo/bar.pdf") {
		t.Error("wildcard *.pdf seharusnya cocok")
	}
	if robotsMatch("/foo/*.pdf", "/foo/bar.html") {
		t.Error("wildcard *.pdf tidak boleh cocok untuk .html")
	}
	if !robotsMatch("/foo/$", "/foo/") {
		t.Error("pola $ seharusnya cocok di akhir path")
	}
	if robotsMatch("/foo/$", "/foo/bar") {
		t.Error("pola $ tidak boleh cocok untuk path lebih panjang")
	}
}

func TestFetchRobotsAllowedHTTPTest(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/robots.txt" {
			_, _ = w.Write([]byte("User-agent: *\nDisallow: /rahasia/\n"))
			return
		}
		w.WriteHeader(404)
	}))
	defer srv.Close()
	u, _ := url.Parse(srv.URL + "/rahasia/x")
	allowed, _ := fetchRobotsAllowed(cloneHTTPClient(5*time.Second), u)
	if allowed {
		t.Error("/rahasia/x seharusnya dilarang robots.txt")
	}
	u2, _ := url.Parse(srv.URL + "/publik")
	allowed2, _ := fetchRobotsAllowed(cloneHTTPClient(5*time.Second), u2)
	if !allowed2 {
		t.Error("/publik seharusnya diizinkan")
	}
}

func TestScrapePageHTTPTest(t *testing.T) {
	const page = `<!doctype html><html><head><title>Warung Kopi Sederhana</title>
<meta name="description" content="Warung kopi di desa.">
<style>.hero{color:#1a2b3c;background:#ffeeaa;font-family:Inter, sans-serif}</style>
<link rel="stylesheet" href="/style.css">
</head><body><nav><a href="/">Beranda</a><a href="/menu">Menu</a></nav>
<h1>Selamat datang di Warung Kopi</h1><h2>Menu hari ini</h2>
<p>Kopi tubruk asli dan pisang goreng hangat.</p>
<img src="/kopi.jpg" alt="Secangkir kopi tubruk">
</body></html>`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/style.css" {
			w.Header().Set("Content-Type", "text/css")
			_, _ = w.Write([]byte(".btn{color:#123456;font-family:Georgia, serif}"))
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(page))
	}))
	defer srv.Close()
	u, _ := url.Parse(srv.URL + "/")
	brief, err := scrapePage(cloneHTTPClient(5*time.Second), u)
	if err != nil {
		t.Fatalf("scrapePage gagal: %v", err)
	}
	if brief.Title != "Warung Kopi Sederhana" {
		t.Errorf("title = %q", brief.Title)
	}
	if brief.Description != "Warung kopi di desa." {
		t.Errorf("description = %q", brief.Description)
	}
	if len(brief.Headings) != 2 || brief.Headings[0] != "Selamat datang di Warung Kopi" {
		t.Errorf("headings = %v", brief.Headings)
	}
	if !strings.Contains(brief.Text, "Kopi tubruk asli") {
		t.Errorf("text tidak berisi konten terlihat: %q", brief.Text)
	}
	if strings.Contains(brief.Text, ".hero") {
		t.Error("teks CSS tidak boleh bocor ke teks terlihat")
	}
	has := func(list []string, want string) bool {
		for _, v := range list {
			if v == want {
				return true
			}
		}
		return false
	}
	if !has(brief.Colors, "#1a2b3c") || !has(brief.Colors, "#123456") {
		t.Errorf("colors = %v, harus berisi warna inline + stylesheet", brief.Colors)
	}
	if !has(brief.Fonts, "Inter") || !has(brief.Fonts, "Georgia") {
		t.Errorf("fonts = %v", brief.Fonts)
	}
	if brief.ImageCount != 1 || len(brief.ImageAlts) != 1 {
		t.Errorf("gambar: count=%d alts=%v", brief.ImageCount, brief.ImageAlts)
	}
	if len(brief.NavItems) == 0 {
		t.Error("nav items kosong")
	}
}

func TestScrapePageRejectsNonHTML(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write([]byte{0x89, 0x50, 0x4e, 0x47})
	}))
	defer srv.Close()
	u, _ := url.Parse(srv.URL + "/x.png")
	if _, err := scrapePage(cloneHTTPClient(5*time.Second), u); err == nil {
		t.Error("konten non-HTML seharusnya ditolak")
	}
}

func TestScrapePage404(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	defer srv.Close()
	u, _ := url.Parse(srv.URL + "/hilang")
	if _, err := scrapePage(cloneHTTPClient(5*time.Second), u); err == nil {
		t.Error("404 seharusnya error")
	}
}

func TestBuildClonePromptRegenerationRules(t *testing.T) {
	b := &cloneBrief{
		URL: "https://example.com", Title: "Toko Contoh",
		Headings: []string{"Promo Hari Ini"}, Text: "Beli satu gratis satu hari ini.",
		Colors: []string{"#ff0000"}, ImageCount: 2,
	}
	prompt := buildClonePrompt(b)
	for _, must := range []string{
		"JANGAN hotlink", "kata-kata sendiri", "bukan salinan",
		"React + TypeScript", "https://example.com",
	} {
		if !strings.Contains(prompt, must) {
			t.Errorf("prompt clone harus berisi %q", must)
		}
	}
	if strings.Contains(prompt, "Beli satu gratis satu hari ini.") == false {
		t.Error("prompt harus membawa ringkasan konten sebagai konteks")
	}
}

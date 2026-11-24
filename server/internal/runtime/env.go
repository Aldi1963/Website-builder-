package runtime

import (
	"net/url"
	"os"
	"regexp"
	"strings"
)

// env.go — scrubbing environment untuk proses anak.
//
// Aturan: proses anak TIDAK PERNAH mewarisi os.Environ() apa adanya. Env
// dibangun dari nol dari allowlist berikut. Variabel apa pun yang mengandung
// secret (JWT, AI key, DB password, dsb.) tidak ada di allowlist, jadi tidak
// mungkin bocor lewat sini — bahkan bila server dijalankan dengan secret di
// environment-nya sendiri.

// safeEnvAllowlist adalah variabel host yang boleh diteruskan apa adanya.
// Sengaja minimal: PATH, HOME, locale, zona waktu, dan penanda CI.
// Variabel proxy ditangani terpisah di bawah (stripProxyUserinfo): URL proxy
// diteruskan tanpa kredensial, karena npm/pnpm/pip membutuhkannya untuk
// mencapai registry di host yang egress-nya lewat proxy.
var safeEnvAllowlist = map[string]bool{
	"PATH":     true,
	"HOME":     true,
	"LANG":     true,
	"LC_ALL":   true,
	"LC_CTYPE": true,
	"TZ":       true,
	"TMPDIR":   true,
	"TERM":     true,
	"CI":       true,
	"NODE_ENV": true,
	// npm di workspace tenant tidak boleh menulis fund/audit dan tidak boleh
	// menjalankan lifecycle script arbitrer dari package hasil generate.
	"npm_config_fund":             true,
	"npm_config_audit":            true,
	"npm_config_legacy_peer_deps": true,
	"npm_config_ignore_scripts":   true,
}

// vitePublicVar adalah pola variabel build-time Vite yang memang dirancang
// publik (di-embed ke bundle JS klien). Boleh diteruskan sebagai Env tambahan.
var vitePublicVar = regexp.MustCompile(`^VITE_[A-Z0-9_]+$`)

// proxyURLVar adalah variabel proxy yang nilainya berupa URL (npm/pnpm/pip
// membacanya saat install). Variabel ini TIDAK ada di allowlist biasa karena
// nilainya butuh transformasi: userinfo (kredensial) di URL proxy wajib
// dibuang sebelum diteruskan — lihat stripProxyUserinfo.
var proxyURLVar = map[string]bool{
	"HTTP_PROXY":  true,
	"HTTPS_PROXY": true,
	"http_proxy":  true,
	"https_proxy": true,
}

// noProxyVar adalah variabel pengecualian proxy yang nilainya berupa daftar
// host (bukan URL), jadi tidak ada userinfo yang perlu dibuang — diteruskan
// apa adanya.
var noProxyVar = map[string]bool{
	"NO_PROXY": true,
	"no_proxy": true,
}

// caBundleVar adalah variabel yang nilainya berupa PATH ke bundle CA — bukan
// secret, jadi aman diteruskan apa adanya. WAJIB ada: proxy egress di host
// ini me-MITM TLS dengan CA sendiri; tanpa NODE_EXTRA_CA_CERTS, Node/npm
// tidak bisa memverifikasi sertifikat proxy dan `npm install` menggantung
// (terverifikasi 2026-11-15: `npm view` timeout 60 dtk tanpa variabel ini,
// selesai 3,7 dtk dengan variabel ini). SSL_CERT_FILE / REQUESTS_CA_BUNDLE /
// CURL_CA_BUNDLE adalah padanan untuk stack OpenSSL/Python/requests/curl.
var caBundleVar = map[string]bool{
	"NODE_EXTRA_CA_CERTS": true,
	"SSL_CERT_FILE":       true,
	"REQUESTS_CA_BUNDLE":  true,
	"CURL_CA_BUNDLE":      true,
}

// stripProxyUserinfo membuang userinfo (kredensial) dari URL proxy dan
// mengembalikan URL tanpa kredensial. Alasan: npm/pnpm/pip butuh proxy
// untuk mencapai registry di host yang egress-nya lewat proxy (di VM ini
// akses langsung ke registry diblokir), tetapi kredensial proxy TIDAK BOLEH
// bocor ke proses tenant — itu persis yang dicegah scrub ini. Di VM ini
// proxy tidak menuntut auth dari IP host (terverifikasi 2026-11-15: curl
// lewat proxy tanpa userinfo tetap 200), jadi install tetap jalan tanpa
// kredensial. Bila URL tidak bisa di-parse atau tidak punya host,
// kembalikan false supaya variabelnya dibuang (fail-closed) daripada
// meneruskan nilai yang tidak dimengerti.
func stripProxyUserinfo(raw string) (string, bool) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" {
		return "", false
	}
	u.User = nil
	return u.String(), true
}

// secretVar adalah pola defensif lapis kedua: kunci apa pun yang cocok dengan
// pola ini TIDAK PERNAH diteruskan, walau entah bagaimana masuk allowlist.
var secretVar = regexp.MustCompile(`(?i)SECRET|TOKEN|PASSWORD|PASSWD|JWT|API[_-]?KEY|AUTH|CREDENTIAL|PRIVATE|SESSION|COOKIE|BEARER|AWS_|DATABASE_URL|DSN`)

func envKeyAllowed(key string) bool {
	if secretVar.MatchString(key) {
		return false
	}
	if safeEnvAllowlist[key] {
		return true
	}
	return vitePublicVar.MatchString(key)
}

// scrubEnv membangun environment proses anak dari nol:
//   - variabel host yang lolos allowlist (nilainya diambil dari os.Environ),
//   - ditambah extras yang lolos allowlist (nilai dari caller menang).
//
// Semua yang lain dibuang. Hasilnya selalu berisi PATH yang aman bila PATH
// host tidak lolos (tidak mungkin, PATH ada di allowlist — fallback hanya
// untuk pertahanan).
func scrubEnv(extras map[string]string) []string {
	host := make(map[string]string, len(safeEnvAllowlist))
	for _, kv := range os.Environ() {
		key, value, ok := strings.Cut(kv, "=")
		if !ok {
			continue
		}
		if envKeyAllowed(key) {
			host[key] = value
		}
	}
	for key, value := range extras {
		if envKeyAllowed(key) {
			host[key] = value
		}
	}
	// Variabel proxy (host): npm/pnpm/pip butuh proxy untuk mencapai registry
	// di host yang egress-nya lewat proxy. URL proxy diteruskan TANPA
	// userinfo (stripProxyUserinfo); NO_PROXY diteruskan apa adanya karena
	// isinya hanya daftar host. Nilai kosong dilewati.
	//
	// npm TIDAK membaca HTTP_PROXY — ia membaca konfigurasinya sendiri
	// (npm_config_proxy / npm_config_https_proxy / npm_config_noproxy) — jadi
	// nilai proxy yang sudah di-strip juga ditulis ke ketiga variabel itu.
	// Tanpa ini, `npm install` dengan cache dingin menggantung (npm mencoba
	// koneksi langsung yang diblokir sandbox): terverifikasi 2026-11-15,
	// `npm config list` dengan env yang di-scrub menunjukkan proxy=null dan
	// install cache-dingin timeout 280 dtk.
	httpProxy, httpsProxy, noProxy := "", "", ""
	for _, kv := range os.Environ() {
		key, value, ok := strings.Cut(kv, "=")
		if !ok || strings.TrimSpace(value) == "" {
			continue
		}
		switch {
		case proxyURLVar[key]:
			if stripped, ok := stripProxyUserinfo(value); ok {
				host[key] = stripped
				if key == "HTTP_PROXY" || key == "http_proxy" {
					if httpProxy == "" {
						httpProxy = stripped
					}
				} else if httpsProxy == "" {
					httpsProxy = stripped
				}
			}
		case noProxyVar[key]:
			host[key] = value
			if noProxy == "" {
				noProxy = value
			}
		case caBundleVar[key]:
			// Path ke bundle CA (bukan secret) — diteruskan apa adanya.
			host[key] = value
		case key == "npm_config_proxy" || key == "npm_config_https_proxy":
			// Konfigurasi npm eksplisit dari host: tetap dipakai, tapi
			// userinfo-nya dibuang seperti proxy lainnya.
			if stripped, ok := stripProxyUserinfo(value); ok {
				host[key] = stripped
			}
		case key == "npm_config_noproxy":
			host[key] = value
		}
	}
	// Turunkan npm_config_* dari proxy bila host tidak mengesetnya eksplisit.
	if _, ok := host["npm_config_proxy"]; !ok && httpProxy != "" {
		host["npm_config_proxy"] = httpProxy
	}
	if _, ok := host["npm_config_https_proxy"]; !ok && httpsProxy != "" {
		host["npm_config_https_proxy"] = httpsProxy
	}
	if _, ok := host["npm_config_noproxy"]; !ok && noProxy != "" {
		host["npm_config_noproxy"] = noProxy
	}
	if _, ok := host["PATH"]; !ok || host["PATH"] == "" {
		host["PATH"] = "/usr/local/bin:/usr/bin:/bin"
	}
	out := make([]string, 0, len(host))
	for key, value := range host {
		out = append(out, key+"="+value)
	}
	return out
}

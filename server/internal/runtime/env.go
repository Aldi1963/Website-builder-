package runtime

import (
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
	if _, ok := host["PATH"]; !ok || host["PATH"] == "" {
		host["PATH"] = "/usr/local/bin:/usr/bin:/bin"
	}
	out := make([]string, 0, len(host))
	for key, value := range host {
		out = append(out, key+"="+value)
	}
	return out
}

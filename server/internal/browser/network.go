package browser

import (
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// network.go — inti bersama parser output list_network_requests
// (chrome-devtools-mcp 1.13.0).
//
// Dulu ada DUA parser yang hampir sama tapi hidup terpisah:
//
//   - ParseFailedRequests (verify.go, dipakai loop verifikasi scripted),
//   - parseNetworkFailures (acceptance.go, dipakai RunAcceptanceWithClient).
//
// Keduanya mem-parse baris yang sama (`reqid=N METHOD URL [STATUS]`),
// dengan aturan gagal yang sama (status HTTP >= 400 atau error net::*,
// dikecuali favicon 404, probe auth /api/app-api/ 401, URL data:, dan
// request lintas-origin) — tapi berbeda di empat titik yang SENGAJA
// (lihat tabel di networkFailureOptions). Unifikasi ini menyatukan
// parsing baris + predikat gagal ke failedNetworkRequests; kedua entry
// point lama tinggal wrapper tipis yang mempertahankan bentuk return
// dan perilaku masing-masing. JANGAN samakan keempat perbedaan itu:
// masing-masing sudah diuji (network_test.go) dan punya alasan
// (didokumentasikan di bawah).
//
// Format baris (terbukti spike Fase 2):
//
//	reqid=2 GET http://127.0.0.1:18098/tidak-ada.json [404]
//	reqid=6 GET http://127.0.0.1:18098/putus [net::ERR_CONNECTION_REFUSED]

// networkLineRe mem-parse satu baris list_network_requests: reqid,
// method, URL, dan isi kurung siku (status HTTP atau error net::*).
var networkLineRe = regexp.MustCompile(`^reqid=\d+\s+(\S+)\s+(\S+)\s+\[(.+)\]$`)

// networkRequest adalah satu baris list_network_requests yang berhasil
// di-parse DAN dinilai gagal oleh failedNetworkRequests.
type networkRequest struct {
	method string
	url    string
	// statusText adalah isi kurung siku sesudah di-trim (dipakai
	// format "METHOD URL [status]" di ParseFailedRequests).
	statusText string
	// statusRaw adalah isi kurung siku apa adanya (dipakai nilai
	// "error" di parseNetworkFailures — perilaku lama di sana tidak
	// men-trim sebelum menyimpannya).
	statusRaw string
	// status adalah kode HTTP bila statusText berupa angka, -1 bila
	// bukan (error net::*).
	status int
	// netError true bila request gagal karena error net::* (bukan
	// karena status HTTP >= 400).
	netError bool
}

// networkFailureOptions memilih perilaku di empat titik tempat kedua
// parser lama SENGAJA berbeda. Nilai tiap pemakai:
//
//	                            ParseFailedRequests   parseNetworkFailures
//	                            (verify.go)           (acceptance.go)
//	-----------------------------------------------------------------
//	excludePageURL              false                 true
//	faviconSubstring            true                  false
//	originUnknownPass           true                  false
//	netErrorTrimmed             true                  false
//
// Alasan tiap perbedaan (jangan disamakan tanpa keputusan eksplisit):
//
//   - excludePageURL: verifikasi menilai preview itu sendiri — bila
//     halaman preview 404, itu berarti preview rusak dan verifikasi
//     harus gagal. Acceptance menilai status halaman lewat navigation
//     timing (evaluatePageState), jadi baris halaman sendiri di sini
//     hanya akan menggandakan verdict.
//   - faviconSubstring: verify memakai Contains "favicon.ico" (lebih
//     longgar — URL apa pun yang menyebut favicon diabaikan);
//     acceptance memakai isFaviconURL (hanya path yang berakhiran
//     "/favicon.ico"). Perbedaan ini tidak pernah didokumentasikan
//     sebagai keputusan di kedua sisi, jadi dipertahankan apa adanya
//     sampai ada yang memutuskan satu semantik.
//   - originUnknownPass: bila pageURL tidak bisa di-parse (origin
//     kosong), verify meloloskan semua request (tanpa filter origin),
//     acceptance menolak semuanya. Di praktik tidak terjangkau —
//     kedua pemanggil mem-validasi pageURL dulu (ValidateURL) — tapi
//     perilaku lamanya dipertahankan.
//   - netErrorTrimmed: verify men-trim status sebelum dicek prefix
//     "net::", acceptance mengecek apa adanya. Hanya berpengaruh bila
//     isi kurung siku diawali spasi ("[ net::...]") — format yang
//     tidak pernah dihasilkan server MCP — tapi dipertahankan.
type networkFailureOptions struct {
	// pageURL adalah URL halaman yang dibuka (sumber origin).
	pageURL string
	// excludePageURL: lewati baris yang URL-nya sama persis dengan
	// pageURL.
	excludePageURL bool
	// faviconSubstring: true → lewati URL apa pun yang mengandung
	// "favicon.ico"; false → hanya yang path-nya berakhiran
	// "/favicon.ico" (isFaviconURL).
	faviconSubstring bool
	// originUnknownPass: bila pageURL tidak bisa di-parse (origin
	// kosong), true → semua request lolos filter origin; false →
	// semua ditolak.
	originUnknownPass bool
	// netErrorTrimmed: true → status non-angka di-trim dulu sebelum
	// dicek prefix "net::"; false → dicek apa adanya.
	netErrorTrimmed bool
}

// failedNetworkRequests mengambil request gagal origin-yang-sama dari
// output list_network_requests: status HTTP >= 400 atau error net::*.
// Dikecualikan (aturan bersama kedua pemakai): URL data: (inline, bisa
// puluhan KB base64), favicon.ico 404 (bukan error aplikasi — spike
// Fase 0), 401 pada /api/app-api/ (probe auth aplikasi logged-out,
// normal), dan request lintas-origin (font/CDN/analytics pihak ketiga
// bukan tanggung jawab preview ini). Perbedaan yang disengaja antar
// pemakai diatur lewat opts (lihat networkFailureOptions).
func failedNetworkRequests(output string, opts networkFailureOptions) []networkRequest {
	out := []networkRequest{}
	origin := ""
	if u, err := url.Parse(opts.pageURL); err == nil {
		origin = u.Scheme + "://" + u.Host
	}
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if len(line) > 2048 {
			line = line[:2048] // baris data: URL bisa puluhan KB (base64)
		}
		m := networkLineRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		method, u, statusRaw := m[1], m[2], m[3]
		statusText := strings.TrimSpace(statusRaw)
		if strings.HasPrefix(u, "data:") {
			continue
		}
		if opts.excludePageURL && u == opts.pageURL {
			continue
		}
		if opts.faviconSubstring {
			if strings.Contains(u, "favicon.ico") {
				continue
			}
		} else if isFaviconURL(u) {
			continue
		}
		if origin != "" {
			if ou, err := url.Parse(u); err != nil || ou.Scheme+"://"+ou.Host != origin {
				continue
			}
		} else if !opts.originUnknownPass {
			continue
		}
		if status, err := strconv.Atoi(statusText); err == nil {
			if status >= 400 && !isExpectedAuthProbe(u, status) {
				out = append(out, networkRequest{method: method, url: u, statusText: statusText, statusRaw: statusRaw, status: status})
			}
			continue
		}
		netCheck := statusText
		if !opts.netErrorTrimmed {
			netCheck = statusRaw
		}
		if strings.HasPrefix(netCheck, "net::") {
			out = append(out, networkRequest{method: method, url: u, statusText: statusText, statusRaw: statusRaw, status: -1, netError: true})
		}
	}
	return out
}

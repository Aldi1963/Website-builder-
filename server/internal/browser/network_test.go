package browser

import (
	"fmt"
	"strings"
	"testing"
)

// TestParserUnificationDivergences mengunci EMPAT perbedaan perilaku
// yang SENGAJA dipertahankan sesudah unifikasi parser ke
// failedNetworkRequests (network.go). Bila salah satu test ini gagal
// sesudah perubahan di inti bersama, itu berarti perilaku yang
// disengaja ikut berubah — bukan sekadar refactor. Alasan tiap
// perbedaan ada di komentar networkFailureOptions.

func TestParserUnificationPageURLItself(t *testing.T) {
	pageURL := "http://127.0.0.1:18098/index.html"
	line := "reqid=1 GET http://127.0.0.1:18098/index.html [404]\n"
	// Verifikasi: halaman sendiri 404 = preview rusak → dihitung gagal.
	if got := ParseFailedRequests(line, pageURL); len(got) != 1 {
		t.Fatalf("ParseFailedRequests: halaman sendiri 404 harus 1 gagal, dapat %+v", got)
	}
	// Acceptance: status halaman dinilai lewat navigation timing, bukan
	// daftar network → dilewati di sini.
	if got := parseNetworkFailures(line, pageURL); len(got) != 0 {
		t.Fatalf("parseNetworkFailures: halaman sendiri 404 harus dilewati, dapat %+v", got)
	}
}

func TestParserUnificationFavicon(t *testing.T) {
	pageURL := "http://127.0.0.1:18098/index.html"
	// Keduanya mengabaikan /favicon.ico 404 (path berakhiran favicon).
	plain := "reqid=1 GET http://127.0.0.1:18098/favicon.ico [404]\n"
	if got := ParseFailedRequests(plain, pageURL); len(got) != 0 {
		t.Fatalf("ParseFailedRequests: /favicon.ico harus diabaikan, dapat %+v", got)
	}
	if got := parseNetworkFailures(plain, pageURL); len(got) != 0 {
		t.Fatalf("parseNetworkFailures: /favicon.ico harus diabaikan, dapat %+v", got)
	}
	// Perbedaan: URL yang hanya MENYEBUT favicon.ico (bukan path-nya)
	// diabaikan verify (Contains) tapi dihitung acceptance (path suffix).
	tricky := "reqid=1 GET http://127.0.0.1:18098/app.js?x=favicon.ico [404]\n" +
		"reqid=2 GET http://127.0.0.1:18098/icons/favicon.ico.png [404]\n"
	if got := ParseFailedRequests(tricky, pageURL); len(got) != 0 {
		t.Fatalf("ParseFailedRequests: URL yang menyebut favicon.ico harus diabaikan, dapat %+v", got)
	}
	if got := parseNetworkFailures(tricky, pageURL); len(got) != 2 {
		t.Fatalf("parseNetworkFailures: URL yang menyebut favicon.ico (bukan path favicon) harus 2 gagal, dapat %+v", got)
	}
	// Keduanya tetap mengabaikan favicon dengan query string (path
	// tetap /favicon.ico).
	withQuery := "reqid=1 GET http://127.0.0.1:18098/favicon.ico?v=2 [404]\n"
	if got := ParseFailedRequests(withQuery, pageURL); len(got) != 0 {
		t.Fatalf("ParseFailedRequests: /favicon.ico?v=2 harus diabaikan, dapat %+v", got)
	}
	if got := parseNetworkFailures(withQuery, pageURL); len(got) != 0 {
		t.Fatalf("parseNetworkFailures: /favicon.ico?v=2 harus diabaikan, dapat %+v", got)
	}
}

func TestParserUnificationOriginUnknown(t *testing.T) {
	// pageURL tidak bisa di-parse → origin kosong. Verify meloloskan
	// semua request (tanpa filter origin); acceptance menolak semuanya.
	// Di praktik tidak terjangkau (pemanggil mem-validasi pageURL dulu),
	// tapi perilaku lamanya dikunci di sini.
	badPageURL := ":///%zz"
	line := "reqid=1 GET http://127.0.0.1:18098/tidak-ada.json [404]\n"
	if got := ParseFailedRequests(line, badPageURL); len(got) != 1 {
		t.Fatalf("ParseFailedRequests: origin tak diketahui harus meloloskan, dapat %+v", got)
	}
	if got := parseNetworkFailures(line, badPageURL); len(got) != 0 {
		t.Fatalf("parseNetworkFailures: origin tak diketahui harus menolak semua, dapat %+v", got)
	}
}

func TestParserUnificationNetErrorTrim(t *testing.T) {
	pageURL := "http://127.0.0.1:18098/index.html"
	// Isi kurung siku diawali spasi: verify men-trim dulu lalu mengenali
	// prefix "net::"; acceptance mengecek apa adanya dan melewatkannya.
	// Format ini tidak pernah dihasilkan server MCP — perbedaannya
	// dipertahankan apa adanya, bukan disamakan diam-diam.
	line := "reqid=1 GET http://127.0.0.1:18098/putus [ net::ERR_CONNECTION_REFUSED]\n"
	if got := ParseFailedRequests(line, pageURL); len(got) != 1 {
		t.Fatalf("ParseFailedRequests: '[ net::...]' harus dikenali sesudah trim, dapat %+v", got)
	}
	if got := parseNetworkFailures(line, pageURL); len(got) != 0 {
		t.Fatalf("parseNetworkFailures: '[ net::...]' harus dilewati (cek tanpa trim), dapat %+v", got)
	}
}

// TestParserUnificationSharedRules membuktikan aturan BERSAMA tetap
// sama di kedua parser: lintas-origin, data:, 401 /api/app-api/,
// dan status < 400 tidak pernah dihitung gagal oleh siapa pun.
func TestParserUnificationSharedRules(t *testing.T) {
	pageURL := "http://127.0.0.1:18098/index.html"
	out := "reqid=1 GET http://127.0.0.1:18098/ok.json [200]\n" +
		"reqid=2 GET http://127.0.0.1:18098/api/app-api/me [401]\n" +
		"reqid=3 GET https://fonts.googleapis.com/css2?family=X [404]\n" +
		"reqid=4 GET data:image/png;base64,AAAA [404]\n" +
		"reqid=5 GET http://127.0.0.1:18098/redirect [301]\n"
	if got := ParseFailedRequests(out, pageURL); len(got) != 0 {
		t.Fatalf("ParseFailedRequests: aturan bersama harus 0 gagal, dapat %+v", got)
	}
	if got := parseNetworkFailures(out, pageURL); len(got) != 0 {
		t.Fatalf("parseNetworkFailures: aturan bersama harus 0 gagal, dapat %+v", got)
	}
	// Dan satu baris gagal yang sama dikenali kedua parser dengan isi
	// yang sama (bentuk return saja berbeda).
	one := "reqid=1 GET http://127.0.0.1:18098/tidak-ada.json [404]\n"
	v := ParseFailedRequests(one, pageURL)
	a := parseNetworkFailures(one, pageURL)
	if len(v) != 1 || len(a) != 1 {
		t.Fatalf("keduanya harus 1 gagal, dapat verify=%+v acceptance=%+v", v, a)
	}
	if !strings.Contains(v[0], "tidak-ada.json [404]") {
		t.Fatalf("verify harus memuat URL + status, dapat %q", v[0])
	}
	if fmt.Sprint(a[0]["url"]) != "http://127.0.0.1:18098/tidak-ada.json" || a[0]["status"] != 404 {
		t.Fatalf("acceptance harus memuat url + status 404, dapat %+v", a[0])
	}
}

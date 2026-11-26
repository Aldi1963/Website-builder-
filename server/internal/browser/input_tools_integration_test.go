package browser

// Test integrasi alat input Fase 4 dengan Chrome for Testing ASLI +
// server MCP chrome-devtools-mcp@1.13.0 (tanpa kunci AI, tanpa akun
// user — fixture lokal + kredensial DUMMY saja).
//
// Fixture: httptest server (pola browser_integration_test.go) dengan
// tiga halaman:
//   - /       : form login dummy; submit (JS, tanpa network) mengganti
//               form dengan sapaan "Selamat datang, <email>".
//   - /cari   : field "Cari" (Enter → tampil "Hasil untuk: <query>")
//               + field "Catatan" (untuk uji seleksi Control+A).
//   - /lambat : teks "teks-terlambat-xyz" baru muncul sesudah 800 ms
//               (membuktikan wait_for benar-benar menunggu).
// Kredensial di sini DUMMY (user@example.com / dummy-password) dan
// hanya ada di fixture test ini.
import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const (
	inputFixtureEmail    = "user@example.com"
	inputFixturePassword = "dummy-password"
)

func inputFixtureServer(t *testing.T) *httptest.Server {
	t.Helper()
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		switch r.URL.Path {
		case "/":
			fmt.Fprint(w, `<!doctype html><html><head><title>login fixture</title></head><body>
<h1>Masuk Fixture</h1>
<form id="login-form">
<label for="email">Email</label><input id="email" type="email">
<label for="password">Kata sandi</label><input id="password" type="password">
<button type="submit">Masuk</button>
</form>
<div id="welcome" hidden><h1>Selamat datang</h1><p id="welcome-email"></p></div>
<script>
document.getElementById('login-form').addEventListener('submit', function(e){
  e.preventDefault();
  var email = document.getElementById('email').value;
  document.getElementById('login-form').hidden = true;
  document.getElementById('welcome-email').textContent = 'Halo, ' + email;
  document.getElementById('welcome').hidden = false;
});
</script>
</body></html>`)
		case "/cari":
			fmt.Fprint(w, `<!doctype html><html><head><title>cari fixture</title></head><body>
<h1>Cari Fixture</h1>
<label for="q">Cari</label><input id="q" type="text">
<p id="hasil"></p>
<label for="catatan">Catatan</label><input id="catatan" type="text" value="">
<script>
document.getElementById('q').addEventListener('keydown', function(e){
  if (e.key === 'Enter') { document.getElementById('hasil').textContent = 'Hasil untuk: ' + e.target.value; }
});
</script>
</body></html>`)
		case "/lambat":
			fmt.Fprint(w, `<!doctype html><html><head><title>lambat fixture</title></head><body>
<h1>Lambat Fixture</h1>
<p id="tunggu">memuat...</p>
<script>setTimeout(function(){ document.getElementById('tunggu').textContent = 'teks-terlambat-xyz'; }, 800);</script>
</body></html>`)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(ts.Close)
	return ts
}

// newInputClient membuat Client Chrome asli untuk satu subtest (cap
// interaksi 5/run — tiap subtest butuh Client sendiri supaya alurnya
// tidak saling memakan jatah). Skip bila CHROME_FOR_TESTING_PATH
// kosong (pola test integrasi lama).
func newInputClient(t *testing.T, tsURL string) *Client {
	t.Helper()
	chromePath := strings.TrimSpace(os.Getenv(EnvChromePath))
	if chromePath == "" {
		t.Skip("CHROME_FOR_TESTING_PATH kosong — test integrasi Chrome dilewati")
	}
	if _, err := os.Stat(chromePath); err != nil {
		t.Fatalf("CHROME_FOR_TESTING_PATH tidak ada: %s", chromePath)
	}
	t.Setenv(EnvEnableBrowserInputTools, "1")
	u, err := url.Parse(tsURL)
	if err != nil {
		t.Fatalf("URL fixture tidak valid %s: %v", tsURL, err)
	}
	port := 0
	fmt.Sscanf(u.Port(), "%d", &port)
	if port == 0 {
		t.Fatalf("tidak bisa membaca port fixture dari %s", tsURL)
	}
	dir := t.TempDir()
	ws := filepath.Join(dir, "workspace")
	prof := filepath.Join(dir, "chrome-profile")
	if err := os.MkdirAll(ws, 0o755); err != nil {
		t.Fatal(err)
	}
	c := NewClient(DefaultConfig(ws, prof))
	t.Cleanup(func() { _ = c.Close() })
	if err := c.SetPreviewPort(port); err != nil {
		t.Fatalf("SetPreviewPort(%d) gagal: %v", port, err)
	}
	start := time.Now()
	if err := c.Start(context.Background()); err != nil {
		t.Fatalf("Start dengan Chrome asli gagal: %v", err)
	}
	t.Logf("start Chrome+MCP: %s", time.Since(start).Round(time.Millisecond))
	return c
}

var snapshotUIDRe = regexp.MustCompile(`uid=([A-Za-z0-9_.-]+)`)

// snapshotUID mencari uid elemen di snapshot accessibility tree dari
// peran + nama aksesibelnya (mis. textbox "Email"). Peran WAJIB
// disebut: baris label polos (`uid=1_3 "Email"`) dan textbox-nya
// (`uid=1_4 textbox "Email"`) memakai nama yang sama, dan hanya
// elemen interaktif (textbox/button) yang bisa di-fill/di-click —
// memakai uid label membuat fill/click gagal "did not become
// interactive". Snapshot dicetak penuh bila elemen tidak ketemu supaya
// format snapshot baru mudah didiagnosis.
func snapshotUID(t *testing.T, snapshot, role, name string) string {
	t.Helper()
	want := role + ` "` + name + `"`
	for _, line := range strings.Split(snapshot, "\n") {
		if strings.Contains(line, want) {
			if m := snapshotUIDRe.FindStringSubmatch(line); m != nil {
				return m[1]
			}
		}
	}
	t.Fatalf("uid elemen %s tidak ketemu di snapshot:\n%s", want, snapshot)
	return ""
}

func snapshotOf(t *testing.T, c *Client, ctx context.Context) string {
	t.Helper()
	out, err := c.CallTool(ctx, "take_snapshot", map[string]interface{}{})
	if err != nil {
		t.Fatalf("take_snapshot gagal: %v", err)
	}
	t.Logf("snapshot:\n%s", out)
	return out
}

func TestInputToolsRealChrome(t *testing.T) {
	ts := inputFixtureServer(t)
	ctx := context.Background()

	// tools/list server MCP 1.13.0: keempat alat input + wait_for
	// harus ada dengan parameter yang didokumentasikan (uid/value/
	// elements/key/text), dan TIDAK SATU PUN alat input membawa
	// argumen "url". upload_file ADA di server tapi harus tetap
	// tertutup dari katalog agent.
	t.Run("DaftarToolServer", func(t *testing.T) {
		c := newInputClient(t, ts.URL)
		tools, err := c.ListTools(ctx)
		if err != nil {
			t.Fatalf("ListTools gagal: %v", err)
		}
		byName := map[string]*mcp.Tool{}
		for _, tool := range tools {
			byName[tool.Name] = tool
		}
		t.Logf("server MCP mengembalikan %d tool", len(tools))
		wantParams := map[string][]string{
			"click":     {"uid"},
			"fill":      {"uid", "value"},
			"fill_form": {"elements"},
			"press_key": {"key"},
			"wait_for":  {"text"},
		}
		for name, params := range wantParams {
			tool, ok := byName[name]
			if !ok {
				t.Fatalf("tools/list server harus memuat %q", name)
			}
			schema := toInputSchema(tool.InputSchema)
			props, _ := schema["properties"].(map[string]interface{})
			raw, _ := json.Marshal(props)
			t.Logf("skema %s: %s", name, string(raw))
			for _, p := range params {
				if _, ok := props[p]; !ok {
					t.Fatalf("skema %s harus punya parameter %q, dapat %s", name, p, string(raw))
				}
			}
			if _, hasURL := props["url"]; hasURL {
				t.Fatalf("skema %s tidak boleh membawa argumen url, dapat %s", name, string(raw))
			}
		}
		if _, ok := byName["upload_file"]; !ok {
			t.Fatalf("tools/list server 1.13.0 seharusnya memuat upload_file (agar tertutupnya terbukti), dapat %d tool", len(tools))
		}
		// wait_for adalah alat baca: readOnlyHint true di server.
		// Keempat alat input mengubah state: readOnlyHint false.
		if a := byName["wait_for"].Annotations; a == nil || !a.ReadOnlyHint {
			t.Fatalf("wait_for server harus readOnlyHint=true, dapat %+v", byName["wait_for"].Annotations)
		}
		for _, name := range InputTools {
			if a := byName[name].Annotations; a != nil && a.ReadOnlyHint {
				t.Fatalf("%s server tidak boleh readOnlyHint=true, dapat %+v", name, a)
			}
		}
		// Katalog agent dari daftar server yang sama: 23 spek, tanpa
		// upload_file.
		specs := SpecsFromTools(tools)
		if len(specs) != len(AllowlistTools)+len(InputTools) {
			t.Fatalf("katalog dari server asli harus %d spek, dapat %d", len(AllowlistTools)+len(InputTools), len(specs))
		}
		for _, s := range specs {
			if s.Name == "browser_upload_file" {
				t.Fatal("katalog tidak boleh memuat browser_upload_file")
			}
		}
		if got := MissingActiveTools(tools); len(got) != 0 {
			t.Fatalf("server asli lengkap tidak boleh ada alat hilang, dapat %+v", got)
		}
	})

	// fill_form (email + password dummy) → click submit → snapshot
	// membuktikan state berubah (sapaan muncul, form hilang).
	t.Run("LoginFillFormClick", func(t *testing.T) {
		c := newInputClient(t, ts.URL)
		nav, err := c.CallTool(ctx, "navigate_page", map[string]any{"url": ts.URL + "/"})
		if err != nil {
			t.Fatalf("navigate_page gagal: %v", err)
		}
		if !strings.Contains(nav, "Successfully navigated") {
			t.Fatalf("navigate harus sukses, dapat: %q", nav)
		}
		snap := snapshotOf(t, c, ctx)
		emailUID := snapshotUID(t, snap, "textbox", "Email")
		passUID := snapshotUID(t, snap, "textbox", "Kata sandi")
		submitUID := snapshotUID(t, snap, "button", "Masuk")
		if _, err := c.CallTool(ctx, "fill_form", map[string]any{"elements": []any{
			map[string]any{"uid": emailUID, "value": inputFixtureEmail},
			map[string]any{"uid": passUID, "value": inputFixturePassword},
		}}); err != nil {
			t.Fatalf("fill_form gagal: %v", err)
		}
		if _, err := c.CallTool(ctx, "click", map[string]any{"uid": submitUID}); err != nil {
			t.Fatalf("click submit gagal: %v", err)
		}
		after := snapshotOf(t, c, ctx)
		if !strings.Contains(after, "Selamat datang") || !strings.Contains(after, inputFixtureEmail) {
			t.Fatalf("snapshot sesudah submit harus memuat sapaan + email dummy, dapat:\n%s", after)
		}
		if strings.Contains(after, `"Kata sandi"`) {
			t.Fatalf("form login harus hilang sesudah submit, snapshot masih memuat field password:\n%s", after)
		}
		if got := c.InteractionCalls(); got != 2 {
			t.Fatalf("alur login harus 2 panggilan interaksi (fill_form + click), dapat %d", got)
		}
	})

	// fill satu field → Enter (press_key) → wait_for menunggu teks
	// hasil → snapshot membuktikan hasil tampil.
	t.Run("FillPressKeyEnterWaitFor", func(t *testing.T) {
		c := newInputClient(t, ts.URL)
		if _, err := c.CallTool(ctx, "navigate_page", map[string]any{"url": ts.URL + "/cari"}); err != nil {
			t.Fatalf("navigate_page gagal: %v", err)
		}
		snap := snapshotOf(t, c, ctx)
		qUID := snapshotUID(t, snap, "textbox", "Cari")
		if _, err := c.CallTool(ctx, "fill", map[string]any{"uid": qUID, "value": "kopi-test"}); err != nil {
			t.Fatalf("fill gagal: %v", err)
		}
		// Fokus dulu ke field (klik) supaya Enter sampai ke field.
		if _, err := c.CallTool(ctx, "click", map[string]any{"uid": qUID}); err != nil {
			t.Fatalf("click field gagal: %v", err)
		}
		if _, err := c.CallTool(ctx, "press_key", map[string]any{"key": "Enter"}); err != nil {
			t.Fatalf("press_key Enter gagal: %v", err)
		}
		out, err := c.CallTool(ctx, "wait_for", map[string]any{"text": []string{"Hasil untuk: kopi-test"}})
		if err != nil {
			t.Fatalf("wait_for gagal: %v", err)
		}
		t.Logf("wait_for: %s", out)
		after := snapshotOf(t, c, ctx)
		if !strings.Contains(after, "Hasil untuk: kopi-test") {
			t.Fatalf("snapshot harus memuat hasil cari sesudah Enter, dapat:\n%s", after)
		}
		if got := c.InteractionCalls(); got != 3 {
			t.Fatalf("alur cari harus 3 panggilan interaksi (fill + click + press_key), dapat %d", got)
		}
	})

	// press_key Control+A: isi field catatan, fokus, seleksi semua,
	// lalu evaluate_script membaca selectionStart/selectionEnd —
	// bukti seleksi mencakup seluruh isi field.
	t.Run("PressKeyControlA", func(t *testing.T) {
		c := newInputClient(t, ts.URL)
		if _, err := c.CallTool(ctx, "navigate_page", map[string]any{"url": ts.URL + "/cari"}); err != nil {
			t.Fatalf("navigate_page gagal: %v", err)
		}
		snap := snapshotOf(t, c, ctx)
		noteUID := snapshotUID(t, snap, "textbox", "Catatan")
		const noteValue = "catatan-uji-123"
		if _, err := c.CallTool(ctx, "fill", map[string]any{"uid": noteUID, "value": noteValue}); err != nil {
			t.Fatalf("fill gagal: %v", err)
		}
		if _, err := c.CallTool(ctx, "click", map[string]any{"uid": noteUID}); err != nil {
			t.Fatalf("click field gagal: %v", err)
		}
		if _, err := c.CallTool(ctx, "press_key", map[string]any{"key": "Control+A"}); err != nil {
			t.Fatalf("press_key Control+A gagal: %v", err)
		}
		out, err := c.CallTool(ctx, "evaluate_script", map[string]any{
			"function": `() => { const el = document.getElementById('catatan'); return el.selectionStart + '-' + el.selectionEnd + '-' + el.value.length; }`,
		})
		if err != nil {
			t.Fatalf("evaluate_script gagal: %v", err)
		}
		t.Logf("seleksi: %s", out)
		want := fmt.Sprintf("0-%d-%d", len(noteValue), len(noteValue))
		if !strings.Contains(out, want) {
			t.Fatalf("Control+A harus menyeleksi seluruh isi (%s), dapat: %q", want, out)
		}
	})

	// wait_for benar-benar MENUNGGU: teks baru muncul 800 ms sesudah
	// halaman dibuka; wait_for sukses + tidak dihitung ke cap.
	t.Run("WaitForMenungguTeks", func(t *testing.T) {
		c := newInputClient(t, ts.URL)
		if _, err := c.CallTool(ctx, "navigate_page", map[string]any{"url": ts.URL + "/lambat"}); err != nil {
			t.Fatalf("navigate_page gagal: %v", err)
		}
		start := time.Now()
		out, err := c.CallTool(ctx, "wait_for", map[string]any{"text": []string{"teks-terlambat-xyz"}})
		if err != nil {
			t.Fatalf("wait_for teks terlambat gagal: %v", err)
		}
		elapsed := time.Since(start)
		t.Logf("wait_for teks terlambat: %s (%s)", out, elapsed.Round(time.Millisecond))
		if elapsed < 500*time.Millisecond {
			t.Fatalf("wait_for kembali terlalu cepat (%s) — teks baru muncul sesudah 800 ms, wait_for harus menunggu", elapsed.Round(time.Millisecond))
		}
		after := snapshotOf(t, c, ctx)
		if !strings.Contains(after, "teks-terlambat-xyz") {
			t.Fatalf("snapshot harus memuat teks terlambat, dapat:\n%s", after)
		}
		if got := c.InteractionCalls(); got != 0 {
			t.Fatalf("wait_for tidak boleh menambah counter interaksi, InteractionCalls()=%d", got)
		}
	})
}

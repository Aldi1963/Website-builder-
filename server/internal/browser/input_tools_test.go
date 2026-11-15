package browser

// Test alat input Fase 4 (rencana §6): click, fill, fill_form, press_key.
// Semua test di file ini TANPA Chrome asli — memakai server MCP palsu
// (pola browser_test.go) untuk jalur CallTool, dan pemanggilan fungsi
// langsung untuk gating/katalog/cap.
import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// fullServerTools adalah daftar tools/list server MCP 1.13.0 yang
// relevan: seluruh allowlist §5 (19) + keempat alat input Fase 4 +
// upload_file (ada di server, harus TETAP tertutup) + satu alat heap.
func fullServerTools() []*mcp.Tool {
	tools := []*mcp.Tool{}
	for _, n := range AllowlistTools {
		tools = append(tools, &mcp.Tool{Name: n, Description: n, InputSchema: map[string]interface{}{"type": "object", "properties": map[string]interface{}{}}})
	}
	for _, n := range InputTools {
		tools = append(tools, &mcp.Tool{Name: n, Description: n, InputSchema: map[string]interface{}{"type": "object", "properties": map[string]interface{}{}}})
	}
	tools = append(tools,
		&mcp.Tool{Name: "upload_file", Description: "upload — harus tetap tertutup"},
		&mcp.Tool{Name: "take_heapsnapshot", Description: "heap — bukan allowlist"},
	)
	return tools
}

func TestInputToolsFlagOff(t *testing.T) {
	// Flag input mati (nilai apa pun selain "1", termasuk tidak di-set):
	// keempat alat input tidak aktif, tidak lolos filter, tidak ada di
	// katalog (tetap 19 alat baca Fase 2), dan CallTool menolaknya
	// dengan error yang menyebut flag. wait_for tetap aktif — ia alat
	// tunggu §5, bukan alat input Fase 4.
	t.Setenv(EnvEnableBrowserInputTools, "0")
	for _, name := range InputTools {
		if !IsInteractionTool(name) {
			t.Fatalf("IsInteractionTool(%q) harus true walau flag mati (klasifikasi, bukan gating)", name)
		}
		if IsActiveTool(name) {
			t.Fatalf("IsActiveTool(%q) harus false bila flag input mati", name)
		}
	}
	if !IsActiveTool("wait_for") {
		t.Fatal("wait_for harus tetap aktif bila flag input mati")
	}
	if !IsActiveTool("take_snapshot") {
		t.Fatal("alat baca §5 harus tetap aktif bila flag input mati")
	}

	filtered := FilterAllowlist(fullServerTools())
	if len(filtered) != len(AllowlistTools) {
		t.Fatalf("FilterAllowlist flag mati harus meloloskan %d alat baca, dapat %d", len(AllowlistTools), len(filtered))
	}
	for _, tool := range filtered {
		if IsInteractionTool(tool.Name) {
			t.Fatalf("FilterAllowlist flag mati tidak boleh meloloskan %q", tool.Name)
		}
	}
	specs := SpecsFromTools(fullServerTools())
	if len(specs) != len(AllowlistTools) {
		t.Fatalf("katalog flag mati harus %d spek (Fase 2), dapat %d", len(AllowlistTools), len(specs))
	}
	for _, s := range specs {
		if s.Name == "browser_click" || s.Name == "browser_upload_file" {
			t.Fatalf("katalog flag mati tidak boleh memuat %q", s.Name)
		}
	}
	// MissingActiveTools flag mati: server lengkap 19 alat baca = tidak
	// ada yang hilang; alat input memang tidak diharapkan.
	nineteen := fullServerTools()[:len(AllowlistTools)]
	if got := MissingActiveTools(nineteen); len(got) != 0 {
		t.Fatalf("server 19 alat baca + flag mati harus 0 hilang, dapat %+v", got)
	}

	// CallTool menolak click SEBELUM menyentuh server, dengan error
	// yang menyebut nama flag (bukan error allowlist umum).
	ctx := context.Background()
	c := fakeClient(t)
	if err := c.Start(ctx); err != nil {
		t.Fatalf("Start gagal: %v", err)
	}
	if _, err := c.CallTool(ctx, "click", map[string]interface{}{"uid": "1_1"}); err == nil {
		t.Fatal("CallTool click flag mati harus ditolak")
	} else if !strings.Contains(err.Error(), EnvEnableBrowserInputTools) {
		t.Fatalf("error penolakan click harus menyebut flag %s, dapat: %v", EnvEnableBrowserInputTools, err)
	}
	// Penolakan flag tidak menghabiskan budget umum maupun cap.
	if got := c.BrowserCalls(); got != 0 {
		t.Fatalf("penolakan flag tidak boleh menghabiskan budget, BrowserCalls=%d", got)
	}
	if got := c.InteractionCalls(); got != 0 {
		t.Fatalf("penolakan flag tidak boleh menghabiskan cap interaksi, InteractionCalls=%d", got)
	}
}

func TestInputToolsFlagOn(t *testing.T) {
	// Flag input "1": katalog menjadi 23 spek (19 baca + 4 input),
	// MissingActiveTools memperhitungkan keempatnya, dan upload_file
	// tetap tertutup.
	t.Setenv(EnvEnableBrowserInputTools, "1")
	for _, name := range InputTools {
		if !IsActiveTool(name) {
			t.Fatalf("IsActiveTool(%q) harus true bila flag input \"1\"", name)
		}
	}
	if !IsActiveTool("wait_for") {
		t.Fatal("wait_for harus tetap aktif bila flag input nyala")
	}
	filtered := FilterAllowlist(fullServerTools())
	if len(filtered) != len(AllowlistTools)+len(InputTools) {
		t.Fatalf("FilterAllowlist flag nyala harus meloloskan %d alat, dapat %d", len(AllowlistTools)+len(InputTools), len(filtered))
	}
	specs := SpecsFromTools(fullServerTools())
	if len(specs) != len(AllowlistTools)+len(InputTools) {
		t.Fatalf("katalog flag nyala harus %d spek (19+4), dapat %d", len(AllowlistTools)+len(InputTools), len(specs))
	}
	seen := map[string]bool{}
	for _, s := range specs {
		seen[s.Name] = true
	}
	for _, want := range []string{"browser_click", "browser_fill", "browser_fill_form", "browser_press_key", "browser_wait_for", "browser_take_snapshot"} {
		if !seen[want] {
			t.Fatalf("katalog flag nyala harus memuat %q", want)
		}
	}
	if seen["browser_upload_file"] || seen["browser_take_heapsnapshot"] {
		t.Fatal("upload_file / heap tetap tertutup walau flag input nyala")
	}
	// MissingActiveTools flag nyala: server yang hanya punya 19 alat
	// baca → keempat alat input dilaporkan hilang; server 23 → 0.
	nineteen := fullServerTools()[:len(AllowlistTools)]
	missing := MissingActiveTools(nineteen)
	if len(missing) != len(InputTools) {
		t.Fatalf("server 19 alat + flag nyala harus %d hilang, dapat %+v", len(InputTools), missing)
	}
	for _, name := range InputTools {
		found := false
		for _, m := range missing {
			if m == name {
				found = true
			}
		}
		if !found {
			t.Fatalf("alat hilang harus memuat %q, dapat %+v", name, missing)
		}
	}
	if got := MissingActiveTools(fullServerTools()); len(got) != 0 {
		t.Fatalf("server lengkap 23+2 + flag nyala harus 0 hilang, dapat %+v", got)
	}
}

func TestInputToolsFlagValues(t *testing.T) {
	// Hanya persis "1" yang menyalakan — "true"/"yes"/"on"/"" tidak
	// (pola yang sama seperti Enabled).
	for _, v := range []string{"", "true", "yes", "on", "TRUE", " 1", "1 "} {
		t.Setenv(EnvEnableBrowserInputTools, v)
		if InputToolsEnabled() {
			t.Fatalf("InputToolsEnabled() harus false untuk nilai %q", v)
		}
		if IsActiveTool("click") {
			t.Fatalf("IsActiveTool(click) harus false untuk nilai flag %q", v)
		}
	}
	t.Setenv(EnvEnableBrowserInputTools, "1")
	if !InputToolsEnabled() || !IsActiveTool("click") {
		t.Fatal("nilai \"1\" harus menyalakan alat input")
	}
}

// TestInputToolsFlagOnAlone mendokumentasikan perilaku AKTUAL lapis
// paket browser: InputToolsEnabled() hanya membaca flag input —
// IsActiveTool/SpecsFromTools/CallTool TIDAK memeriksa dua flag
// browser utama (WEBBUILDER_ENABLE_BROWSER_TOOLS /
// WEBBUILDER_ENABLE_TENANT_EXEC). Konjungsi tiga flag hanya
// ditegakkan di lapis lifecycle (NewClientForRun menolak bila
// Enabled() false — lihat subtest kedua di bawah), BUKAN di
// tools.go/client.go. Docs (browser-tools.md tabel env +
// mcp-browser-integration-plan.md §6 Fase 4) menyatakan alat input
// "hanya berlaku bila dua flag di atas juga 1" tanpa membedakan
// lapis — itu KETIDAKCOCOKAN docs vs kode (dilaporkan ke koordinator;
// test ini mengunci perilaku kode, bukan klaim docs).
func TestInputToolsFlagOnAlone(t *testing.T) {
	t.Setenv(EnvEnableBrowserInputTools, "1")
	t.Setenv(EnvEnableBrowserTools, "0")
	t.Setenv(EnvEnableTenantExec, "0")
	if !IsActiveTool("click") {
		t.Fatal("PERILAKU AKTUAL: IsActiveTool(click) true bila hanya flag input \"1\" (tanpa flag utama)")
	}
	specs := SpecsFromTools(fullServerTools())
	if len(specs) != len(AllowlistTools)+len(InputTools) {
		t.Fatalf("PERILAKU AKTUAL: katalog %d spek bila hanya flag input \"1\", bukan 19", len(specs))
	}
	// Lapis lifecycle tetap fail-closed: tanpa dua flag utama, klien
	// untuk run TIDAK BISA dibuat — jadi jalur pipeline (satu-satunya
	// jalur produksi) tetap menuntut ketiga flag.
	if _, err := NewClientForRun(1, t.TempDir()); err == nil {
		t.Fatal("NewClientForRun harus menolak bila dua flag browser utama mati, walau flag input \"1\"")
	} else if !strings.Contains(err.Error(), "browser tools disabled") {
		t.Fatalf("error NewClientForRun harus ErrBrowserToolsDisabled, dapat: %v", err)
	}
}

func TestReserveInteractionCallCap(t *testing.T) {
	// Unit langsung (tanpa server): cap 5 per Client; alat baca
	// (termasuk wait_for) tidak dihitung; Client baru mulai dari 0.
	c := NewClient(Config{})
	if got := c.InteractionCalls(); got != 0 {
		t.Fatalf("Client baru harus InteractionCalls()=0, dapat %d", got)
	}
	// Campur keempat alat input: 2 click + 2 fill + 1 press_key = 5.
	for i, name := range []string{"click", "click", "fill", "fill", "press_key"} {
		if err := c.reserveInteractionCall(name); err != nil {
			t.Fatalf("panggilan interaksi ke-%d (%s) harus lolos: %v", i+1, name, err)
		}
	}
	if got := c.InteractionCalls(); got != MaxInteractionCallsPerRun {
		t.Fatalf("sesudah 5 interaksi InteractionCalls() harus %d, dapat %d", MaxInteractionCallsPerRun, got)
	}
	// Panggilan interaksi ke-6 (fill_form) DITOLAK dengan error cap.
	if err := c.reserveInteractionCall("fill_form"); err == nil {
		t.Fatal("panggilan interaksi ke-6 harus ditolak")
	} else if !strings.Contains(err.Error(), "batas interaksi") {
		t.Fatalf("error cap harus menyebut \"batas interaksi\", dapat: %v", err)
	}
	if got := c.InteractionCalls(); got != MaxInteractionCallsPerRun {
		t.Fatalf("penolakan cap tidak boleh menambah hitungan, InteractionCalls()=%d", got)
	}
	// wait_for (dan alat baca lain) TIDAK menambah counter — bahkan
	// sesudah cap habis, wait_for tetap lolos.
	for _, name := range []string{"wait_for", "take_snapshot", "list_console_messages"} {
		if err := c.reserveInteractionCall(name); err != nil {
			t.Fatalf("reserveInteractionCall(%q) harus selalu lolos: %v", name, err)
		}
	}
	if got := c.InteractionCalls(); got != MaxInteractionCallsPerRun {
		t.Fatalf("alat baca tidak boleh menambah counter interaksi, InteractionCalls()=%d", got)
	}
	// Client baru = counter reset (cap per run, bukan global).
	c2 := NewClient(Config{})
	if got := c2.InteractionCalls(); got != 0 {
		t.Fatalf("Client baru harus InteractionCalls()=0, dapat %d", got)
	}
	if err := c2.reserveInteractionCall("click"); err != nil {
		t.Fatalf("Client baru harus bisa interaksi pertama: %v", err)
	}
}

func TestInteractionCapEndToEndFakeClient(t *testing.T) {
	// Ujung-ke-ujung lewat CallTool + server MCP palsu (tanpa Chrome):
	// urutan cek di CallTool adalah flag → allowlist → URL → belum
	// start → cap interaksi → budget umum → server. Server palsu
	// mengembalikan IsError untuk click (tidak ditangani fake), tapi
	// counter sudah bertambah SEBELUM pemanggilan server — jadi 5
	// percobaan click terhitung, dan yang ke-6 ditolak cap SEBELUM
	// reserveCall (budget umum tidak bertambah).
	t.Setenv(EnvEnableBrowserInputTools, "1")
	ctx := context.Background()
	c := fakeClient(t)
	if err := c.Start(ctx); err != nil {
		t.Fatalf("Start gagal: %v", err)
	}
	for i := 1; i <= MaxInteractionCallsPerRun; i++ {
		if _, err := c.CallTool(ctx, "click", map[string]interface{}{"uid": "1_1"}); err == nil {
			t.Fatalf("click ke-%d: server palsu harus mengembalikan error tool (bukan sukses)", i)
		} else if strings.Contains(err.Error(), "batas interaksi") {
			t.Fatalf("click ke-%d tidak boleh ditolak cap: %v", i, err)
		}
		if got := c.InteractionCalls(); got != i {
			t.Fatalf("sesudah click ke-%d InteractionCalls() harus %d, dapat %d", i, i, got)
		}
		if got := c.BrowserCalls(); got != i {
			t.Fatalf("sesudah click ke-%d BrowserCalls() harus %d (interaksi tetap dihitung ke budget 15), dapat %d", i, i, got)
		}
	}
	// Click ke-6: ditolak cap, BrowserCalls TETAP 5.
	if _, err := c.CallTool(ctx, "click", map[string]interface{}{"uid": "1_1"}); err == nil {
		t.Fatal("click ke-6 harus ditolak cap interaksi")
	} else if !strings.Contains(err.Error(), "batas interaksi") {
		t.Fatalf("error click ke-6 harus menyebut \"batas interaksi\", dapat: %v", err)
	}
	if got := c.BrowserCalls(); got != MaxInteractionCallsPerRun {
		t.Fatalf("penolakan cap TIDAK boleh menghabiskan budget umum, BrowserCalls()=%d (harus %d)", got, MaxInteractionCallsPerRun)
	}
	if got := c.InteractionCalls(); got != MaxInteractionCallsPerRun {
		t.Fatalf("penolakan cap tidak boleh menambah counter interaksi, InteractionCalls()=%d", got)
	}
	// wait_for sesudah cap habis: TIDAK menambah counter interaksi
	// (server palsu mengembalikan IsError — yang diuji di sini hanya
	// hitungannya, bukan sukses server).
	if _, err := c.CallTool(ctx, "wait_for", map[string]interface{}{"text": []string{"tidak-ada"}}); err == nil {
		t.Fatal("wait_for ke server palsu harus mengembalikan error tool (tidak ditangani fake)")
	} else if strings.Contains(err.Error(), "batas interaksi") {
		t.Fatalf("wait_for tidak boleh ditolak cap interaksi: %v", err)
	}
	if got := c.InteractionCalls(); got != MaxInteractionCallsPerRun {
		t.Fatalf("wait_for tidak boleh menambah counter interaksi, InteractionCalls()=%d", got)
	}
	// ...tapi wait_for TETAP dihitung ke budget umum (baca biasa).
	if got := c.BrowserCalls(); got != MaxInteractionCallsPerRun+1 {
		t.Fatalf("wait_for harus dihitung ke budget umum, BrowserCalls()=%d (harus %d)", got, MaxInteractionCallsPerRun+1)
	}
}

func TestCallToolObserverRecordsInputToolName(t *testing.T) {
	// Observer (Fase 3): bila flag input nyala, pemanggilan click yang
	// sukses/gagal dicatat tool="click" — BUKAN "unknown". Bila flag
	// mati, penolakan click dicatat "unknown" (lihat
	// TestCallToolObserverSuccessAndRejection).
	t.Setenv(EnvEnableBrowserInputTools, "1")
	ctx := context.Background()
	c := fakeClient(t)
	if err := c.Start(ctx); err != nil {
		t.Fatalf("Start gagal: %v", err)
	}
	var mu sync.Mutex
	var got []string
	c.SetCallObserver(func(tool string, _ time.Duration, _ error) {
		mu.Lock()
		defer mu.Unlock()
		got = append(got, tool)
	})
	// Server palsu mengembalikan IsError untuk click — CallTool tetap
	// error, tapi observer harus mencatat nama aslinya.
	if _, err := c.CallTool(ctx, "click", map[string]interface{}{"uid": "1_1"}); err == nil {
		t.Fatal("click ke server palsu harus error (tidak ditangani fake)")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(got) != 1 || got[0] != "click" {
		t.Fatalf("observer flag nyala harus mencatat tool=\"click\", dapat %v", got)
	}
}

func TestWaitForStaysActiveWithoutInputFlag(t *testing.T) {
	// wait_for adalah alat §5 sejak Fase 2: aktif tanpa flag input,
	// dan pemanggilannya tidak menyentuh cap interaksi — dibuktikan
	// lewat jalur CallTool penuh (server palsu) + counter.
	t.Setenv(EnvEnableBrowserInputTools, "0")
	ctx := context.Background()
	c := fakeClient(t)
	if err := c.Start(ctx); err != nil {
		t.Fatalf("Start gagal: %v", err)
	}
	if !IsActiveTool("wait_for") {
		t.Fatal("IsActiveTool(wait_for) harus true tanpa flag input")
	}
	// Panggilan wait_for lolos gating (gagalnya hanya karena server
	// palsu tidak menangani wait_for — bukan karena ditolak).
	if _, err := c.CallTool(ctx, "wait_for", map[string]interface{}{"text": []string{"x"}}); err == nil {
		t.Fatal("wait_for ke server palsu harus error tool")
	} else if strings.Contains(err.Error(), "tidak aktif") || strings.Contains(err.Error(), "batas interaksi") {
		t.Fatalf("wait_for tidak boleh ditolak gating/cap: %v", err)
	}
	if got := c.InteractionCalls(); got != 0 {
		t.Fatalf("wait_for tidak boleh menambah counter interaksi, InteractionCalls()=%d", got)
	}
}

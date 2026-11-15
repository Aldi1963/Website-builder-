package browser

// Test hardening Fase 3 (rencana §6): allowlist URL per port preview,
// budget per run, cap output 64 KiB, timeout per panggilan. Semua memakai
// server MCP palsu (pola browser_test.go) kecuali test Chrome asli di
// browser_integration_test.go.
import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestPreviewPortFailClosedBeforeKnown(t *testing.T) {
	ctx := context.Background()
	c := fakeClient(t)
	if err := c.Start(ctx); err != nil {
		t.Fatalf("Start gagal: %v", err)
	}
	if got := c.PreviewPort(); got != 0 {
		t.Fatalf("port preview awal harus 0 (belum diketahui), dapat %d", got)
	}
	// Tool TANPA argumen url tetap jalan sebelum port diketahui.
	if _, err := c.CallTool(ctx, "list_console_messages", map[string]interface{}{}); err != nil {
		t.Fatalf("tool tanpa URL harus jalan sebelum port diketahui: %v", err)
	}
	// Navigate ke port localhost mana pun DITOLAK fail-closed — jangan
	// fallback ke "port mana pun" (dulu ValidateURL meloloskan semua).
	for _, u := range []string{
		"http://127.0.0.1:18098/",
		"http://127.0.0.1:18082/",
		"http://localhost:3000/",
	} {
		if _, err := c.CallTool(ctx, "navigate_page", map[string]interface{}{"url": u}); err == nil {
			t.Fatalf("navigate %q harus ditolak sebelum port diketahui", u)
		} else if !strings.Contains(err.Error(), "belum diketahui") {
			t.Fatalf("error harus menyebut port belum diketahui, dapat: %v", err)
		}
	}
}

func TestPreviewPortAcceptOwnRejectOthers(t *testing.T) {
	ctx := context.Background()
	c := fakeClient(t)
	if err := c.Start(ctx); err != nil {
		t.Fatalf("Start gagal: %v", err)
	}
	// Port tidak valid ditolak tanpa mengubah port lama (masih 0).
	for _, bad := range []int{0, -1, 70000} {
		if err := c.SetPreviewPort(bad); err == nil {
			t.Fatalf("SetPreviewPort(%d) harus error", bad)
		}
	}
	if got := c.PreviewPort(); got != 0 {
		t.Fatalf("port tidak valid tidak boleh mengubah port, dapat %d", got)
	}
	if err := c.SetPreviewPort(18098); err != nil {
		t.Fatalf("SetPreviewPort(18098) gagal: %v", err)
	}
	// Port preview sendiri DITERIMA (127.0.0.1 + localhost, host alias).
	for _, u := range []string{
		"http://127.0.0.1:18098/",
		"http://localhost:18098/index.html",
		"https://127.0.0.1:18098/x",
	} {
		out, err := c.CallTool(ctx, "navigate_page", map[string]interface{}{"url": u})
		if err != nil {
			t.Fatalf("navigate port sendiri %q harus lolos, dapat: %v", u, err)
		}
		if !strings.Contains(out, "Successfully navigated") {
			t.Fatalf("navigate port sendiri harus sukses, dapat %q", out)
		}
	}
	// Port localhost LAIN ditolak — termasuk port server sendiri (18082),
	// database (5432), server uji (18086), dan gateway (18080).
	for _, u := range []string{
		"http://127.0.0.1:18082/",
		"http://127.0.0.1:5432/",
		"http://127.0.0.1:18086/",
		"http://127.0.0.1:18080/",
		"http://localhost:18082/",
		"http://127.0.0.1/",
		"https://example.com/",
		"http://127.0.0.1.evil.com:18098/",
	} {
		if _, err := c.CallTool(ctx, "navigate_page", map[string]interface{}{"url": u}); err == nil {
			t.Fatalf("navigate %q harus ditolak (bukan port preview)", u)
		}
	}
	// Jalur acceptance internal tunduk pada batas yang sama.
	if _, err := c.callAcceptanceTool(ctx, "navigate_page", map[string]interface{}{"url": "http://127.0.0.1:18082/"}); err == nil {
		t.Fatal("callAcceptanceTool ke port lain harus ditolak")
	}
	if _, err := c.callAcceptanceTool(ctx, "navigate_page", map[string]interface{}{"url": "http://127.0.0.1:18098/"}); err != nil {
		t.Fatalf("callAcceptanceTool ke port sendiri harus lolos: %v", err)
	}
}

func TestSetPreviewPortFromURLMismatch(t *testing.T) {
	c := fakeClient(t)
	if err := c.SetPreviewPort(18098); err != nil {
		t.Fatalf("SetPreviewPort gagal: %v", err)
	}
	// URL port sama: belajar ulang tidak masalah (idempotent).
	if err := c.setPreviewPortFromURL("http://127.0.0.1:18098/healthy.html"); err != nil {
		t.Fatalf("URL port sama harus diterima: %v", err)
	}
	// URL port berbeda dari yang dikunci: ditolak, port tidak berubah.
	if err := c.setPreviewPortFromURL("http://127.0.0.1:18099/healthy.html"); err == nil {
		t.Fatal("URL port berbeda dari port terkunci harus ditolak")
	}
	if got := c.PreviewPort(); got != 18098 {
		t.Fatalf("port terkunci harus tetap 18098, dapat %d", got)
	}
	// URL luar / tanpa port eksplisit juga ditolak di sini.
	for _, u := range []string{"https://example.com/", "http://127.0.0.1/"} {
		if err := c.setPreviewPortFromURL(u); err == nil {
			t.Fatalf("setPreviewPortFromURL(%q) harus ditolak", u)
		}
	}
}

func TestVerifyPreviewLearnsPortFromURL(t *testing.T) {
	ctx := context.Background()
	c := fakeClient(t)
	if err := c.Start(ctx); err != nil {
		t.Fatalf("Start gagal: %v", err)
	}
	// Tanpa SetPreviewPort dulu: VerifyPreview mempelajari port dari
	// previewURL-nya sendiri (sumber tepercaya: pipeline) lalu lolos.
	res, err := VerifyPreview(ctx, c, "http://127.0.0.1:18098/healthy.html", "screenshot-1.png")
	if err != nil {
		t.Fatalf("VerifyPreview halaman sehat fake gagal: %v", err)
	}
	if !res.Passed {
		t.Fatalf("halaman sehat fake harus lolos, console=%+v network=%+v", res.ConsoleErrors, res.FailedRequests)
	}
	if got := c.PreviewPort(); got != 18098 {
		t.Fatalf("VerifyPreview harus mengunci port 18098, dapat %d", got)
	}
	// Sesudah belajar, navigasi model ke port lain ditolak.
	if _, err := c.CallTool(ctx, "navigate_page", map[string]interface{}{"url": "http://127.0.0.1:18082/"}); err == nil {
		t.Fatal("navigate port lain harus ditolak sesudah port dipelajari")
	}
	// VerifyPreview ke port berbeda dari yang terkunci ditolak.
	if _, err := VerifyPreview(ctx, c, "http://127.0.0.1:18099/healthy.html", "screenshot-2.png"); err == nil {
		t.Fatal("VerifyPreview port berbeda dari port terkunci harus ditolak")
	}
}

func TestBrowserBudgetMaxCalls(t *testing.T) {
	ctx := context.Background()
	c := fakeClient(t)
	if err := c.Start(ctx); err != nil {
		t.Fatalf("Start gagal: %v", err)
	}
	// ListTools TIDAK dihitung: panggil di tengah-tengah tanpa
	// mengurangi jatah 15.
	for i := 0; i < MaxBrowserCallsPerRun; i++ {
		if _, err := c.CallTool(ctx, "list_console_messages", map[string]interface{}{}); err != nil {
			t.Fatalf("panggilan ke-%d harus lolos, dapat: %v", i+1, err)
		}
		if i == 4 {
			if _, err := c.ListTools(ctx); err != nil {
				t.Fatalf("ListTools gagal: %v", err)
			}
		}
	}
	if got := c.BrowserCalls(); got != MaxBrowserCallsPerRun {
		t.Fatalf("harus tepat %d panggilan terhitung, dapat %d", MaxBrowserCallsPerRun, got)
	}
	// Panggilan ke-16 DITOLAK dengan error jelas, bukan menggantung.
	if _, err := c.CallTool(ctx, "list_console_messages", map[string]interface{}{}); err == nil {
		t.Fatal("panggilan ke-16 harus ditolak budget")
	} else if !strings.Contains(err.Error(), "budget") || !strings.Contains(err.Error(), "15") {
		t.Fatalf("error budget harus menyebut budget + batas 15, dapat: %v", err)
	}
	if got := c.BrowserCalls(); got != MaxBrowserCallsPerRun {
		t.Fatalf("panggilan ditolak tidak boleh menambah hitungan, dapat %d", got)
	}
	// Jalur acceptance internal memakai jatah yang SAMA (bukan budget
	// terpisah): sesudah 15 panggilan model, acceptance juga ditolak.
	if _, err := c.callAcceptanceTool(ctx, "list_console_messages", map[string]interface{}{}); err == nil {
		t.Fatal("callAcceptanceTool sesudah budget habis harus ditolak")
	}
	// Satu VerifyPreview utuh (5 panggilan) tidak muat di sisa 0.
	if _, err := VerifyPreview(ctx, c, "http://127.0.0.1:18098/healthy.html", "screenshot-1.png"); err == nil {
		t.Fatal("VerifyPreview sesudah budget habis harus gagal")
	}
}

func TestBrowserBudgetWindowExpires(t *testing.T) {
	ctx := context.Background()
	c := fakeClient(t)
	// Jam suntik + jendela kecil: membuktikan penegakan jendela tanpa
	// menunggu 5 menit sungguhan (produksi: BrowserBudgetWindow).
	now := time.Now()
	c.now = func() time.Time { return now }
	c.budgetWindow = 100 * time.Millisecond
	if err := c.Start(ctx); err != nil {
		t.Fatalf("Start gagal: %v", err)
	}
	if _, err := c.CallTool(ctx, "list_console_messages", map[string]interface{}{}); err != nil {
		t.Fatalf("panggilan pertama harus lolos: %v", err)
	}
	now = now.Add(50 * time.Millisecond)
	if _, err := c.CallTool(ctx, "list_console_messages", map[string]interface{}{}); err != nil {
		t.Fatalf("panggilan di dalam jendela harus lolos: %v", err)
	}
	// Lewat jendela (150 mdtk sejak panggilan pertama): ditolak walau
	// hitungan baru 2 dari 15 — jendela tidak me-reset hitungan.
	now = now.Add(100 * time.Millisecond)
	if _, err := c.CallTool(ctx, "list_console_messages", map[string]interface{}{}); err == nil {
		t.Fatal("panggilan sesudah jendela budget harus ditolak")
	} else if !strings.Contains(err.Error(), "budget") {
		t.Fatalf("error harus menyebut budget, dapat: %v", err)
	}
	if got := c.BrowserCalls(); got != 2 {
		t.Fatalf("panggilan ditolak tidak boleh menambah hitungan, dapat %d", got)
	}
}

func TestCallToolTruncatesLargeOutput(t *testing.T) {
	ctx := context.Background()
	c := fakeClientMode(t, "huge")
	if err := c.Start(ctx); err != nil {
		t.Fatalf("Start gagal: %v", err)
	}
	out, err := c.CallTool(ctx, "list_console_messages", map[string]interface{}{})
	if err != nil {
		t.Fatalf("CallTool output besar harus sukses (dipotong, bukan error): %v", err)
	}
	if !strings.HasPrefix(out, "AWAL-HUGE-") {
		t.Fatalf("output terpotong harus mempertahankan awal, dapat %q", out[:20])
	}
	if !strings.Contains(out, "[dipotong: output melebihi 64 KiB]") {
		t.Fatal("output >64 KiB harus membawa penanda terpotong")
	}
	wantLen := MaxOutputBytes + len("\n...[dipotong: output melebihi 64 KiB]")
	if len(out) != wantLen {
		t.Fatalf("output terpotong harus tepat %d byte, dapat %d", wantLen, len(out))
	}
}

func TestCallToolTruncatesErrorOutput(t *testing.T) {
	ctx := context.Background()
	c := fakeClientMode(t, "huge-error")
	if err := c.Start(ctx); err != nil {
		t.Fatalf("Start gagal: %v", err)
	}
	// Jalur IsError: hasil DAN pesan error ikut ter-cap 64 KiB.
	out, err := c.CallTool(ctx, "take_snapshot", map[string]interface{}{})
	if err == nil {
		t.Fatal("tool IsError harus mengembalikan error")
	}
	for _, s := range []string{out, err.Error()} {
		if !strings.Contains(s, "[dipotong: output melebihi 64 KiB]") {
			t.Fatalf("jalur error harus ikut ter-cap + bermarker, dapat %q", s[:80])
		}
		if len(s) > MaxOutputBytes+200 {
			t.Fatalf("jalur error tidak boleh melebihi cap + marker, panjang %d", len(s))
		}
	}
	if !strings.HasPrefix(out, "AWAL-HUGE-ERROR-") {
		t.Fatalf("hasil error terpotong harus mempertahankan awal, dapat %q", out[:20])
	}
}

func TestCallToolTimeoutEnforced(t *testing.T) {
	// CallTimeout produksi tetap 30 detik (rencana §4) — jangan diubah.
	if CallTimeout != 30*time.Second {
		t.Fatalf("CallTimeout harus tetap 30 detik, dapat %s", CallTimeout)
	}
	ctx := context.Background()
	c := fakeClientMode(t, "slow")
	// Suntik timeout kecil: server palsu tidur 2 dtk per panggilan,
	// CallTool harus membatalkan di ~200 mdtk lewat jalur yang sama.
	c.callTimeout = 200 * time.Millisecond
	if err := c.Start(ctx); err != nil {
		t.Fatalf("Start gagal: %v", err)
	}
	start := time.Now()
	_, err := c.CallTool(ctx, "list_console_messages", map[string]interface{}{})
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("panggilan ke server lambat harus timeout, bukan sukses")
	}
	if elapsed > 1500*time.Millisecond {
		t.Fatalf("timeout harus membatalkan cepat (200 mdtk), malah %s", elapsed)
	}
	if !strings.Contains(strings.ToLower(err.Error()), "deadline") && !strings.Contains(strings.ToLower(err.Error()), "timeout") && !strings.Contains(strings.ToLower(err.Error()), "context") {
		t.Fatalf("error harus menyebut deadline/timeout, dapat: %v", err)
	}
}

package browser

import (
	"bytes"
	"context"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"webbuilder/internal/observability"
)

// Observer CallTool (Fase 3 item 2): setiap pemanggilan — sukses,
// gagal, maupun ditolak sebelum menyentuh server — tercatat sekali
// dengan nama tool ternormalisasi + durasi + error.

func TestCallToolObserverSuccessAndRejection(t *testing.T) {
	ctx := context.Background()
	c := fakeClient(t)
	if err := c.Start(ctx); err != nil {
		t.Fatalf("Start gagal: %v", err)
	}

	var mu sync.Mutex
	type obs struct {
		tool     string
		dur      time.Duration
		haveErr  bool
	}
	var got []obs
	c.SetCallObserver(func(tool string, dur time.Duration, err error) {
		mu.Lock()
		defer mu.Unlock()
		got = append(got, obs{tool: tool, dur: dur, haveErr: err != nil})
	})

	// Sukses: satu observasi, status sukses, durasi >= 0.
	if _, err := c.CallTool(ctx, "list_console_messages", map[string]interface{}{}); err != nil {
		t.Fatalf("CallTool sukses gagal: %v", err)
	}
	// Ditolak allowlist: tetap tercatat, nama dinormalisasi "unknown",
	// status error — pesan error tidak ikut sebagai label.
	if _, err := c.CallTool(ctx, "click", map[string]interface{}{"uid": "1_1"}); err == nil {
		t.Fatal("tool di luar allowlist harus ditolak")
	}
	// Ditolak URL luar (validatePreviewURL, port belum dikunci):
	// tercatat sebagai tool aslinya + error.
	if _, err := c.CallTool(ctx, "navigate_page", map[string]interface{}{"url": "https://example.com/"}); err == nil {
		t.Fatal("URL luar harus ditolak")
	}

	mu.Lock()
	defer mu.Unlock()
	if len(got) != 3 {
		t.Fatalf("observer harus dipanggil 3x, dapat %d: %+v", len(got), got)
	}
	if got[0].tool != "list_console_messages" || got[0].haveErr {
		t.Fatalf("observasi sukses salah: %+v", got[0])
	}
	if got[0].dur < 0 {
		t.Fatalf("durasi tidak boleh negatif: %+v", got[0])
	}
	if got[1].tool != "unknown" || !got[1].haveErr {
		t.Fatalf("penolakan allowlist harus tercatat tool=unknown + error: %+v", got[1])
	}
	if got[2].tool != "navigate_page" || !got[2].haveErr {
		t.Fatalf("penolakan URL harus tercatat tool=navigate_page + error: %+v", got[2])
	}
}

// Observer yang panic tidak boleh menggagalkan panggilan tool.
func TestCallToolObserverPanicIsolated(t *testing.T) {
	ctx := context.Background()
	c := fakeClient(t)
	if err := c.Start(ctx); err != nil {
		t.Fatalf("Start gagal: %v", err)
	}
	c.SetCallObserver(func(string, time.Duration, error) { panic("observer rusak") })
	if _, err := c.CallTool(ctx, "list_console_messages", map[string]interface{}{}); err != nil {
		t.Fatalf("CallTool harus tetap sukses walau observer panic: %v", err)
	}
}

// Tanpa observer (nil), CallTool jalan normal tanpa pencatatan.
func TestCallToolWithoutObserver(t *testing.T) {
	ctx := context.Background()
	c := fakeClient(t)
	c.SetCallObserver(nil)
	if err := c.Start(ctx); err != nil {
		t.Fatalf("Start gagal: %v", err)
	}
	if _, err := c.CallTool(ctx, "list_console_messages", map[string]interface{}{}); err != nil {
		t.Fatalf("CallTool tanpa observer gagal: %v", err)
	}
}

// NewClient men-snapshot observer default: klien yang dibuat sesudah
// SetDefaultCallObserver otomatis tercatat; klien lama tidak
// terpengaruh.
func TestDefaultCallObserverSnapshot(t *testing.T) {
	prev := DefaultCallObserver()
	defer SetDefaultCallObserver(prev)

	called := 0
	SetDefaultCallObserver(func(string, time.Duration, error) { called++ })
	c := NewClient(Config{Command: os.Args[0]})
	// Panggil observeCall langsung (tanpa Start): cukup membuktikan
	// snapshot observer ikut di Client baru.
	c.observeCall("list_console_messages", time.Now(), nil)
	if called != 1 {
		t.Fatalf("observer default harus dipakai Client baru, called=%d", called)
	}

	SetDefaultCallObserver(nil)
	c2 := NewClient(Config{Command: os.Args[0]})
	c2.observeCall("list_console_messages", time.Now(), nil)
	if called != 1 {
		t.Fatalf("Client baru sesudah default dimatikan tidak boleh tercatat, called=%d", called)
	}
}

// Jalur acceptance internal (callAcceptanceTool) juga tercatat —
// pemakaian scripted RunAcceptance/CaptureScreenshot tidak boleh
// lolos dari metrik.
func TestCallAcceptanceToolObserver(t *testing.T) {
	ctx := context.Background()
	c := fakeClient(t)
	if err := c.Start(ctx); err != nil {
		t.Fatalf("Start gagal: %v", err)
	}
	var seen []string
	c.SetCallObserver(func(tool string, _ time.Duration, err error) {
		if err == nil {
			seen = append(seen, tool)
		}
	})
	if _, err := c.callAcceptanceTool(ctx, "take_snapshot", map[string]interface{}{}); err != nil {
		t.Fatalf("callAcceptanceTool gagal: %v", err)
	}
	if len(seen) != 1 || seen[0] != "take_snapshot" {
		t.Fatalf("acceptance harus tercatat 1x sebagai take_snapshot, dapat %v", seen)
	}
	// Budget per run Trek A (maks 10): observasi di atas + yang ini
	// masih di bawah batas.
	if _, err := c.callAcceptanceTool(ctx, "list_console_messages", map[string]interface{}{}); err != nil {
		t.Fatalf("callAcceptanceTool kedua gagal: %v", err)
	}
	if len(seen) != 2 {
		t.Fatalf("dua pemanggilan acceptance harus tercatat 2x, dapat %v", seen)
	}
}

// Observer → Metrics → exposition: satu CallTool nyata lewat server
// MCP palsu harus muncul sebagai seri di /metrics (format handler
// MetricsHandler). Ini membuktikan rantai wiring end-to-end tanpa
// server HTTP.
func TestCallToolObserverFeedsMetrics(t *testing.T) {
	ctx := context.Background()
	c := fakeClient(t)
	if err := c.Start(ctx); err != nil {
		t.Fatalf("Start gagal: %v", err)
	}
	// Rantai wiring end-to-end: observer = Metrics.RecordBrowserTool
	// (persis seperti yang dipasang RegisterObservability), lalu
	// exposition ditulis MetricsHandler/WritePrometheus.
	m := observability.NewMetrics()
	c.SetCallObserver(m.RecordBrowserTool)
	if _, err := c.CallTool(ctx, "list_console_messages", map[string]interface{}{}); err != nil {
		t.Fatalf("CallTool gagal: %v", err)
	}
	var buf bytes.Buffer
	m.WritePrometheus(&buf)
	body := buf.String()
	for _, want := range []string{
		`browser_tool_calls_total{tool="list_console_messages",status="success"} 1`,
		`browser_tool_calls_duration_seconds_count{tool="list_console_messages"} 1`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("/metrics harus memuat %q\n--- body ---\n%s", want, body)
		}
	}
	if strings.Contains(body, `browser_tool_calls_total{tool="list_console_messages",status="error"}`) {
		t.Fatalf("tidak boleh ada seri error untuk panggilan sukses:\n%s", body)
	}
}

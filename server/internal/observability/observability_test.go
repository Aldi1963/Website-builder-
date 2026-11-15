package observability

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func TestMetricsRecordAndExposition(t *testing.T) {
	m := NewMetrics()
	m.Record("GET", "/api/projects", 200)
	m.Record("GET", "/api/projects", 200)
	m.Record("POST", "/api/projects", 500)
	m.Record("GET", "/healthz", 200)

	if got := m.RequestsTotal("GET", "/api/projects", 200); got != 2 {
		t.Fatalf("RequestsTotal GET /api/projects 200 = %d, mau 2", got)
	}
	if got := m.ErrorsTotal("POST", "/api/projects"); got != 1 {
		t.Fatalf("ErrorsTotal POST /api/projects = %d, mau 1", got)
	}
	if got := m.ErrorsTotal("GET", "/api/projects"); got != 0 {
		t.Fatalf("ErrorsTotal GET /api/projects = %d, mau 0", got)
	}

	var buf bytes.Buffer
	m.WritePrometheus(&buf)
	out := buf.String()
	for _, want := range []string{
		`webbuilder_http_requests_total{method="GET",route="/api/projects",status="200"} 2`,
		`webbuilder_http_requests_total{method="POST",route="/api/projects",status="500"} 1`,
		`webbuilder_http_errors_total{method="POST",route="/api/projects"} 1`,
		`webbuilder_http_requests_in_flight 0`,
		"# TYPE webbuilder_http_requests_total counter",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("exposition tidak memuat %q\n--- output ---\n%s", want, out)
		}
	}
	if strings.Contains(out, `webbuilder_http_errors_total{method="GET",route="/api/projects"}`) {
		t.Fatal("error counter tidak boleh muncul untuk route tanpa 5xx")
	}
}

func TestMetricsInFlightGauge(t *testing.T) {
	m := NewMetrics()
	m.IncInFlight()
	m.IncInFlight()
	if got := m.InFlight(); got != 2 {
		t.Fatalf("InFlight = %d, mau 2", got)
	}
	m.DecInFlight()
	if got := m.InFlight(); got != 1 {
		t.Fatalf("InFlight = %d, mau 1", got)
	}
}

func TestLivenessHandler(t *testing.T) {
	w := httptest.NewRecorder()
	LivenessHandler().ServeHTTP(w, httptest.NewRequest("GET", "/healthz", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("healthz status = %d, mau 200", w.Code)
	}
	if !strings.Contains(w.Body.String(), `"status":"ok"`) {
		t.Fatalf("healthz body salah: %s", w.Body.String())
	}
}

func TestReadinessHandlerOKAndFail(t *testing.T) {
	okPing := func(ctx context.Context) error { return nil }
	failPing := func(ctx context.Context) error { return errors.New("db down") }

	w := httptest.NewRecorder()
	ReadinessHandler(map[string]PingFunc{"database": okPing}).ServeHTTP(w, httptest.NewRequest("GET", "/readyz", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("readyz ok status = %d, mau 200", w.Code)
	}

	w = httptest.NewRecorder()
	ReadinessHandler(map[string]PingFunc{"database": failPing}).ServeHTTP(w, httptest.NewRequest("GET", "/readyz", nil))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("readyz gagal status = %d, mau 503", w.Code)
	}
	if strings.Contains(w.Body.String(), "db down") {
		t.Fatal("readyz tidak boleh membocorkan detail error ke klien")
	}
	if !strings.Contains(w.Body.String(), `"check":"database"`) {
		t.Fatalf("readyz harus menyebut check yang gagal: %s", w.Body.String())
	}
}

func TestMetricsHandlerContentType(t *testing.T) {
	m := NewMetrics()
	m.Record("GET", "/x", 200)
	w := httptest.NewRecorder()
	MetricsHandler(m).ServeHTTP(w, httptest.NewRequest("GET", "/metrics", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("metrics status = %d, mau 200", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/plain") {
		t.Fatalf("metrics content-type = %q, mau text/plain", ct)
	}
}

// Metrik browser Fase 3 item 2: counter per tool/status + histogram
// durasi, format exposition valid, label terbatas (pesan error tidak
// pernah jadi label).
func TestBrowserToolMetricsRecordAndExposition(t *testing.T) {
	m := NewMetrics()
	m.RecordBrowserTool("list_console_messages", 120*time.Millisecond, nil)
	m.RecordBrowserTool("list_console_messages", 40*time.Millisecond, nil)
	m.RecordBrowserTool("navigate_page", 1500*time.Millisecond, errors.New("browser: panggilan tool \"navigate_page\" gagal: timeout — detail rahasia?"))
	m.RecordBrowserTool("", 10*time.Millisecond, nil) // tool kosong → "unknown"

	if got := m.BrowserToolCallsTotal("list_console_messages", "success"); got != 2 {
		t.Fatalf("BrowserToolCallsTotal console success = %d, mau 2", got)
	}
	if got := m.BrowserToolCallsTotal("navigate_page", "error"); got != 1 {
		t.Fatalf("BrowserToolCallsTotal navigate error = %d, mau 1", got)
	}
	if got := m.BrowserToolCallsTotal("unknown", "success"); got != 1 {
		t.Fatalf("BrowserToolCallsTotal unknown success = %d, mau 1", got)
	}
	if got := m.BrowserToolCallsTotal("navigate_page", "success"); got != 0 {
		t.Fatalf("BrowserToolCallsTotal navigate success = %d, mau 0", got)
	}
	if got := m.BrowserToolDurationCount("list_console_messages"); got != 2 {
		t.Fatalf("BrowserToolDurationCount console = %d, mau 2", got)
	}
	if got := m.BrowserToolDurationSum("list_console_messages"); got < 0.159 || got > 0.161 {
		t.Fatalf("BrowserToolDurationSum console = %v, mau ~0.16", got)
	}

	var buf bytes.Buffer
	m.WritePrometheus(&buf)
	out := buf.String()
	for _, want := range []string{
		"# HELP browser_tool_calls_total Total browser tool calls by tool and status.",
		"# TYPE browser_tool_calls_total counter",
		`browser_tool_calls_total{tool="list_console_messages",status="success"} 2`,
		`browser_tool_calls_total{tool="navigate_page",status="error"} 1`,
		`browser_tool_calls_total{tool="unknown",status="success"} 1`,
		"# HELP browser_tool_calls_duration_seconds Duration of browser tool calls in seconds.",
		"# TYPE browser_tool_calls_duration_seconds histogram",
		// 120ms masuk bucket 0.25 (dan semua bucket di atasnya); 40ms
		// masuk bucket 0.05 — keduanya kumulatif.
		`browser_tool_calls_duration_seconds_bucket{tool="list_console_messages",le="0.05"} 1`,
		`browser_tool_calls_duration_seconds_bucket{tool="list_console_messages",le="0.25"} 2`,
		`browser_tool_calls_duration_seconds_bucket{tool="list_console_messages",le="+Inf"} 2`,
		`browser_tool_calls_duration_seconds_count{tool="list_console_messages"} 2`,
		// 1.5 dtk masuk bucket 2.5.
		`browser_tool_calls_duration_seconds_bucket{tool="navigate_page",le="2.5"} 1`,
		`browser_tool_calls_duration_seconds_bucket{tool="navigate_page",le="1"} 0`,
		// Bucket terakhir = CallTimeout (30 dtk).
		`browser_tool_calls_duration_seconds_bucket{tool="navigate_page",le="30"} 1`,
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("exposition tidak memuat %q\n--- output ---\n%s", want, out)
		}
	}
	// Pesan error TIDAK BOLEH bocor ke label mana pun.
	if strings.Contains(out, "rahasia") || strings.Contains(out, "timeout — detail") {
		t.Fatalf("pesan error tidak boleh muncul di exposition:\n%s", out)
	}
	// Urutan stabil: seri counter ter-sort (list_console_messages
	// sebelum navigate_page sebelum unknown).
	if i1, i2, i3 := strings.Index(out, `tool="list_console_messages"`), strings.Index(out, `tool="navigate_page"`), strings.Index(out, `tool="unknown"`); !(i1 < i2 && i2 < i3) {
		t.Fatalf("seri browser harus ter-sort, indeks %d %d %d\n%s", i1, i2, i3, out)
	}
	// Sum histogram memakai format angka Prometheus yang valid.
	if !strings.Contains(out, `browser_tool_calls_duration_seconds_sum{tool="list_console_messages"} 0.16`) {
		t.Fatalf("sum histogram console harus 0.16:\n%s", out)
	}
}

// Tanpa panggilan browser sama sekali, HELP/TYPE tetap muncul (tanpa
// seri) dan metrik HTTP lama tetap ada.
func TestBrowserToolMetricsEmptyExposition(t *testing.T) {
	m := NewMetrics()
	m.Record("GET", "/api/projects", 200)
	var buf bytes.Buffer
	m.WritePrometheus(&buf)
	out := buf.String()
	for _, want := range []string{
		"# TYPE browser_tool_calls_total counter",
		"# TYPE browser_tool_calls_duration_seconds histogram",
		`webbuilder_http_requests_total{method="GET",route="/api/projects",status="200"} 1`,
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("exposition kosong harus memuat %q\n--- output ---\n%s", want, out)
		}
	}
	if strings.Contains(out, "browser_tool_calls_total{") {
		t.Fatalf("tanpa panggilan browser tidak boleh ada seri counter:\n%s", out)
	}
}

// Logger JSON harus memuat request_id yang disuntikkan lewat context.
func TestLoggerWithRequestIDWritesJSON(t *testing.T) {
	var buf bytes.Buffer
	SetDefault(NewLogger(&buf, slog.LevelInfo))
	defer SetDefault(NewLogger(&bytes.Buffer{}, slog.LevelInfo))

	ctx := WithRequestID(context.Background(), "req-test-123")
	FromContext(ctx).Info("halo")
	out := buf.String()
	if !strings.Contains(out, `"request_id":"req-test-123"`) {
		t.Fatalf("log JSON harus memuat request_id, dapat: %s", out)
	}
	if !strings.Contains(out, `"msg":"halo"`) {
		t.Fatalf("log JSON harus memuat msg, dapat: %s", out)
	}
}

// Middleware logging + metrics di Gin: request_id merambat ke log dan
// metrik tercatat dengan template route.
func TestGinMiddlewareLoggingAndMetrics(t *testing.T) {
	var buf bytes.Buffer
	SetDefault(NewLogger(&buf, slog.LevelInfo))
	defer SetDefault(NewLogger(&bytes.Buffer{}, slog.LevelInfo))

	gin.SetMode(gin.TestMode)
	m := NewMetrics()
	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Set("webbuilder.request_id", "req-gin-456")
		c.Next()
	})
	r.Use(LoggingMiddleware(func(c *gin.Context) string {
		if v, ok := c.Get("webbuilder.request_id"); ok {
			if s, ok := v.(string); ok {
				return s
			}
		}
		return "req-unknown"
	}))
	r.Use(MetricsMiddleware(m))
	r.GET("/api/projects/:id", func(c *gin.Context) {
		LoggerFromGin(c).Info("di dalam handler")
		c.JSON(200, gin.H{"ok": true})
	})
	r.GET("/boom", func(c *gin.Context) { c.Status(500) })

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", "/api/projects/7", nil))
	if w.Code != 200 {
		t.Fatalf("status = %d, mau 200", w.Code)
	}
	logs := buf.String()
	if !strings.Contains(logs, `"request_id":"req-gin-456"`) {
		t.Fatalf("log middleware harus memuat request_id, dapat:\n%s", logs)
	}
	if !strings.Contains(logs, `"msg":"http_request"`) || !strings.Contains(logs, `"route":"/api/projects/:id"`) {
		t.Fatalf("log http_request harus memuat route template, dapat:\n%s", logs)
	}
	if !strings.Contains(logs, `"msg":"di dalam handler"`) {
		t.Fatalf("log dari handler harus memakai logger request-scoped, dapat:\n%s", logs)
	}
	if got := m.RequestsTotal("GET", "/api/projects/:id", 200); got != 1 {
		t.Fatalf("metrik route template = %d, mau 1", got)
	}

	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", "/boom", nil))
	if got := m.ErrorsTotal("GET", "/boom"); got != 1 {
		t.Fatalf("error counter /boom = %d, mau 1", got)
	}
	if got := m.InFlight(); got != 0 {
		t.Fatalf("in-flight setelah request selesai = %d, mau 0", got)
	}
}

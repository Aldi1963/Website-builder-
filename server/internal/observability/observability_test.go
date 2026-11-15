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

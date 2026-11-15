package handler

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"webbuilder/internal/browser"
	"webbuilder/internal/observability"

	"github.com/gin-gonic/gin"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

// Test wiring RegisterObservability end-to-end lewat HTTP nyata
// (httptest.Server = socket TCP sungguhan + SQLite in-memory): /healthz,
// /readyz (ping DB), /metrics, dan request_id merambat ke log slog JSON +
// metrik memakai template route.
func TestRegisterObservabilityEndpoints(t *testing.T) {
	var logBuf bytes.Buffer
	observability.SetDefault(observability.NewLogger(&logBuf, slog.LevelInfo))
	defer observability.SetDefault(observability.NewLogger(io.Discard, slog.LevelInfo))

	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatalf("buka sqlite in-memory: %v", err)
	}
	r := gin.New()
	r.Use(RequestContext())
	RegisterObservability(r, db)
	r.GET("/api/projects/:id", func(c *gin.Context) { c.JSON(200, gin.H{"ok": true}) })
	srv := httptest.NewServer(r)
	defer srv.Close()

	get := func(path string) (int, string, http.Header) {
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(body), resp.Header
	}

	code, body, hdr := get("/healthz")
	if code != 200 || !strings.Contains(body, `"status":"ok"`) {
		t.Fatalf("/healthz: status=%d body=%s", code, body)
	}
	if hdr.Get("X-Request-ID") == "" {
		t.Fatal("/healthz harus membawa header X-Request-ID")
	}

	code, body, _ = get("/readyz")
	if code != 200 || !strings.Contains(body, `"status":"ready"`) {
		t.Fatalf("/readyz: status=%d body=%s", code, body)
	}

	code, _, _ = get("/api/projects/7")
	if code != 200 {
		t.Fatalf("/api/projects/7: status=%d", code)
	}

	code, body, _ = get("/metrics")
	if code != 200 {
		t.Fatalf("/metrics: status=%d", code)
	}
	for _, want := range []string{
		`webbuilder_http_requests_total{method="GET",route="/api/projects/:id",status="200"} 1`,
		`webbuilder_http_requests_total{method="GET",route="/healthz",status="200"} 1`,
		// In-flight = 1 di sini karena request /metrics itu sendiri sedang
		// berjalan saat snapshot ditulis — perilaku yang benar.
		`webbuilder_http_requests_in_flight 1`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("/metrics tidak memuat %q\n--- body ---\n%s", want, body)
		}
	}

	// Log slog JSON dari middleware harus memuat request_id + route template.
	logs := logBuf.String()
	if !strings.Contains(logs, `"msg":"http_request"`) {
		t.Fatalf("log harus memuat http_request, dapat:\n%s", logs)
	}
	if !strings.Contains(logs, `"request_id":"req-`) {
		t.Fatalf("log harus memuat request_id req-..., dapat:\n%s", logs)
	}
	if !strings.Contains(logs, `"route":"/api/projects/:id"`) {
		t.Fatalf("log harus memuat route template, dapat:\n%s", logs)
	}
}

// TestRegisterObservabilityBrowserMetrics membuktikan wiring Fase 3
// item 2 end-to-end lewat HTTP nyata: RegisterObservability memasang
// observer default ke instance Metrics /metrics; browser Client yang
// dibuat SESUDAH itu (seperti yang dibuat pipeline lewat
// NewClientForRun) otomatis tercatat — satu CallTool nyata lewat server
// MCP palsu muncul sebagai seri browser di GET /metrics, dan metrik
// HTTP lama tetap ada.
func TestRegisterObservabilityBrowserMetrics(t *testing.T) {
	prev := browser.DefaultCallObserver()
	defer browser.SetDefaultCallObserver(prev)

	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatalf("buka sqlite in-memory: %v", err)
	}
	r := gin.New()
	r.Use(RequestContext())
	RegisterObservability(r, db)
	srv := httptest.NewServer(r)
	defer srv.Close()

	// Klien dibuat SESUDAH RegisterObservability → snapshot observer
	// default yang baru dipasang.
	ctx := context.Background()
	bc := fakeBrowserClient(t)
	if err := bc.Start(ctx); err != nil {
		t.Fatalf("Start browser palsu gagal: %v", err)
	}
	if _, err := bc.CallTool(ctx, "list_console_messages", map[string]interface{}{}); err != nil {
		t.Fatalf("CallTool gagal: %v", err)
	}

	resp, err := http.Get(srv.URL + "/metrics")
	if err != nil {
		t.Fatalf("GET /metrics: %v", err)
	}
	defer resp.Body.Close()
	bodyBytes, _ := io.ReadAll(resp.Body)
	body := string(bodyBytes)
	if resp.StatusCode != 200 {
		t.Fatalf("/metrics status = %d, mau 200", resp.StatusCode)
	}
	for _, want := range []string{
		`browser_tool_calls_total{tool="list_console_messages",status="success"} 1`,
		`browser_tool_calls_duration_seconds_count{tool="list_console_messages"} 1`,
		"# TYPE browser_tool_calls_total counter",
		"# TYPE browser_tool_calls_duration_seconds histogram",
		`webbuilder_http_requests_in_flight 1`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("/metrics tidak memuat %q\n--- body ---\n%s", want, body)
		}
	}
}

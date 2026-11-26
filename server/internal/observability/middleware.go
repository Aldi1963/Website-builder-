package observability

import (
	"time"

	"github.com/gin-gonic/gin"
)

// middleware.go — middleware Gin untuk logging terstruktur dan metrik.
//
// Urutan registrasi yang benar (lihat handler.RegisterObservability):
// RequestContext() dulu (membuat request_id), baru middleware di sini,
// supaya request_id sudah ada saat log pertama ditulis.

// loggerKey adalah kunci gin context tempat logger request-scoped disimpan.
const loggerKey = "webbuilder.logger"

// LoggingMiddleware mencatat setiap request selesai sebagai satu baris JSON
// (method, path, route template, status, durasi, request_id). Header, token,
// dan body TIDAK PERNAH dicatat — sama seperti aturan di RequestContext().
//
// requestID adalah fungsi pengambil ID korelasi dari gin context; handler
// mengoper handler.RequestID supaya paket ini tidak bergantung pada paket
// handler (menghindari import cycle).
func LoggingMiddleware(requestID func(*gin.Context) string) gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		id := ""
		if requestID != nil {
			id = requestID(c)
		}
		reqLog := FromContext(c.Request.Context()).With("request_id", id)
		// Simpan logger request-scoped: di context request (untuk kode yang
		// menerima ctx) dan di gin context (untuk handler yang menerima *gin.Context).
		c.Request = c.Request.WithContext(WithLogger(c.Request.Context(), reqLog))
		c.Set(loggerKey, reqLog)

		c.Next()

		route := c.FullPath()
		if route == "" {
			route = "unmatched"
		}
		reqLog.Info("http_request",
			"method", c.Request.Method,
			"path", c.Request.URL.Path,
			"route", route,
			"status", c.Writer.Status(),
			"duration_ms", time.Since(start).Milliseconds(),
		)
	}
}

// LoggerFromGin mengembalikan logger request-scoped yang disimpan
// LoggingMiddleware; bila middleware belum berjalan, mengembalikan logger
// global. Handler yang butuh log memakai ini supaya request_id ikut tercatat.
func LoggerFromGin(c *gin.Context) Logger {
	if v, ok := c.Get(loggerKey); ok {
		if l, ok := v.(Logger); ok && l != nil {
			return l
		}
	}
	return FromContext(c.Request.Context())
}

// MetricsMiddleware mencatat setiap request ke Metrics: menaikkan gauge
// in-flight selama request berjalan, lalu Record() dengan template route
// Gin (bukan path mentah) setelah request selesai.
func MetricsMiddleware(m *Metrics) gin.HandlerFunc {
	return func(c *gin.Context) {
		m.IncInFlight()
		defer m.DecInFlight()
		c.Next()
		route := c.FullPath()
		if route == "" {
			route = "unmatched"
		}
		m.Record(c.Request.Method, route, c.Writer.Status())
	}
}

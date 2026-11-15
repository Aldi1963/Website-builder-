package handler

import (
	"context"
	"time"

	"webbuilder/internal/observability"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// RegisterObservability memasang fondasi observability Trek C ke engine Gin:
//   - middleware logging terstruktur (slog JSON, membawa request_id dari
//     RequestContext),
//   - middleware metrik Prometheus,
//   - endpoint GET /healthz (liveness), GET /readyz (readiness + ping DB),
//     GET /metrics (format Prometheus).
//
// Urutan penting: dipanggil SETELAH r.Use(RequestContext()) supaya request_id
// sudah ada saat middleware logging berjalan. Satu-satunya call site adalah
// RegisterRoutes (auth.go).
//
// Endpoint baru ini adalah PENAMBAHAN; tidak ada endpoint/API lama yang
// diubah. /metrics dan /healthz tidak butuh auth (server hanya listen di
// 127.0.0.1); bila server suatu saat di-expose ke publik, /metrics harus
// diberi gate (lihat docs/observability.md).
func RegisterObservability(r *gin.Engine, db *gorm.DB) {
	metrics := observability.NewMetrics()
	r.Use(observability.LoggingMiddleware(RequestID))
	r.Use(observability.MetricsMiddleware(metrics))
	r.GET("/healthz", gin.WrapF(observability.LivenessHandler()))
	r.GET("/readyz", gin.WrapF(observability.ReadinessHandler(map[string]observability.PingFunc{
		"database": gormPing(db),
	})))
	r.GET("/metrics", gin.WrapF(observability.MetricsHandler(metrics)))
}

// gormPing mengadaptasi *gorm.DB menjadi PingFunc untuk readiness: mengambil
// *sql.DB di bawah GORM lalu Ping dengan context (timeout diatur handler
// readiness, 2 detik).
func gormPing(db *gorm.DB) observability.PingFunc {
	return func(ctx context.Context) error {
		sqldb, err := db.DB()
		if err != nil {
			return err
		}
		ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
		defer cancel()
		return sqldb.PingContext(ctx)
	}
}

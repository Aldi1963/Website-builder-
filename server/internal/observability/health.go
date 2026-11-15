package observability

import (
	"context"
	"encoding/json"
	"net/http"
	"time"
)

// health.go — endpoint liveness, readiness, dan metrics sebagai
// http.HandlerFunc standar (tanpa dependensi Gin) supaya mudah dipakai dari
// handler Gin (gin.WrapF) maupun dari test net/http biasa.

// LivenessHandler menjawab 200 selama proses hidup. Tidak menyentuh DB atau
// dependensi lain — liveness yang bergantung pada DB akan membuat orchestrator
// me-restart proses yang sebenarnya sehat.
func LivenessHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	}
}

// PingFunc adalah fungsi cek dependensi untuk readiness (mis. ping DB).
type PingFunc func(ctx context.Context) error

// ReadinessHandler menjawab 200 bila semua ping berhasil, 503 bila ada yang
// gagal. Detail error TIDAK dikembalikan ke klien (hanya nama check yang
// gagal) supaya tidak membocorkan info internal; detailnya dicatat lewat
// logger dari context.
func ReadinessHandler(pings map[string]PingFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		for name, ping := range pings {
			if ping == nil {
				continue
			}
			if err := ping(ctx); err != nil {
				FromContext(ctx).Warn("readiness check failed", "check", name, "error", err.Error())
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{
					"status": "not_ready",
					"check":  name,
				})
				return
			}
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
	}
}

// MetricsHandler menulis snapshot Metrics dalam format Prometheus.
func MetricsHandler(m *Metrics) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		m.WritePrometheus(w)
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// Package observability menyediakan fondasi observability WebBuilder:
// structured logging (log/slog, JSON), metrik Prometheus format teks
// (tanpa client library tambahan), dan endpoint health.
//
// Yang disediakan paket ini:
//   - Logger JSON berbasis slog + helper logger dari context (request_id
//     merambat lewat context, lihat logger.go).
//   - Metrics: counter request total + error total per method/route, dan
//     gauge in-flight. Diekspos sebagai teks Prometheus di /metrics.
//   - Handler liveness (/healthz) dan readiness (/readyz, termasuk ping DB).
//
// Yang SENGAJA tidak ada di sini: OpenTelemetry (traces/metrics/OTLP).
// OTEL didokumentasikan sebagai langkah berikut di docs/observability.md —
// jangan menganggap paket ini sudah mengirim trace ke mana pun.
package observability

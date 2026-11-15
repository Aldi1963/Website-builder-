# Observability (Trek C — Item 6)

Fondasi observability WebBuilder: structured logging, metrik Prometheus,
dan endpoint health. Semua memakai **stdlib + dependensi yang sudah ada**
(`log/slog` adalah stdlib; format Prometheus ditulis tangan sebagai teks —
tidak ada client library baru).

## Structured logging (log/slog, JSON)

Paket `server/internal/observability/` menyediakan logger JSON:

```go
observability.NewLogger(os.Stdout, slog.LevelInfo) // JSON handler
observability.SetDefault(l)                        // logger global
observability.FromContext(ctx)                     // logger dari context
observability.WithRequestID(ctx, id)               // ctx + request_id
```

Aturan log (sama seperti `RequestContext` yang sudah ada):

- Setiap baris log adalah satu objek JSON: `time`, `level`, `msg`, plus
  field terstruktur (`request_id`, `method`, `path`, `route`, `status`,
  `duration_ms`).
- **Header, token, dan body TIDAK PERNAH dicatat.**

### Request ID merambat ke log

`RequestContext()` (sudah ada, `handler/requestid.go`) membuat
`request_id` dan menyimpannya di gin context + header `X-Request-ID`.
`LoggingMiddleware` (dipasang setelahnya oleh `RegisterObservability`)
membaca ID itu lewat `handler.RequestID`, membuat logger request-scoped
(`logger.With("request_id", id)`), dan menyimpannya di:

- `c.Request.Context()` — untuk kode yang menerima `ctx`, pakai
  `observability.FromContext(ctx)`;
- gin context — untuk handler, pakai `observability.LoggerFromGin(c)`.

Contoh baris log satu request:

```json
{"time":"2026-11-15T04:13:48Z","level":"INFO","msg":"http_request","request_id":"req-92a99c2b20771de65af0f3f9","method":"GET","path":"/api/projects/7","route":"/api/projects/:id","status":200,"duration_ms":3}
```

Catatan: `RequestContext()` masih menulis satu baris `log.Printf` lama
per request, dan `gin.Default()` masih memakai gin Logger teks. Jadi untuk
sementara ada tiga baris log per request (gin teks + `log.Printf` +
slog JSON). Setelah wiring main.go diterapkan (di bawah), koordinator bisa
menghapus `log.Printf` di `requestid.go` dan mengganti `gin.Default()`
dengan `gin.New()` + `gin.Recovery()` — keduanya di luar partisi trek ini,
jadi tidak dilakukan di sini.

## Endpoint baru (penambahan, bukan perubahan)

Semua dipasang oleh `handler.RegisterObservability(r, db)` — satu baris di
`RegisterRoutes` (lihat "Wiring" di bawah). Tidak ada endpoint/API lama
yang diubah.

| Endpoint | Keterangan |
| -------- | ---------- |
| `GET /healthz` | Liveness: `{"status":"ok"}` selama proses hidup. Tidak menyentuh DB — liveness yang bergantung DB akan me-restart proses yang sebenarnya sehat. |
| `GET /readyz` | Readiness: `{"status":"ready"}` bila ping DB berhasil, `503 {"status":"not_ready","check":"database"}` bila gagal. Detail error dicatat di log (WARN), **tidak** dikembalikan ke klien. Timeout ping 2 dtk. |
| `GET /metrics` | Metrik format Prometheus (`text/plain; version=0.0.4`). Tanpa auth — aman karena server hanya listen di `127.0.0.1:18082`; bila server suatu saat di-expose ke publik, beri gate (auth/IP allowlist) sebelum membuka port. |

## Metrik

Ditulis tangan di `observability.Metrics` (in-memory, mutex-protected):

```
# HELP webbuilder_http_requests_total Total HTTP requests.
# TYPE webbuilder_http_requests_total counter
webbuilder_http_requests_total{method="GET",route="/api/projects/:id",status="200"} 12
# HELP webbuilder_http_errors_total Total HTTP 5xx responses.
# TYPE webbuilder_http_errors_total counter
webbuilder_http_errors_total{method="POST",route="/api/projects",status="500"} 1
# HELP webbuilder_http_requests_in_flight In-flight HTTP requests.
# TYPE webbuilder_http_requests_in_flight gauge
webbuilder_http_requests_in_flight 3
```

- Label `route` memakai **template route Gin** (`/api/projects/:id`),
  bukan path mentah — supaya kardinalitas label tidak meledak oleh ID.
  Request yang tidak cocok route mana pun tercatat sebagai
  `route="unmatched"`.
- `errors_total` hanya menghitung status `>= 500`.
- Gauge `in_flight` dihitung selama request berjalan; saat membaca
  `/metrics`, nilainya minimal 1 karena request `/metrics` itu sendiri
  sedang berjalan — itu perilaku yang benar, bukan kebocoran.

## Wiring (untuk koordinator — main.go)

`main.go` **tidak** disentuh trek ini. Snippet yang harus diterapkan
koordinator, disisipkan di `server/main.go` (state saat ini memakai
`database.Open()` dari trek database; anchor `r := gin.Default()` dan
`handler.RegisterRoutes(r, db)` masih ada):

```go
import (
	"log/slog"
	// ... import yang sudah ada ...
	"webbuilder/internal/observability"
)

func main() {
	// Structured logging (Trek C): semua log aplikasi menjadi JSON via slog.
	// Baris log.Fatal di main.go tetap memakai log standar (startup saja).
	observability.SetDefault(observability.NewLogger(os.Stdout, slog.LevelInfo))
	slog.SetDefault(observability.Default())

	// ... kode yang sudah ada (JWT_SECRET, database.Open, Migrate) ...

	// Opsional, bila ingin menghilangkan log teks ganda per request:
	// ganti gin.Default() dengan gin.New() + gin.Recovery(). Middleware
	// logging slog sudah dipasang di handler.RegisterObservability.
	r := gin.Default()
	handler.RegisterRoutes(r, db)
	// ... sisanya tidak berubah ...
}
```

`RegisterObservability` sendiri sudah dipanggil dari `RegisterRoutes`
(satu baris yang diizinkan trek ini):

```go
r.Use(RequestContext())
RegisterObservability(r, db)   // <-- trek C, setelah RequestContext
```

## Verifikasi

```bash
cd server
go test ./internal/observability/ -v -count=1   # logger, metrik, health
go test ./internal/handler/ -run 'TestRegisterObservability|TestRequestContext' -v -count=1
```

Test wiring (`handler/observability_test.go`) memakai SQLite in-memory
dan membuktikan end-to-end lewat Gin: `/healthz` 200 +
header `X-Request-ID`, `/readyz` 200 saat DB hidup, `/metrics` memuat
counter dengan template route (`route="/api/projects/:id"`).

## Langkah berikut: OpenTelemetry (belum diimplementasikan)

Yang ada sekarang — log JSON + metrik Prometheus + health — cukup untuk
operasi single-host. OpenTelemetry **sengaja tidak diimplementasikan** di
trek ini; berikut peta jalannya yang jujur:

1. **Traces**: tambahkan `go.opentelemetry.io/otel` + `otelgin` dan
   pasang sebagai middleware setelah `RequestContext`, dengan propagator
   W3C TraceContext. `request_id` yang sudah ada bisa dipetakan ke
   `trace_id`/`span` attribute, atau diganti sepenuhnya oleh trace ID
   OTEL (keputusan: samakan `X-Request-ID` dengan trace ID supaya
   korelasi log↔trace gratis).
2. **Metrics via OTEL**: ganti `observability.Metrics` in-memory dengan
   Meter OTEL + exporter Prometheus, supaya histogram durasi
   (`http.server.request.duration`) tersedia — saat ini durasi hanya ada
   di log, bukan di metrik.
3. **Exporter/Collector**: jalankan OTEL Collector sebagai sidecar dan
   kirim ke backend (Jaeger/Tempo untuk trace, Prometheus untuk metrik,
   Loki untuk log). Tanpa collector, menambah SDK OTEL hanya menambah
   dependensi tanpa tempat tujuan.
4. **Sampling**: untuk traffic produksi, aktifkan sampling (mis. 10% +
   100% untuk error) supaya volume trace tidak membanjiri collector.

Urutan yang disarankan: (1) Collector + Prometheus scraping `/metrics`
yang sudah ada → (2) OTEL traces → (3) migrasi metrik ke OTEL Meter.
Jangan mulai dari (3): `/metrics` yang sudah ada sudah bisa di-scrape
hari ini tanpa dependensi baru.

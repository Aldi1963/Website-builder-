package observability

import (
	"fmt"
	"io"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
)

// metrics.go — metrik in-memory format Prometheus (ditulis tangan, tanpa
// client library). Sengaja minimal: counter request total + error total per
// method/route, dan gauge in-flight.
//
// Label route memakai template route Gin (mis. "/api/projects/:id"), BUKAN
// path mentah, supaya kardinalitas label tetap kecil (path mentah berisi ID
// yang tak terbatas jumlahnya).

// Metrics menyimpan counter request/error dan gauge in-flight.
type Metrics struct {
	mu       sync.Mutex
	requests map[string]uint64 // key: method\x00route\x00status
	errors   map[string]uint64 // key: method\x00route (hanya status >= 500)
	inFlight atomic.Int64
}

// NewMetrics membuat Metrics kosong.
func NewMetrics() *Metrics {
	return &Metrics{
		requests: map[string]uint64{},
		errors:   map[string]uint64{},
	}
}

// IncInFlight menaikkan gauge request yang sedang berjalan; DecInFlight
// menurunkannya. Middleware memanggil keduanya di awal/akhir request.
func (m *Metrics) IncInFlight() { m.inFlight.Add(1) }
func (m *Metrics) DecInFlight() { m.inFlight.Add(-1) }

// InFlight mengembalikan jumlah request yang sedang berjalan saat ini.
func (m *Metrics) InFlight() int64 { return m.inFlight.Load() }

// Record mencatat satu request selesai. status adalah kode HTTP.
// Status >= 500 ikut dihitung sebagai error.
func (m *Metrics) Record(method, route string, status int) {
	if method == "" {
		method = "unknown"
	}
	if route == "" {
		route = "unmatched"
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.requests[fmt.Sprintf("%s\x00%s\x00%d", method, route, status)]++
	if status >= 500 {
		m.errors[fmt.Sprintf("%s\x00%s", method, route)]++
	}
}

// RequestsTotal mengembalikan total request tercatat untuk kombinasi
// method/route/status (dipakai test).
func (m *Metrics) RequestsTotal(method, route string, status int) uint64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.requests[fmt.Sprintf("%s\x00%s\x00%d", method, route, status)]
}

// ErrorsTotal mengembalikan total error (5xx) untuk method/route.
func (m *Metrics) ErrorsTotal(method, route string) uint64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.errors[fmt.Sprintf("%s\x00%s", method, route)]
}

// escapeLabel meng-escape nilai label sesuai format exposition Prometheus.
func escapeLabel(s string) string {
	r := strings.NewReplacer("\\", `\\`, "\n", `\n`, `"`, `\"`)
	return r.Replace(s)
}

// WritePrometheus menulis snapshot metrik dalam format exposition Prometheus
// (text/plain; version=0.0.4). Urutan baris di-sort supaya output stabil
// dan mudah di-diff di test.
func (m *Metrics) WritePrometheus(w io.Writer) {
	m.mu.Lock()
	reqKeys := make([]string, 0, len(m.requests))
	for k := range m.requests {
		reqKeys = append(reqKeys, k)
	}
	errKeys := make([]string, 0, len(m.errors))
	for k := range m.errors {
		errKeys = append(errKeys, k)
	}
	sort.Strings(reqKeys)
	sort.Strings(errKeys)
	reqCopy := make(map[string]uint64, len(m.requests))
	for k, v := range m.requests {
		reqCopy[k] = v
	}
	errCopy := make(map[string]uint64, len(m.errors))
	for k, v := range m.errors {
		errCopy[k] = v
	}
	inFlight := m.inFlight.Load()
	m.mu.Unlock()

	fmt.Fprintln(w, "# HELP webbuilder_http_requests_total Total HTTP requests.")
	fmt.Fprintln(w, "# TYPE webbuilder_http_requests_total counter")
	for _, k := range reqKeys {
		parts := strings.Split(k, "\x00")
		fmt.Fprintf(w, "webbuilder_http_requests_total{method=%q,route=%q,status=%q} %d\n",
			escapeLabel(parts[0]), escapeLabel(parts[1]), escapeLabel(parts[2]), reqCopy[k])
	}
	fmt.Fprintln(w, "# HELP webbuilder_http_errors_total Total HTTP 5xx responses.")
	fmt.Fprintln(w, "# TYPE webbuilder_http_errors_total counter")
	for _, k := range errKeys {
		parts := strings.Split(k, "\x00")
		fmt.Fprintf(w, "webbuilder_http_errors_total{method=%q,route=%q} %d\n",
			escapeLabel(parts[0]), escapeLabel(parts[1]), errCopy[k])
	}
	fmt.Fprintln(w, "# HELP webbuilder_http_requests_in_flight In-flight HTTP requests.")
	fmt.Fprintln(w, "# TYPE webbuilder_http_requests_in_flight gauge")
	fmt.Fprintf(w, "webbuilder_http_requests_in_flight %d\n", inFlight)
}

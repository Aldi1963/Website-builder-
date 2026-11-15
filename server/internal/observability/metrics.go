package observability

import (
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// metrics.go — metrik in-memory format Prometheus (ditulis tangan, tanpa
// client library). Sengaja minimal: counter request total + error total per
// method/route, gauge in-flight, plus metrik panggilan tool browser
// (counter per tool/status + histogram durasi, rencana §6 Fase 3 item 2).
//
// Label route memakai template route Gin (mis. "/api/projects/:id"), BUKAN
// path mentah, supaya kardinalitas label tetap kecil (path mentah berisi ID
// yang tak terbatas jumlahnya).

// BrowserDurationBuckets adalah bucket histogram durasi panggilan tool
// browser (detik). Rentang 0–30 dtk mengikuti CallTimeout browser
// (30 dtk); bucket rapat di bawah 1 dtk karena panggilan baca (console,
// snapshot) umumnya selesai jauh di bawah batas.
var BrowserDurationBuckets = []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30}

// browserDuration adalah histogram durasi untuk satu tool browser.
type browserDuration struct {
	buckets []uint64 // per bucket di BrowserDurationBuckets (kumulatif)
	sum     float64  // total detik
	count   uint64
}

// Metrics menyimpan counter request/error dan gauge in-flight, plus
// metrik panggilan tool browser (counter per tool/status + histogram
// durasi per tool).
type Metrics struct {
	mu       sync.Mutex
	requests map[string]uint64 // key: method\x00route\x00status
	errors   map[string]uint64 // key: method\x00route (hanya status >= 500)
	// browserCalls key: tool\x00status ("success"/"error"). Label tool
	// sudah dinormalisasi pemanggil (nama di luar allowlist → "unknown")
	// dan pesan error TIDAK PERNAH jadi label, supaya kardinalitas
	// tetap terbatas.
	browserCalls     map[string]uint64
	browserDurations map[string]*browserDuration // key: tool
	inFlight         atomic.Int64
}

// NewMetrics membuat Metrics kosong.
func NewMetrics() *Metrics {
	return &Metrics{
		requests:         map[string]uint64{},
		errors:           map[string]uint64{},
		browserCalls:     map[string]uint64{},
		browserDurations: map[string]*browserDuration{},
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

// RecordBrowserTool mencatat satu panggilan tool browser selesai. status
// hanya "success" (err == nil) atau "error" — pesan error tidak dicatat
// sebagai label. tool kosong dinormalisasi ke "unknown"; normalisasi
// nama di luar allowlist menjadi "unknown" dilakukan pemanggil (observer
// di paket browser) supaya kardinalitas label tetap terbatas.
func (m *Metrics) RecordBrowserTool(tool string, duration time.Duration, err error) {
	if tool == "" {
		tool = "unknown"
	}
	status := "success"
	if err != nil {
		status = "error"
	}
	secs := duration.Seconds()
	if secs < 0 {
		secs = 0
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.browserCalls[fmt.Sprintf("%s\x00%s", tool, status)]++
	h := m.browserDurations[tool]
	if h == nil {
		h = &browserDuration{buckets: make([]uint64, len(BrowserDurationBuckets))}
		m.browserDurations[tool] = h
	}
	for i, bound := range BrowserDurationBuckets {
		if secs <= bound {
			h.buckets[i]++
		}
	}
	h.sum += secs
	h.count++
}

// BrowserToolCallsTotal mengembalikan total panggilan tool browser untuk
// kombinasi tool/status (dipakai test).
func (m *Metrics) BrowserToolCallsTotal(tool, status string) uint64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.browserCalls[fmt.Sprintf("%s\x00%s", tool, status)]
}

// BrowserToolDurationCount mengembalikan jumlah observasi durasi untuk
// satu tool browser (dipakai test).
func (m *Metrics) BrowserToolDurationCount(tool string) uint64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	if h := m.browserDurations[tool]; h != nil {
		return h.count
	}
	return 0
}

// BrowserToolDurationSum mengembalikan total durasi (detik) untuk satu
// tool browser (dipakai test).
func (m *Metrics) BrowserToolDurationSum(tool string) float64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	if h := m.browserDurations[tool]; h != nil {
		return h.sum
	}
	return 0
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
	browserCallKeys := make([]string, 0, len(m.browserCalls))
	for k := range m.browserCalls {
		browserCallKeys = append(browserCallKeys, k)
	}
	sort.Strings(browserCallKeys)
	browserCallCopy := make(map[string]uint64, len(m.browserCalls))
	for k, v := range m.browserCalls {
		browserCallCopy[k] = v
	}
	browserDurTools := make([]string, 0, len(m.browserDurations))
	for tool := range m.browserDurations {
		browserDurTools = append(browserDurTools, tool)
	}
	sort.Strings(browserDurTools)
	browserDurCopy := make(map[string]*browserDuration, len(m.browserDurations))
	for tool, h := range m.browserDurations {
		cp := &browserDuration{
			buckets: append([]uint64(nil), h.buckets...),
			sum:     h.sum,
			count:   h.count,
		}
		browserDurCopy[tool] = cp
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
	fmt.Fprintln(w, "# HELP browser_tool_calls_total Total browser tool calls by tool and status.")
	fmt.Fprintln(w, "# TYPE browser_tool_calls_total counter")
	for _, k := range browserCallKeys {
		parts := strings.Split(k, "\x00")
		fmt.Fprintf(w, "browser_tool_calls_total{tool=%q,status=%q} %d\n",
			escapeLabel(parts[0]), escapeLabel(parts[1]), browserCallCopy[k])
	}
	fmt.Fprintln(w, "# HELP browser_tool_calls_duration_seconds Duration of browser tool calls in seconds.")
	fmt.Fprintln(w, "# TYPE browser_tool_calls_duration_seconds histogram")
	for _, tool := range browserDurTools {
		h := browserDurCopy[tool]
		for i, bound := range BrowserDurationBuckets {
			fmt.Fprintf(w, "browser_tool_calls_duration_seconds_bucket{tool=%q,le=%q} %d\n",
				escapeLabel(tool), strconv.FormatFloat(bound, 'g', -1, 64), h.buckets[i])
		}
		fmt.Fprintf(w, "browser_tool_calls_duration_seconds_bucket{tool=%q,le=%q} %d\n",
			escapeLabel(tool), "+Inf", h.count)
		fmt.Fprintf(w, "browser_tool_calls_duration_seconds_sum{tool=%q} %s\n",
			escapeLabel(tool), strconv.FormatFloat(h.sum, 'g', -1, 64))
		fmt.Fprintf(w, "browser_tool_calls_duration_seconds_count{tool=%q} %d\n",
			escapeLabel(tool), h.count)
	}
}

package browser

// Sapu uji alat MCP yang belum teruji (trek C): lighthouse_audit,
// performance_start_trace / performance_stop_trace /
// performance_analyze_insight, emulate, resize_page — masing-masing
// terhadap Chrome for Testing ASLI + server MCP
// chrome-devtools-mcp@1.13.0 (pola input_tools_integration_test.go:
// satu Client per subtest, fixture httptest lokal, tanpa kunci AI).
//
// Alat input satuan (press_key, click, fill) TIDAK diulang di sini:
// sudah dibuktikan satu per satu di TestInputToolsRealChrome
// (FillPressKeyEnterWaitFor, PressKeyControlA, LoginFillFormClick);
// trek ini mengujinya lagi lewat jalur LLM-driven (lihat laporan PR).
import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"
)

// sweepFixtureServer adalah fixture khusus sapu: "/" halaman sederhana
// + "/berat" (halaman lambat yang sengaja memicu insight performance:
// CSS render-blocking lambat 800 ms + script pemblokir ~200 ms,
// supaya ringkasan trace memuat minimal satu insight gagal untuk
// performance_analyze_insight).
func sweepFixtureServer(t *testing.T) *httptest.Server {
	t.Helper()
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		switch r.URL.Path {
		case "/":
			fmt.Fprint(w, `<!doctype html><html><head><title>sapu fixture</title></head><body>
<h1>Halaman Sapu</h1><p>Paragraf sapu.</p>
</body></html>`)
		case "/berat":
			fmt.Fprint(w, `<!doctype html><html><head><title>berat fixture</title>
<link rel="stylesheet" href="/lambat.css">
</head><body>
<h1>Halaman Berat</h1><p>Paragraf berat untuk LCP.</p>
<script>var t0=Date.now(); while(Date.now()-t0<200){}</script>
</body></html>`)
		case "/lambat.css":
			// CSS render-blocking yang sengaja lambat.
			time.Sleep(800 * time.Millisecond)
			w.Header().Set("Content-Type", "text/css")
			fmt.Fprint(w, `h1{color:#111} p{font-size:16px}`)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(ts.Close)
	return ts
}

var (
	insightSetIDRe = regexp.MustCompile(`(?m)^## insight set id: (\S+)`)
	insightNameRe  = regexp.MustCompile(`(?m)insight name: ([A-Za-z]+)`)
)

// firstInsightSet memetik id insight set + nama insight pertama dari
// ringkasan trace (format formatter server MCP 1.13.0, lihat
// PerformanceTraceFormatter di paket chrome-devtools-mcp). Bila ada,
// RenderBlocking dipilih (detailnya selalu menyebut "render-blocking",
// jadi asersi bisa dinormalisasi) — bila tidak, insight pertama.
func firstInsightSet(t *testing.T, traceOut string) (string, string) {
	t.Helper()
	setID := ""
	if m := insightSetIDRe.FindStringSubmatch(traceOut); m != nil {
		setID = m[1]
	}
	names := []string{}
	for _, m := range insightNameRe.FindAllStringSubmatch(traceOut, -1) {
		names = append(names, m[1])
	}
	name := ""
	for _, n := range names {
		if n == "RenderBlocking" {
			name = n
			break
		}
	}
	if name == "" && len(names) > 0 {
		name = names[0]
	}
	if setID == "" || name == "" {
		t.Fatalf("ringkasan trace harus memuat insight set id + nama insight (set=%q insight=%q), output penuh:\n%s", setID, name, traceOut)
	}
	return setID, name
}

// normInsight menormalisasi nama insight + teks detail supaya
// "RenderBlocking" cocok dengan "render-blocking" di teks detail.
func normInsight(s string) string {
	s = strings.ToLower(s)
	s = strings.ReplaceAll(s, "-", "")
	s = strings.ReplaceAll(s, " ", "")
	return s
}

func TestToolsSweepRealChrome(t *testing.T) {
	ts := sweepFixtureServer(t)
	ctx := context.Background()

	// lighthouse_audit mode snapshot: tanpa reload, skor kategori
	// (accessibility/seo/best-practices/agentic-browsing) harus ada.
	t.Run("LighthouseSnapshot", func(t *testing.T) {
		c := newInputClient(t, ts.URL)
		if _, err := c.CallTool(ctx, "navigate_page", map[string]any{"url": ts.URL + "/"}); err != nil {
			t.Fatalf("navigate_page gagal: %v", err)
		}
		out, err := c.CallTool(ctx, "lighthouse_audit", map[string]any{
			"mode": "snapshot", "device": "desktop",
		})
		if err != nil {
			t.Fatalf("lighthouse_audit snapshot gagal: %v", err)
		}
		t.Logf("lighthouse snapshot (dipotong 2000 karakter):\n%s", firstN(out, 2000))
		for _, want := range []string{"accessibility", "seo", "best-practices", "scores"} {
			if !strings.Contains(out, want) {
				t.Fatalf("hasil lighthouse snapshot harus memuat %q, dapat:\n%s", want, firstN(out, 2000))
			}
		}
	})

	// lighthouse_audit mode navigation (reload + audit) perangkat
	// mobile: skor harus ada + URL final = halaman fixture.
	t.Run("LighthouseNavigationMobile", func(t *testing.T) {
		c := newInputClient(t, ts.URL)
		if _, err := c.CallTool(ctx, "navigate_page", map[string]any{"url": ts.URL + "/"}); err != nil {
			t.Fatalf("navigate_page gagal: %v", err)
		}
		out, err := c.CallTool(ctx, "lighthouse_audit", map[string]any{
			"mode": "navigation", "device": "mobile",
		})
		if err != nil {
			t.Fatalf("lighthouse_audit navigation gagal: %v", err)
		}
		t.Logf("lighthouse navigation mobile (dipotong 2000 karakter):\n%s", firstN(out, 2000))
		for _, want := range []string{"accessibility", "scores", ts.URL} {
			if !strings.Contains(out, want) {
				t.Fatalf("hasil lighthouse navigation harus memuat %q, dapat:\n%s", want, firstN(out, 2000))
			}
		}
	})

	// performance_start_trace (autoStop) di halaman berat → ringkasan
	// trace memuat insight set; performance_analyze_insight dengan id
	// + nama dari ringkasan itu mengembalikan detail insight.
	// reload HARUS true: dengan reload:false trace tidak memuat
	// navigasi (insight set id NO_NAVIGATION, daftar insight kosong)
	// sehingga analyze_insight tidak punya insight untuk dianalisis.
	t.Run("PerformanceTraceDanAnalyzeInsight", func(t *testing.T) {
		c := newInputClient(t, ts.URL)
		if _, err := c.CallTool(ctx, "navigate_page", map[string]any{"url": ts.URL + "/berat"}); err != nil {
			t.Fatalf("navigate_page gagal: %v", err)
		}
		traceOut, err := c.CallTool(ctx, "performance_start_trace", map[string]any{
			"reload": true, "autoStop": true,
		})
		if err != nil {
			t.Fatalf("performance_start_trace gagal: %v", err)
		}
		t.Logf("ringkasan trace:\n%s", traceOut)
		if !strings.Contains(traceOut, "performance trace has been stopped") {
			t.Fatalf("trace autoStop harus berhenti sendiri, dapat:\n%s", traceOut)
		}
		if !strings.Contains(traceOut, "Available insight sets") {
			t.Fatalf("ringkasan trace harus memuat daftar insight set, dapat:\n%s", traceOut)
		}
		setID, insightName := firstInsightSet(t, traceOut)
		t.Logf("insight set id=%s insight=%s", setID, insightName)
		detail, err := c.CallTool(ctx, "performance_analyze_insight", map[string]any{
			"insightSetId": setID, "insightName": insightName,
		})
		if err != nil {
			t.Fatalf("performance_analyze_insight gagal: %v", err)
		}
		t.Logf("detail insight (dipotong 2000 karakter):\n%s", firstN(detail, 2000))
		if !strings.Contains(normInsight(detail), normInsight(insightName)) {
			t.Fatalf("detail insight harus menyebut %q, dapat:\n%s", insightName, firstN(detail, 2000))
		}
	})

	// performance_start_trace manual (autoStop=false) → stop lewat
	// performance_stop_trace; stop kedua tanpa trace aktif
	// mengembalikan pesan error ramah (bukan crash).
	t.Run("PerformanceStopTraceManual", func(t *testing.T) {
		c := newInputClient(t, ts.URL)
		if _, err := c.CallTool(ctx, "navigate_page", map[string]any{"url": ts.URL + "/"}); err != nil {
			t.Fatalf("navigate_page gagal: %v", err)
		}
		startOut, err := c.CallTool(ctx, "performance_start_trace", map[string]any{
			"reload": false, "autoStop": false,
		})
		if err != nil {
			t.Fatalf("performance_start_trace manual gagal: %v", err)
		}
		if !strings.Contains(startOut, "being recorded") {
			t.Fatalf("trace manual harus mulai merekam, dapat: %q", startOut)
		}
		time.Sleep(2 * time.Second)
		stopOut, err := c.CallTool(ctx, "performance_stop_trace", map[string]any{})
		if err != nil {
			t.Fatalf("performance_stop_trace gagal: %v", err)
		}
		t.Logf("stop trace manual:\n%s", firstN(stopOut, 2000))
		if !strings.Contains(stopOut, "performance trace has been stopped") {
			t.Fatalf("stop trace harus menghentikan rekaman, dapat:\n%s", firstN(stopOut, 2000))
		}
		againOut, err := c.CallTool(ctx, "performance_stop_trace", map[string]any{})
		if err != nil {
			t.Fatalf("stop trace kedua harus mengembalikan pesan ramah (bukan error transport), dapat error: %v", err)
		}
		if !strings.Contains(againOut, "no active performance trace") {
			t.Fatalf("stop trace tanpa trace aktif harus menyebut tidak ada trace aktif, dapat: %q", againOut)
		}
	})

	// emulate: satu panggilan berisi colorScheme + viewport +
	// userAgent + cpuThrottlingRate + networkConditions — efeknya
	// diverifikasi dari dalam halaman lewat evaluate_script.
	t.Run("Emulate", func(t *testing.T) {
		c := newInputClient(t, ts.URL)
		if _, err := c.CallTool(ctx, "navigate_page", map[string]any{"url": ts.URL + "/"}); err != nil {
			t.Fatalf("navigate_page gagal: %v", err)
		}
		out, err := c.CallTool(ctx, "emulate", map[string]any{
			"colorScheme":       "dark",
			"viewport":          "800x600x1",
			"userAgent":         "WebBuilderSweep/1.0",
			"cpuThrottlingRate": 4,
			"networkConditions": "Slow 4G",
			"geolocation":       "-6.2,106.8",
		})
		if err != nil {
			t.Fatalf("emulate gagal: %v", err)
		}
		if !strings.Contains(out, "Emulation configured successfully") {
			t.Fatalf("emulate harus sukses, dapat: %q", out)
		}
		evalOut, err := c.CallTool(ctx, "evaluate_script", map[string]any{
			"function": `() => [window.innerWidth, window.innerHeight, matchMedia('(prefers-color-scheme: dark)').matches, navigator.userAgent.includes('WebBuilderSweep/1.0')].join('|')`,
		})
		if err != nil {
			t.Fatalf("evaluate_script sesudah emulate gagal: %v", err)
		}
		t.Logf("state halaman sesudah emulate: %s", evalOut)
		if !strings.Contains(evalOut, "800|600|true|true") {
			t.Fatalf("emulate harus mengubah viewport 800x600 + dark mode + userAgent, dapat: %q", evalOut)
		}
	})

	// resize_page: ubah ukuran jendela dua kali, innerWidth/
	// innerHeight halaman harus mengikuti.
	t.Run("ResizePage", func(t *testing.T) {
		c := newInputClient(t, ts.URL)
		if _, err := c.CallTool(ctx, "navigate_page", map[string]any{"url": ts.URL + "/"}); err != nil {
			t.Fatalf("navigate_page gagal: %v", err)
		}
		for _, size := range [][2]int{{1024, 768}, {640, 480}} {
			if _, err := c.CallTool(ctx, "resize_page", map[string]any{
				"width": size[0], "height": size[1],
			}); err != nil {
				t.Fatalf("resize_page %dx%d gagal: %v", size[0], size[1], err)
			}
			evalOut, err := c.CallTool(ctx, "evaluate_script", map[string]any{
				"function": `() => window.innerWidth + 'x' + window.innerHeight`,
			})
			if err != nil {
				t.Fatalf("evaluate_script sesudah resize gagal: %v", err)
			}
			want := fmt.Sprintf("%dx%d", size[0], size[1])
			t.Logf("ukuran sesudah resize %s: %s", want, evalOut)
			if !strings.Contains(evalOut, want) {
				t.Fatalf("resize_page %s harus mengubah ukuran halaman, dapat: %q", want, evalOut)
			}
		}
	})
}

func firstN(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "\n...[dipotong]"
}

package browser

import (
	"context"
	"fmt"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Verifikasi preview Fase 2 (rencana §6): urutan tool scripted yang
// deterministik, dipanggil pipeline OTOMATIS sesudah run_build sukses +
// dev server nyala — bukan menunggu model ingat memanggil alat browser.
//
// MEKANISME (dipilih scripted deterministik, bukan LLM-driven):
//   - Bisa diuji tanpa kunci AI (test integrasi Chrome + server MCP palsu
//     membuktikan deteksi error), hasilnya sama setiap run, dan batas
//     putaran ditegakkan counter di pipeline (MaxBrowserVerifyRounds),
//     bukan hanya janji di prompt. Model tetap bisa memakai alat browser
//     sendiri selama stream (lihat instruksi prompt di ai.go), tetapi
//     verifikasi ini TIDAK bergantung pada itu.
//   - Urutan: navigate_page → (tunggu mount) → take_snapshot →
//     list_console_messages → list_network_requests → take_screenshot.
//   - Hasil (console error, network gagal, ringkasan snapshot) diumpankan
//     kembali ke repairProjectFiles supaya model memperbaiki, dan
//     dilaporkan ke user apa adanya bila putaran habis.
//
// Aturan penilaian (hasil probe 15 Nov 2026 terhadap chrome-devtools-mcp
// 1.13.0 — format output nyata, bukan tebakan):
//   - Console: baris `msgid=N [error] ...`. Baris "Failed to load
//     resource" DIABAIKAN di sini karena server menggabungkan beberapa
//     resource gagal jadi satu baris "[N times]" TANPA menyebut URL —
//     404 favicon.ico (yang muncul di tiap halaman tanpa favicon) tidak
//     bisa dibedakan dari 404 aset sungguhan lewat baris itu. Kegagalan
//     resource dinilai lewat daftar network, yang menyebut URL tiap
//     request sehingga favicon bisa dikecualikan dengan tepat.
//   - Network: baris `reqid=N METHOD URL [STATUS]`; gagal bila status
//     >= 400, kecuali favicon.ico.
//   - Snapshot hanya diringkas (struktur + teks terlihat, ≤2 KiB) untuk
//     konteks perbaikan; model text-only tidak membaca screenshot.
type VerificationResult struct {
	// Passed true bila tidak ada console error maupun request gagal.
	Passed bool
	// ConsoleErrors adalah baris [error] dari console (tanpa baris
	// "Failed to load resource" dan tanpa favicon — lihat aturan di atas).
	ConsoleErrors []string
	// FailedRequests adalah "METHOD URL [status]" untuk request gagal
	// (tanpa favicon.ico).
	FailedRequests []string
	// SnapshotSummary adalah ringkasan accessibility tree (≤2 KiB).
	SnapshotSummary string
	// ScreenshotPath adalah path absolut file PNG di dalam workspace
	// server MCP; pipeline memindahkannya ke
	// runtime/<run-id>/screenshot-<n>.png dan mencatat path akhirnya.
	ScreenshotPath string
	// Summary adalah satu-dua kalimat hasil untuk chat / agent_tool_calls.
	Summary string
}

// MaxSnapshotSummaryBytes membatasi ringkasan snapshot untuk konteks model.
const MaxSnapshotSummaryBytes = 2048

// verifySettleDelay memberi React/Vite waktu mount + console ter-flush
// sesudah navigate_page kembali (navigasi kembali saat dokumen dimuat,
// belum tentu sesudah JS jalan).
const verifySettleDelay = time.Second

// VerifyPreview menjalankan satu putaran verifikasi scripted terhadap
// previewURL (wajib lolos ValidateURL — hanya origin preview proyek).
// screenshotName adalah nama file di dalam workspace server MCP, mis.
// "screenshot-1.png". Screenshot TIDAK dibaca model (text-only);
// path-nya dikembalikan untuk dicatat sebagai artifact run.
func VerifyPreview(ctx context.Context, c *Client, previewURL, screenshotName string) (VerificationResult, error) {
	var res VerificationResult
	if err := ValidateURL(previewURL); err != nil {
		return res, err
	}
	if strings.TrimSpace(screenshotName) == "" {
		return res, fmt.Errorf("browser: nama file screenshot kosong")
	}
	ws := c.WorkspaceDir()
	if ws == "" {
		return res, fmt.Errorf("browser: workspace client kosong (screenshot tidak punya tempat tulis)")
	}
	if _, err := c.CallTool(ctx, "navigate_page", map[string]interface{}{"url": previewURL}); err != nil {
		return res, fmt.Errorf("browser: verifikasi gagal buka preview: %w", err)
	}
	select {
	case <-ctx.Done():
		return res, ctx.Err()
	case <-time.After(verifySettleDelay):
	}
	snap, err := c.CallTool(ctx, "take_snapshot", map[string]interface{}{})
	if err != nil {
		return res, fmt.Errorf("browser: verifikasi gagal ambil snapshot: %w", err)
	}
	res.SnapshotSummary = summarizeSnapshot(snap)
	consoleOut, err := c.CallTool(ctx, "list_console_messages", map[string]interface{}{})
	if err != nil {
		return res, fmt.Errorf("browser: verifikasi gagal baca console: %w", err)
	}
	res.ConsoleErrors = ParseConsoleErrors(consoleOut)
	netOut, err := c.CallTool(ctx, "list_network_requests", map[string]interface{}{})
	if err != nil {
		return res, fmt.Errorf("browser: verifikasi gagal baca network: %w", err)
	}
	res.FailedRequests = ParseFailedRequests(netOut)
	shotPath := filepath.Join(ws, screenshotName)
	if _, err := c.CallTool(ctx, "take_screenshot", map[string]interface{}{"filePath": shotPath}); err != nil {
		return res, fmt.Errorf("browser: verifikasi gagal ambil screenshot: %w", err)
	}
	res.ScreenshotPath = shotPath
	res.Passed = len(res.ConsoleErrors) == 0 && len(res.FailedRequests) == 0
	res.Summary = buildVerifySummary(res)
	return res, nil
}

// Diagnostic merangkai temuan menjadi teks untuk repairProjectFiles dan
// laporan ke user: isi console error + request gagal yang BENAR (bukan
// klaim model), plus ringkasan snapshot.
func (r VerificationResult) Diagnostic() string {
	var sb strings.Builder
	if r.Passed {
		sb.WriteString("Verifikasi browser lolos: 0 console error, 0 request gagal.")
		return sb.String()
	}
	sb.WriteString("Verifikasi browser di Chrome menemukan masalah pada preview:\n")
	if len(r.ConsoleErrors) > 0 {
		sb.WriteString("CONSOLE ERROR:\n")
		for _, e := range r.ConsoleErrors {
			sb.WriteString("- " + e + "\n")
		}
	}
	if len(r.FailedRequests) > 0 {
		sb.WriteString("REQUEST GAGAL:\n")
		for _, f := range r.FailedRequests {
			sb.WriteString("- " + f + "\n")
		}
	}
	if r.SnapshotSummary != "" {
		sb.WriteString("SNAPSHOT HALAMAN:\n" + r.SnapshotSummary + "\n")
	}
	return strings.TrimSpace(sb.String())
}

func buildVerifySummary(r VerificationResult) string {
	if r.Passed {
		s := "Verifikasi browser lolos: 0 console error, 0 request gagal"
		if r.ScreenshotPath != "" {
			s += ", screenshot tersimpan"
		}
		return s + "."
	}
	parts := []string{}
	if n := len(r.ConsoleErrors); n > 0 {
		parts = append(parts, fmt.Sprintf("%d console error", n))
	}
	if n := len(r.FailedRequests); n > 0 {
		parts = append(parts, fmt.Sprintf("%d request gagal", n))
	}
	return "Verifikasi browser gagal: " + strings.Join(parts, ", ") + "."
}

func summarizeSnapshot(snap string) string {
	snap = strings.TrimSpace(snap)
	if len(snap) <= MaxSnapshotSummaryBytes {
		return snap
	}
	return snap[:MaxSnapshotSummaryBytes] + "\n...[snapshot dipotong]"
}

// ParseConsoleErrors mengambil baris [error] dari output
// list_console_messages. Format nyata (chrome-devtools-mcp 1.13.0):
// "msgid=2 [error] ERR-UJI: ... (1 args)". Diabaikan:
//   - baris header ("## Console messages", "Showing ..."),
//   - baris level lain ([log]/[warn]/...),
//   - baris "Failed to load resource" (kegagalan resource dinilai lewat
//     network — baris ini tidak menyebut URL dan menggabungkan beberapa
//     resource, termasuk favicon.ico, jadi tidak bisa dipakai menilai),
//   - baris apa pun yang menyebut favicon.ico.
func ParseConsoleErrors(output string) []string {
	out := []string{}
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if !strings.Contains(line, "[error]") {
			continue
		}
		if strings.Contains(line, "favicon.ico") {
			continue
		}
		if strings.Contains(line, "Failed to load resource") {
			continue
		}
		out = append(out, line)
	}
	return out
}

// networkLineRe mem-parse satu baris list_network_requests:
// "reqid=2 GET http://127.0.0.1:18098/tidak-ada.json [404]" atau
// "reqid=6 GET http://127.0.0.1:18098/putus [net::ERR_CONNECTION_REFUSED]".
var networkLineRe = regexp.MustCompile(`^reqid=\d+\s+(\S+)\s+(\S+)\s+\[(.+)\]$`)

// ParseFailedRequests mengambil request gagal dari output
// list_network_requests: status HTTP >= 400 atau error net::*.
// Dikecualikan (selaras dengan acceptance Trek B):
//   - favicon.ico 404 (bukan error aplikasi — spike Fase 0),
//   - 401 pada /api/app-api/ (probe auth aplikasi logged-out, normal),
//   - URL data: (inline, bisa puluhan KB base64).
//
// URL halaman itu sendiri TIDAK dikecualikan: bila preview 404, itu
// berarti preview rusak dan verifikasi harus gagal.
func ParseFailedRequests(output string) []string {
	out := []string{}
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if len(line) > 2048 {
			line = line[:2048] // baris data: URL bisa puluhan KB (base64)
		}
		m := networkLineRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		method, u, statusText := m[1], m[2], strings.TrimSpace(m[3])
		if strings.HasPrefix(u, "data:") || strings.Contains(u, "favicon.ico") {
			continue
		}
		if status, err := strconv.Atoi(statusText); err == nil {
			if status >= 400 && !(status == 401 && strings.Contains(u, "/api/app-api/")) {
				out = append(out, method+" "+u+" ["+statusText+"]")
			}
			continue
		}
		if strings.HasPrefix(statusText, "net::") {
			out = append(out, method+" "+u+" ["+statusText+"]")
		}
	}
	return out
}

// Package browser — acceptance satu tembakan lewat MCP (Fase 2 rencana
// docs/mcp-browser-integration-plan.md §6).
//
// RunAcceptance / CaptureScreenshot adalah jalur browserAcceptance
// dan runtimeCaptureScreenshot (server/internal/handler/runtime.go):
// navigasi ke preview proyek, baca console + network, lalu kembalikan
// struktur hasil (http, hasBody, consoleErrors, failedAppResources, sdk)
// yang dipakai pemakai di features.go / repair.go.
//
// Perilaku penilaian yang disengaja: 404 favicon.ico DIABAIKAN saat
// menilai (bukan console error dan bukan failedAppResource) — halaman
// tanpa favicon tidak boleh membuat acceptance gagal. Parser console
// dipakai ulang dari Trek A (ParseConsoleErrors di verify.go) supaya satu
// semantik di paket ini: baris "Failed to load resource" juga dibuang
// dari consoleErrors karena tidak menyebut URL dan menggabungkan beberapa
// resource — kegagalan resource dinilai lewat daftar network.
//
// Jalur ini server-driven (bukan model-driven): pemanggilan tool di sini
// memakai callAcceptanceTool, yang memeriksa allowlist §5 TAPI TIDAK
// memeriksa gate aktif Fase 1 (IsActiveTool) — gate itu membatasi apa yang
// BOLEH DIPANGGIL MODEL lewat katalog agent, bukan apa yang boleh dipakai
// acceptance internal. Jangan pakai helper ini untuk mengeksekusi tool
// yang diminta model.
package browser

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// ErrAcceptanceFailed: halaman DIBUKA dan dicek, tapi TIDAK LOLOS
// (console error fatal, resource gagal, HTTP >= 400, atau body kosong).
// Berbeda dengan error infrastruktur (MCP/Chrome gagal start) — caller
// (handler) WAJIB membedakan keduanya: ErrAcceptanceFailed adalah verdict
// final halaman, sedangkan error lain berarti MCP tidak jalan dan caller
// harus mengembalikan error tegas (tidak ada fallback).
var ErrAcceptanceFailed = errors.New("browser acceptance gagal")

// AcceptanceTimeout adalah batas total satu acceptance: 30 dtk.
const AcceptanceTimeout = 30 * time.Second

// acceptanceResult adalah bentuk dalam yang dirakit dari tool MCP, lalu
// diubah ke map[string]interface{} dengan kunci (http, hasBody,
// consoleErrors, failedAppResources, sdk) yang dipakai pemakai di
// features.go / repair.go.
type acceptanceResult struct {
	HTTP               int                      `json:"http"`
	HasBody            bool                     `json:"hasBody"`
	ConsoleErrors      []string                 `json:"consoleErrors"`
	FailedAppResources []map[string]interface{} `json:"failedAppResources"`
	SDK                map[string]interface{}   `json:"sdk"`
}

// RunAcceptance menjalankan acceptance MCP satu tembakan terhadap pageURL
// (harus URL preview 127.0.0.1/localhost — ditegakkan ValidateURL).
// Satu profil Chrome per pemanggilan: dibuat di direktori temporer, lalu
// dihapus sesudahnya (kill + hapus profil, pola yang sama seperti
// NewClientForRun); timeout mengikuti ctx pemanggil (dibatasi
// AcceptanceTimeout).
//
//   - sukses (lolos): (hasil, nil)
//   - halaman tidak lolos: (map{"output": jsonHasil}, ErrAcceptanceFailed)
//   - MCP/Chrome gagal (gating mati, Chrome tidak ada, start gagal):
//     (map{"output": ...}, error infrastruktur) — caller mengembalikan
//     error tegas (tidak ada fallback).
func RunAcceptance(ctx context.Context, pageURL string) (map[string]interface{}, error) {
	if err := ValidateURL(pageURL); err != nil {
		return map[string]interface{}{"output": err.Error()}, err
	}
	tmpDir, err := os.MkdirTemp("", "wb-browser-acceptance-*")
	if err != nil {
		return map[string]interface{}{"output": err.Error()}, fmt.Errorf("browser: gagal buat direktori temporer acceptance: %w", err)
	}
	defer os.RemoveAll(tmpDir)

	client, err := NewClientForRun(0, tmpDir)
	if err != nil {
		return map[string]interface{}{"output": err.Error()}, err
	}
	defer client.Close()
	callCtx, cancel := context.WithTimeout(ctx, AcceptanceTimeout)
	defer cancel()
	if err := client.Start(callCtx); err != nil {
		return map[string]interface{}{"output": err.Error()}, fmt.Errorf("browser: acceptance MCP gagal start: %w", err)
	}
	return RunAcceptanceWithClient(callCtx, client, pageURL)
}

// RunAcceptanceWithClient menjalankan acceptance memakai Client yang sudah
// Start (dipakai test + pemakai yang mengelola lifecycle sendiri).
// Port preview dipelajari dari pageURL (setPreviewPortFromURL — pageURL
// dibangun pemanggil dari port dev server, bukan input model); bila
// Client sudah dikunci ke port lain, ditolak fail-closed.
func RunAcceptanceWithClient(ctx context.Context, client *Client, pageURL string) (map[string]interface{}, error) {
	if err := ValidateURL(pageURL); err != nil {
		return map[string]interface{}{"output": err.Error()}, err
	}
	if err := client.setPreviewPortFromURL(pageURL); err != nil {
		return map[string]interface{}{"output": err.Error()}, err
	}
	if _, err := client.callAcceptanceTool(ctx, "navigate_page", map[string]interface{}{"url": pageURL}); err != nil {
		return map[string]interface{}{"output": err.Error()}, fmt.Errorf("browser: acceptance gagal navigasi ke %s: %w", pageURL, err)
	}
	// Beri halaman waktu menyelesaikan fetch/render awal (pengganti
	// waitUntil networkidle; tool wait_for tidak dipakai supaya tidak ada
	// ketergantungan pada skema argumennya).
	select {
	case <-ctx.Done():
		return map[string]interface{}{"output": ctx.Err().Error()}, ctx.Err()
	case <-time.After(700 * time.Millisecond):
	}

	snapshot, _ := client.callAcceptanceTool(ctx, "take_snapshot", map[string]interface{}{})
	consoleOut, consoleErr := client.callAcceptanceTool(ctx, "list_console_messages", map[string]interface{}{})
	networkOut, networkErr := client.callAcceptanceTool(ctx, "list_network_requests", map[string]interface{}{})
	pageInfo, evalErr := evaluatePageState(ctx, client, pageURL)

	res := &acceptanceResult{
		ConsoleErrors:      []string{},
		FailedAppResources: []map[string]interface{}{},
		SDK:                map[string]interface{}{"installed": false},
	}
	if consoleErr == nil {
		// ParseConsoleErrors (Trek A, verify.go) sudah membuang baris
		// "Failed to load resource" + favicon — kegagalan resource
		// dinilai lewat network, bukan console. Di sini tinggal
		// dibersihkan prefix msgid/suffix "(N args)" untuk diagnostik.
		res.ConsoleErrors = cleanConsoleErrors(ParseConsoleErrors(consoleOut))
	} else {
		res.ConsoleErrors = append(res.ConsoleErrors, "list_console_messages gagal: "+consoleErr.Error())
	}
	if networkErr == nil {
		res.FailedAppResources = append(res.FailedAppResources, parseNetworkFailures(networkOut, pageURL)...)
	}
	if evalErr == nil {
		res.HTTP = pageInfo.httpStatus
		res.HasBody = pageInfo.bodyLen > 0
		res.SDK = pageInfo.sdk
		if res.FailedAppResources == nil {
			res.FailedAppResources = []map[string]interface{}{}
		}
		res.FailedAppResources = append(res.FailedAppResources, pageInfo.failedResources...)
		res.FailedAppResources = dedupeFailedResources(res.FailedAppResources)
	} else {
		// Evaluate gagal: jangan klaim sukses palsu — hasBody dari
		// snapshot (bila ada isi) dan http 0 memicu gagal di bawah.
		res.HasBody = snapshotHasBody(snapshot)
		res.ConsoleErrors = append(res.ConsoleErrors, "evaluate_script gagal: "+evalErr.Error())
	}
	if len(res.ConsoleErrors) > 10 {
		res.ConsoleErrors = res.ConsoleErrors[:10]
	}
	if res.SDK == nil {
		res.SDK = map[string]interface{}{"installed": false}
	}

	out, _ := json.Marshal(res)
	result := map[string]interface{}{}
	_ = json.Unmarshal(out, &result)
	if reasons := acceptanceFailures(res); len(reasons) > 0 {
		return map[string]interface{}{"output": string(out)},
			fmt.Errorf("%w: %s", ErrAcceptanceFailed, strings.Join(reasons, "; "))
	}
	return result, nil
}

// acceptanceFailures menilai hasil acceptance: gagal bila HTTP
// kosong/>=400, body kosong, ada resource gagal, atau ada console error.
// ParseConsoleErrors sudah membuang baris "Failed to load resource" +
// favicon, jadi tiap console error di sini fatal.
func acceptanceFailures(res *acceptanceResult) []string {
	reasons := []string{}
	if res.HTTP == 0 || res.HTTP >= 400 {
		reasons = append(reasons, fmt.Sprintf("http %d", res.HTTP))
	}
	if !res.HasBody {
		reasons = append(reasons, "body kosong")
	}
	if len(res.FailedAppResources) > 0 {
		reasons = append(reasons, fmt.Sprintf("%d resource aplikasi gagal", len(res.FailedAppResources)))
	}
	if fatal := len(res.ConsoleErrors); fatal > 0 {
		reasons = append(reasons, fmt.Sprintf("%d console error fatal", fatal))
	}
	return reasons
}

// CaptureScreenshot mengambil screenshot preview (satu tembakan, pola
// lifecycle sama seperti RunAcceptance) dan menyimpannya ke outPath.
// Gagal start MCP/Chrome → error (caller mengembalikan error tegas,
// tanpa fallback).
func CaptureScreenshot(ctx context.Context, pageURL, outPath string) error {
	if err := ValidateURL(pageURL); err != nil {
		return err
	}
	tmpDir, err := os.MkdirTemp("", "wb-browser-screenshot-*")
	if err != nil {
		return fmt.Errorf("browser: gagal buat direktori temporer screenshot: %w", err)
	}
	defer os.RemoveAll(tmpDir)

	client, err := NewClientForRun(0, tmpDir)
	if err != nil {
		return err
	}
	defer client.Close()
	callCtx, cancel := context.WithTimeout(ctx, AcceptanceTimeout)
	defer cancel()
	if err := client.Start(callCtx); err != nil {
		return fmt.Errorf("browser: screenshot MCP gagal start: %w", err)
	}
	return CaptureScreenshotWithClient(callCtx, client, pageURL, outPath)
}

// CaptureScreenshotWithClient mengambil screenshot memakai Client yang
// sudah Start. take_screenshot HANYA boleh menulis ke dalam --workspace
// server MCP (path absolut di dalam workspace), jadi hasil diambil dari
// sana lalu disalin ke outPath.
func CaptureScreenshotWithClient(ctx context.Context, client *Client, pageURL, outPath string) error {
	if err := ValidateURL(pageURL); err != nil {
		return err
	}
	if err := client.setPreviewPortFromURL(pageURL); err != nil {
		return err
	}
	if _, err := client.callAcceptanceTool(ctx, "navigate_page", map[string]interface{}{"url": pageURL}); err != nil {
		return fmt.Errorf("browser: screenshot gagal navigasi ke %s: %w", pageURL, err)
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(700 * time.Millisecond):
	}
	tmpName := "capture.png"
	shotPath := filepath.Join(client.cfg.WorkspaceDir, tmpName)
	if _, err := client.callAcceptanceTool(ctx, "take_screenshot", map[string]interface{}{"filePath": shotPath}); err != nil {
		return fmt.Errorf("browser: take_screenshot gagal: %w", err)
	}
	data, err := os.ReadFile(shotPath)
	if err != nil {
		return fmt.Errorf("browser: hasil screenshot tidak terbaca %s: %w", shotPath, err)
	}
	if len(data) == 0 {
		return fmt.Errorf("browser: screenshot kosong")
	}
	if err := os.MkdirAll(filepath.Dir(outPath), 0o755); err != nil {
		return fmt.Errorf("browser: gagal buat direktori screenshot %s: %w", filepath.Dir(outPath), err)
	}
	if err := os.WriteFile(outPath, data, 0o644); err != nil {
		return fmt.Errorf("browser: gagal tulis screenshot %s: %w", outPath, err)
	}
	return nil
}

// callAcceptanceTool memanggil satu tool MCP untuk kebutuhan acceptance
// internal. Sama seperti Client.CallTool (timeout 30 dtk mengikuti ctx,
// cap 64 KiB TERMASUK jalur error tool, validasi URL ke port preview yang
// sudah dikunci + budget per run yang sama — pemanggilan acceptance
// MENGHABISKAN jatah yang sama dengan pemanggilan model) KECUALI gate
// aktif Fase 1 tidak dipakai: yang diperiksa hanya allowlist §5
// (IsAllowlisted). Gate aktif membatasi tool yang boleh dipanggil MODEL;
// acceptance adalah pemakaian internal server, bukan perintah model.
func (c *Client) callAcceptanceTool(ctx context.Context, name string, args map[string]interface{}) (out string, err error) {
	start := time.Now()
	defer func() { c.observeCall(name, start, err) }()
	if !IsAllowlisted(name) {
		return "", fmt.Errorf("browser: tool %q di luar allowlist §5", name)
	}
	if rawURL, ok := args["url"]; ok {
		if s, ok := rawURL.(string); ok && strings.TrimSpace(s) != "" {
			if err := c.validatePreviewURL(s); err != nil {
				return "", err
			}
		}
	}
	c.mu.Lock()
	session := c.session
	started := c.started
	callTimeout := c.callTimeout
	c.mu.Unlock()
	if !started || session == nil {
		return "", fmt.Errorf("browser: client belum start")
	}
	if err := c.reserveCall(); err != nil {
		return "", err
	}
	callCtx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	res, err := session.CallTool(callCtx, &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		return "", fmt.Errorf("browser: panggilan tool %q gagal: %w", name, err)
	}
	if res == nil {
		return "", nil
	}
	if res.IsError {
		return TruncateOutput(toolResultText(res)), fmt.Errorf("browser: tool %q mengembalikan error: %s", name, TruncateOutput(toolResultText(res)))
	}
	return TruncateOutput(toolResultText(res)), nil
}

// pageState adalah hasil satu evaluate_script gabungan: status HTTP
// (dari navigation timing, fallback fetch), panjang body, info SDK, dan
// resource gagal menurut performance timing.
type pageState struct {
	httpStatus      int
	bodyLen         int
	sdk             map[string]interface{}
	failedResources []map[string]interface{}
}

const evaluatePageStateJS = `async () => {
  const nav = performance.getEntriesByType("navigation")[0];
  let status = nav && nav.responseStatus ? nav.responseStatus : 0;
  if (!status) { try { const r = await fetch(location.href); status = r.status; } catch (e) { status = 0; } }
  const bodyLen = document.body ? document.body.innerText.trim().length : 0;
  let sdk = {installed: false};
  const has = typeof window.cloudAuth === "object" && typeof window.cloudDb === "object";
  if (has) {
    try { await window.cloudAuth.me(); sdk = {installed: true, loggedOut: false}; }
    catch (e) { sdk = {installed: true, loggedOut: true}; }
  }
  const failed = performance.getEntriesByType("resource")
    .filter(e => e.responseStatus && e.responseStatus >= 400)
    .map(e => ({url: e.name, status: e.responseStatus}));
  return JSON.stringify({status: status, bodyLen: bodyLen, sdk: sdk, failed: failed, origin: location.origin});
}`

func evaluatePageState(ctx context.Context, client *Client, pageURL string) (*pageState, error) {
	out, err := client.callAcceptanceTool(ctx, "evaluate_script", map[string]interface{}{"function": evaluatePageStateJS})
	if err != nil {
		return nil, err
	}
	var raw struct {
		Status  int                      `json:"status"`
		BodyLen int                      `json:"bodyLen"`
		SDK     map[string]interface{}   `json:"sdk"`
		Failed  []map[string]interface{} `json:"failed"`
		Origin  string                   `json:"origin"`
	}
	if err := parseEvaluateResult(out, &raw); err != nil {
		return nil, fmt.Errorf("browser: hasil evaluate_script tidak bisa di-parse: %w", err)
	}
	st := &pageState{httpStatus: raw.Status, bodyLen: raw.BodyLen, sdk: raw.SDK}
	for _, f := range raw.Failed {
		u, _ := f["url"].(string)
		if u == "" || u == pageURL {
			continue
		}
		if isFaviconURL(u) || isExpectedAuthProbe(u, statusAsInt(f["status"])) {
			continue
		}
		if raw.Origin != "" {
			if ou, err := url.Parse(u); err != nil || ou.Scheme+"://"+ou.Host != raw.Origin {
				continue // hanya resource origin yang sama (seperti skrip lama)
			}
		}
		st.failedResources = append(st.failedResources, map[string]interface{}{"url": u, "status": f["status"]})
	}
	return st, nil
}

func statusAsInt(v interface{}) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	case json.Number:
		i, _ := n.Int64()
		return int(i)
	default:
		return 0
	}
}

// parseEvaluateResult mengurai output teks evaluate_script
// chrome-devtools-mcp 1.13.0. Bentuk yang terbukti dari spike Fase 2:
//
//	Script ran on page and returned:
//	```json
//	"{...json string...}"
//	```
//
// Isi fence adalah string JSON (hasil JSON.stringify di halaman) —
// jadi di-unmarshal dua lapis. Bila fence tidak ada atau isinya sudah
// objek, coba unmarshal langsung sebagai fallback.
func parseEvaluateResult(text string, v any) error {
	body := text
	if start := strings.Index(text, "```json"); start >= 0 {
		rest := text[start+len("```json"):]
		if end := strings.Index(rest, "```"); end >= 0 {
			body = strings.TrimSpace(rest[:end])
		}
	}
	var s string
	if err := json.Unmarshal([]byte(body), &s); err == nil {
		return json.Unmarshal([]byte(s), v)
	}
	return json.Unmarshal([]byte(body), v)
}

// consoleMsgRe: "msgid=2 [error] pesan (1 args)" —
// cleanConsoleErrors membuang prefix msgid + level dan suffix "(N args)"
// dari baris yang sudah disaring ParseConsoleErrors, supaya diagnostik
// repair (repair.go) menerima pesan bersih (teks console / pageerror
// tanpa prefix).
var consoleMsgRe = regexp.MustCompile(`^msgid=\d+\s+\[\w+\]\s+(.*)$`)
var consoleArgsSuffixRe = regexp.MustCompile(`\s*\(\d+ args?\)\s*$`)

// cleanConsoleErrors membersihkan baris console yang sudah disaring
// ParseConsoleErrors (Trek A, verify.go).
func cleanConsoleErrors(lines []string) []string {
	out := []string{}
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if m := consoleMsgRe.FindStringSubmatch(line); m != nil {
			line = m[1]
		}
		line = strings.TrimSpace(consoleArgsSuffixRe.ReplaceAllString(line, ""))
		if line != "" {
			out = append(out, line)
		}
	}
	return out
}

// parseNetworkFailures mengambil resource gagal origin-yang-sama dari
// output list_network_requests: status >= 400 atau error net::*.
// Dilewati (aturan bersama — lihat failedNetworkRequests di network.go):
// URL data: (inline, raksasa), favicon.ico 404, probe auth
// /api/app-api/ yang 401 (expected), dan request lintas-origin.
//
// URL halaman itu sendiri DILEWATI di sini (statusnya dinilai lewat
// navigation timing di evaluatePageState). Berbeda dengan
// ParseFailedRequests di verify.go, yang menghitung halaman sendiri
// 404 sebagai gagal — perbedaan yang disengaja, dipertahankan oleh
// opsi excludePageURL di inti bersama.
func parseNetworkFailures(text, pageURL string) []map[string]interface{} {
	out := []map[string]interface{}{}
	for _, req := range failedNetworkRequests(text, networkFailureOptions{
		pageURL:           pageURL,
		excludePageURL:    true,
		faviconSubstring:  false,
		originUnknownPass: false,
		netErrorTrimmed:   false,
	}) {
		if req.netError {
			out = append(out, map[string]interface{}{"url": req.url, "error": req.statusRaw})
		} else {
			out = append(out, map[string]interface{}{"url": req.url, "status": req.status})
		}
	}
	return out
}

// isFaviconURL: /favicon.ico di path mana pun (spike §6: 404 favicon
// bukan error aplikasi).
func isFaviconURL(u string) bool {
	parsed, err := url.Parse(u)
	if err != nil {
		return strings.HasSuffix(u, "/favicon.ico")
	}
	return strings.HasSuffix(parsed.Path, "/favicon.ico")
}

// isExpectedAuthProbe: probe /api/app-api/ yang 401 adalah perilaku
// normal aplikasi logged-out (skrip lama: isExpected401).
func isExpectedAuthProbe(u string, status int) bool {
	return status == 401 && strings.Contains(u, "/api/app-api/")
}

// dedupeFailedResources menghapus duplikat URL (network + performance
// timing bisa melaporkan resource yang sama dua kali).
func dedupeFailedResources(in []map[string]interface{}) []map[string]interface{} {
	seen := map[string]bool{}
	out := []map[string]interface{}{}
	for _, f := range in {
		u, _ := f["url"].(string)
		if u == "" || seen[u] {
			continue
		}
		seen[u] = true
		out = append(out, f)
	}
	return out
}

// snapshotHasBody: fallback hasBody bila evaluate gagal — snapshot
// accessibility tree yang berisi konten selain judul halaman.
func snapshotHasBody(snapshot string) bool {
	for _, line := range strings.Split(snapshot, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "## ") || strings.HasPrefix(trimmed, "uid=") && strings.Contains(trimmed, "RootWebArea") {
			continue
		}
		if strings.HasPrefix(trimmed, "uid=") {
			return true
		}
	}
	return false
}

// Package browser adalah klien MCP (Model Context Protocol) untuk alat
// browser agent Website-builder (Fase 1 rencana
// docs/mcp-browser-integration-plan.md).
//
// Satu Client berbicara dengan satu server chrome-devtools-mcp yang
// dijalankan sebagai subproses stdio, yang pada gilirannya mengendalikan
// satu Chrome headless dengan profil terisolasi per agent run.
//
// Keputusan desain Fase 1 (lihat docs/mcp-spike-notes.md):
//   - Routing pageId DIMATIKAN lewat flag --no-page-id-routing. Spike Fase 0
//     membuktikan semua tool per-halaman butuh pageId bila routing nyala,
//     dan pageId itu hanya tersedia sebagai teks markdown dari list_pages.
//     Satu run hanya memakai satu halaman, jadi routing per-halaman tidak
//     dibutuhkan; mematikan routing membuat pemanggilan tool polos
//     (tanpa pageId) dan menghilangkan parser markdown yang rapuh.
//   - Profil Chrome eksplisit per run lewat --user-data-dir di bawah
//     direktori run (bukan --isolated), supaya Close() bisa menghapusnya
//     secara deterministik dan tidak ada profil yatim.
//   - Command server MCP di-pin ke chrome-devtools-mcp@1.13.0 (versi hasil
//     spike), bukan @latest, supaya build reproduksibel.
//
// Keamanan: hanya origin preview proyek sendiri (http(s) ke 127.0.0.1 /
// localhost, PORT preview proyek itu — lihat SetPreviewPort) yang boleh
// dibuka. Ditegakkan di validatePreviewURL di lapis klien, bukan
// mengandalkan model. Fail-closed: bila flag nyala tapi Chrome/MCP
// tidak tersedia, Start mengembalikan error jelas dan agent berjalan tanpa
// alat browser (lihat lifecycle.go: Enabled + NewClientForRun); bila port
// preview belum diketahui, navigasi ke URL mana pun ditolak.
package browser

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Env names.
const (
	// EnvEnableBrowserTools menyalakan alat browser (hanya nilai "1").
	EnvEnableBrowserTools = "WEBBUILDER_ENABLE_BROWSER_TOOLS"
	// EnvEnableTenantExec adalah flag eksekusi tenant; browser tools hanya
	// aktif bila flag ini JUGA nyala (lihat Enabled).
	EnvEnableTenantExec = "WEBBUILDER_ENABLE_TENANT_EXEC"
	// EnvMCPCommand meng-override command server MCP (satu baris perintah,
	// dipisah spasi sederhana — tanpa quoting shell).
	EnvMCPCommand = "CHROME_DEVTOOLS_MCP_CMD"
	// EnvChromePath adalah path biner Chrome for Testing.
	EnvChromePath = "CHROME_FOR_TESTING_PATH"
)

// DefaultMCPCommand adalah command server MCP hasil spike Fase 0 — di-pin
// ke versi 1.13.0, bukan @latest, supaya reproduksibel.
const DefaultMCPCommand = "npx -y chrome-devtools-mcp@1.13.0"

// CallTimeout adalah batas per panggilan tool browser. JANGAN diubah
// tanpa alasan — rencana §4 menetapkan 30 detik; Client menyalinnya ke
// callTimeout saat NewClient supaya test bisa menyuntikkan nilai kecil
// tanpa mengubah konstanta ini.
const CallTimeout = 30 * time.Second

// MaxBrowserCallsPerRun adalah batas panggilan tool browser per run
// (rencana §4: maks 10 panggilan browser / 5 menit per run). Dihitung
// SEMUA pemanggilan CallTool + callAcceptanceTool dalam satu Client
// (model-driven + scripted VerifyPreview + acceptance); ListTools TIDAK
// dihitung (bukan panggilan tool). Ditegakkan reserveCall.
const MaxBrowserCallsPerRun = 10

// BrowserBudgetWindow adalah jendela budget per run: sejak panggilan
// browser pertama run itu (rencana §4: 5 menit).
const BrowserBudgetWindow = 5 * time.Minute

// MaxOutputBytes adalah cap hasil tool per panggilan (64 KiB, rencana §4).
// Kelebihan dipotong dan ditandai (lihat TruncateOutput).
const MaxOutputBytes = 64 * 1024

// ErrBrowserToolsDisabled: alat browser diminta padahal gating mati.
var ErrBrowserToolsDisabled = errors.New("browser tools disabled (set WEBBUILDER_ENABLE_BROWSER_TOOLS=1 dan WEBBUILDER_ENABLE_TENANT_EXEC=1)")

// ErrChromeNotFound: CHROME_FOR_TESTING_PATH menunjuk path yang tidak ada.
var ErrChromeNotFound = errors.New("chrome for testing tidak ditemukan")

// Enabled melaporkan apakah alat browser boleh aktif: kedua flag harus
// persis "1" (rencana §4). Membaca env setiap kali supaya perubahan env
// (mis. di test) langsung berlaku.
func Enabled() bool {
	return os.Getenv(EnvEnableBrowserTools) == "1" && os.Getenv(EnvEnableTenantExec) == "1"
}

// Config adalah konfigurasi satu Client (satu agent run).
type Config struct {
	// Command adalah baris perintah server MCP, mis.
	// "npx -y chrome-devtools-mcp@1.13.0". Kosong = DefaultMCPCommand.
	Command string
	// ChromePath adalah path biner Chrome (--executablePath). Kosong =
	// auto-detect oleh server MCP.
	ChromePath string
	// WorkspaceDir adalah direktori --workspace server MCP (tempat file
	// tool seperti screenshot boleh ditulis).
	WorkspaceDir string
	// ProfileDir adalah user-data-dir Chrome untuk run ini; dihapus
	// Close() sesudah run selesai.
	ProfileDir string
}

// DefaultConfig mengembalikan Config dari environment + direktori run.
func DefaultConfig(workspaceDir, profileDir string) Config {
	return Config{
		Command:      firstNonEmpty(strings.TrimSpace(os.Getenv(EnvMCPCommand)), DefaultMCPCommand),
		ChromePath:   strings.TrimSpace(os.Getenv(EnvChromePath)),
		WorkspaceDir: workspaceDir,
		ProfileDir:   profileDir,
	}
}

// Client adalah satu sesi MCP ke chrome-devtools-mcp untuk satu agent run.
// Zero value tidak usable; buat lewat NewClient. Client aman dipakai dari
// satu goroutine pipeline (panggilan tool diserialkan dengan mutex), dan
// budget + port preview dijaga di bawah mutex yang sama supaya aman juga
// bila dua goroutine memanggil bersamaan — jangan andalkan serialisasi
// pipeline.
type Client struct {
	mu      sync.Mutex
	cfg     Config
	client  *mcp.Client
	session *mcp.ClientSession
	cmd     *exec.Cmd
	started bool
	closed  bool

	// previewPort adalah port dev-server preview proyek run ini (0 =
	// belum diketahui). Hanya origin 127.0.0.1/localhost:previewPort
	// yang boleh dibuka (lihat SetPreviewPort + validatePreviewURL).
	previewPort int
	// Budget per run (rencana §4): calls menghitung pemanggilan tool
	// sejak Client dibuat; windowStart adalah waktu panggilan pertama.
	calls       int
	windowStart time.Time
	// now, callTimeout, budgetWindow, maxCalls adalah nilai default
	// (time.Now / CallTimeout / BrowserBudgetWindow /
	// MaxBrowserCallsPerRun) yang bisa disuntik test — perilaku produksi
	// selalu memakai default.
	now          func() time.Time
	callTimeout  time.Duration
	budgetWindow time.Duration
	maxCalls     int
	// observer dipanggil di akhir setiap CallTool / callAcceptanceTool
	// (nama tool ternormalisasi, durasi, error). Dipasang handler ke
	// instance Metrics yang sama dengan /metrics (lihat
	// handler.RegisterObservability + SetDefaultCallObserver); nil =
	// tidak ada pencatatan. Di-snapshot saat NewClient supaya klien
	// yang dibuat pipeline (NewClientForRun) otomatis tercatat tanpa
	// perubahan di agentpipeline.go.
	observer CallObserver
	// lastChromeMemoryBytes adalah RSS pohon proses browser terakhir
	// yang terukur (byte); -1 bila belum pernah terukur / tidak
	// tersedia. Diukur di Close() sebelum sesi ditutup (lihat
	// memory.go); dibaca handler lewat LastChromeMemoryBytes.
	lastChromeMemoryBytes int64
}

// CallObserver dipanggil di akhir setiap panggilan tool browser, dengan
// nama tool (sudah dinormalisasi: di luar allowlist aktif → "unknown"),
// durasi panggilan, dan error akhir (nil bila sukses). Implementasi
// pencatatan (mis. observability.Metrics.RecordBrowserTool) HARUS
// non-blocking dan tidak boleh panic — observeCall menelan panic
// observer supaya pencatatan tidak pernah menggagalkan run.
type CallObserver func(tool string, duration time.Duration, err error)

var (
	defaultObserverMu sync.Mutex
	defaultObserver   CallObserver
)

// SetDefaultCallObserver memasang observer yang dipakai Client baru
// (dibuat lewat NewClient / NewClientForRun). Dipanggil sekali saat
// server start oleh handler.RegisterObservability dengan
// Metrics.RecordBrowserTool dari instance yang sama dengan /metrics.
// Klien yang sudah dibuat tidak terpengaruh; pakai SetCallObserver
// untuk mengubah observer satu klien. Nilai nil mematikan pencatatan
// default.
func SetDefaultCallObserver(o CallObserver) {
	defaultObserverMu.Lock()
	defer defaultObserverMu.Unlock()
	defaultObserver = o
}

// DefaultCallObserver mengembalikan observer default saat ini (dipakai
// test wiring).
func DefaultCallObserver() CallObserver {
	defaultObserverMu.Lock()
	defer defaultObserverMu.Unlock()
	return defaultObserver
}

// SetCallObserver mengganti observer untuk klien ini saja (nil =
// matikan pencatatan). Dipakai test; produksi memakai default dari
// NewClient.
func (c *Client) SetCallObserver(o CallObserver) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.observer = o
}

// observeCall mencatat satu panggilan tool ke observer (bila ada).
// Label tool dinormalisasi: nama di luar allowlist aktif dicatat
// sebagai "unknown" supaya kardinalitas label tetap terbatas (nama
// tool bisa datang dari model). Pesan error TIDAK PERNAH jadi label —
// hanya status success/error (lihat observability.RecordBrowserTool).
func (c *Client) observeCall(tool string, start time.Time, err error) {
	c.mu.Lock()
	obs := c.observer
	c.mu.Unlock()
	if obs == nil {
		return
	}
	label := tool
	if !IsActiveTool(tool) {
		label = "unknown"
	}
	defer func() { _ = recover() }()
	obs(label, time.Since(start), err)
}

// NewClient membuat Client dari Config (belum start).
func NewClient(cfg Config) *Client {
	return &Client{
		cfg:                   cfg,
		now:                   time.Now,
		callTimeout:           CallTimeout,
		budgetWindow:          BrowserBudgetWindow,
		maxCalls:              MaxBrowserCallsPerRun,
		observer:              DefaultCallObserver(),
		lastChromeMemoryBytes: -1,
	}
}

// SetPreviewPort mengunci port dev-server preview yang boleh dibuka
// Client ini. Hanya dipanggil kode server tepercaya — pipeline (dari
// port acceptance runtime / runtimeDev.ports proyek yang sudah jalan)
// atau diturunkan dari pageURL tepercaya di VerifyPreview /
// RunAcceptanceWithClient — TIDAK PERNAH dari input model. Boleh
// dipanggil ulang bila port berubah (mis. dev server di-start ulang
// sesudah perbaikan, putaran verifikasi berikutnya memakai port baru);
// pemanggilan dengan port tidak valid ditolak tanpa mengubah port lama.
func (c *Client) SetPreviewPort(port int) error {
	if port <= 0 || port > 65535 {
		return fmt.Errorf("browser: port preview tidak valid: %d", port)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.previewPort = port
	return nil
}

// PreviewPort mengembalikan port preview yang sudah dikunci (0 = belum
// diketahui — navigasi URL apa pun masih fail-closed).
func (c *Client) PreviewPort() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.previewPort
}

// setPreviewPortFromURL mempelajari port preview dari pageURL yang
// DITERIMA DARI KODE SERVER TEpercaya (bukan input model): pipeline /
// runtime membangun pageURL dari port dev server yang mereka start
// sendiri, jadi port di URL itu adalah port preview yang sah. Bila
// Client sudah dikunci ke port lain, URL port berbeda ditolak
// (fail-closed) — bukan diam-diam menimpa. Dipakai VerifyPreview +
// RunAcceptanceWithClient / CaptureScreenshotWithClient, yang menerima
// pageURL sebagai satu-satunya sumber port.
func (c *Client) setPreviewPortFromURL(raw string) error {
	if err := ValidateURL(raw); err != nil {
		return err
	}
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return fmt.Errorf("browser: URL tidak valid %q: %w", raw, err)
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || port <= 0 || port > 65535 {
		return fmt.Errorf("browser: URL preview harus menyebut port eksplisit: %s", raw)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.previewPort != 0 && c.previewPort != port {
		return fmt.Errorf("browser: URL di luar preview ditolak (port %d, client dikunci ke port preview %d): %s", port, c.previewPort, raw)
	}
	c.previewPort = port
	return nil
}

// validatePreviewURL adalah gerbang URL untuk SEMUA pemanggilan tool yang
// membawa argumen "url" (CallTool model-driven + callAcceptanceTool):
// skema/host dicek ValidateURL, lalu PORT HARUS SAMA dengan port preview
// yang sudah dikunci. Bila port belum diketahui (previewPort 0 — klien
// dibuat sebelum dev server nyala dan belum ada yang mengunci port),
// DITOLAK fail-closed: tidak ada fallback "port mana pun". Tool tanpa
// argumen "url" tidak lewat sini dan tetap bisa dipanggil sebelum port
// diketahui (mis. list_console_messages saat halaman sudah dibuka jalur
// scripted).
func (c *Client) validatePreviewURL(raw string) error {
	if err := ValidateURL(raw); err != nil {
		return err
	}
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return fmt.Errorf("browser: URL tidak valid %q: %w", raw, err)
	}
	c.mu.Lock()
	port := c.previewPort
	c.mu.Unlock()
	if port == 0 {
		return fmt.Errorf("browser: URL preview ditolak — port preview belum diketahui (fail-closed, dev server belum nyala / belum dikunci): %s", raw)
	}
	if u.Port() == "" || u.Port() != strconv.Itoa(port) {
		return fmt.Errorf("browser: URL di luar preview ditolak (port %q bukan port preview %d): %s", u.Port(), port, raw)
	}
	return nil
}

// reserveCall menghitung satu pemanggilan tool ke budget run ini
// (rencana §4: maks MaxBrowserCallsPerRun panggilan / BrowserBudgetWindow
// sejak panggilan pertama). Dipanggil SEBELUM pemanggilan MCP —
// pemanggilan ke-11 atau sesudah jendela habis DITOLAK dengan error jelas
// (bukan menggantung, bukan diam-diam). Yang dihitung adalah PERCOBAAN:
// pemanggilan yang gagal di server pun menghabiskan jatah, supaya loop
// retry tidak bisa membakar waktu run tanpa batas. Thread-safe (di bawah
// mu yang sama dengan field budget); ListTools TIDAK memanggil ini.
func (c *Client) reserveCall() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	if c.calls == 0 {
		c.windowStart = now
	}
	if !c.windowStart.IsZero() && !now.Before(c.windowStart.Add(c.budgetWindow)) {
		return fmt.Errorf("browser: budget browser run habis — sudah %s sejak panggilan browser pertama (maks %s per run)", c.budgetWindow, c.budgetWindow)
	}
	if c.calls >= c.maxCalls {
		return fmt.Errorf("browser: budget browser run habis — sudah %d panggilan browser (maks %d per run)", c.calls, c.maxCalls)
	}
	c.calls++
	return nil
}

// BrowserCalls mengembalikan jumlah pemanggilan tool yang sudah dihitung
// ke budget run ini (untuk test / diagnostik).
func (c *Client) BrowserCalls() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.calls
}

// Start menjalankan server MCP sebagai subproses stdio dan menyelesaikan
// handshake initialize. Fail-closed: error apa pun (command tidak ada,
// Chrome tidak ditemukan server, handshake gagal) dikembalikan apa adanya
// supaya caller bisa log jelas dan lanjut tanpa alat browser.
func (c *Client) Start(ctx context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.started {
		return nil
	}
	if c.closed {
		return fmt.Errorf("browser client sudah ditutup")
	}

	parts := strings.Fields(c.cfg.Command)
	if len(parts) == 0 {
		return fmt.Errorf("browser: command server MCP kosong")
	}
	args := []string{
		"--headless",
		"--no-usage-statistics",
		"--no-performance-crux",
		"--no-page-id-routing",
		"--chrome-arg=--no-sandbox",
		"--chrome-arg=--disable-setuid-sandbox",
	}
	if c.cfg.ChromePath != "" {
		args = append(args, "--executablePath", c.cfg.ChromePath)
	}
	if c.cfg.WorkspaceDir != "" {
		args = append(args, "--workspace", c.cfg.WorkspaceDir)
	}
	if c.cfg.ProfileDir != "" {
		args = append(args, "--user-data-dir", c.cfg.ProfileDir)
	}
	cmd := exec.CommandContext(ctx, parts[0], append(parts[1:], args...)...)
	cmd.Env = append(os.Environ(),
		"CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS=1",
		"CI=1",
	)
	// Stderr server diteruskan ke log proses supaya kegagalan Chrome/MCP
	// terlihat (server mencetak peringatan privasi ke stderr saat start —
	// itu bukan error).
	cmd.Stderr = &logWriter{}

	client := mcp.NewClient(&mcp.Implementation{Name: "webbuilder", Version: "1.0.0"}, nil)
	transport := &mcp.CommandTransport{Command: cmd}
	session, err := client.Connect(ctx, transport, nil)
	if err != nil {
		return fmt.Errorf("browser: gagal start server MCP %q: %w", c.cfg.Command, err)
	}
	c.client = client
	c.session = session
	c.cmd = cmd
	c.started = true
	slog.Info("browser: server MCP start", "command", c.cfg.Command, "workspace", c.cfg.WorkspaceDir)
	return nil
}

// Started melaporkan apakah Start sudah berhasil dipanggil.
func (c *Client) Started() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.started
}

// WorkspaceDir mengembalikan direktori --workspace server MCP (tempat
// file tool seperti screenshot boleh ditulis). Dipakai VerifyPreview
// untuk menaruh screenshot di dalam workspace sebelum pipeline
// memindahkannya ke runtime/<run-id>/screenshot-<n>.png.
func (c *Client) WorkspaceDir() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.cfg.WorkspaceDir
}

// Close menutup sesi MCP (stdin server ditutup → SIGTERM → SIGKILL bila
// membandel, oleh SDK), lalu menghapus profil Chrome run ini. Aman
// dipanggil berkali-kali dan sesudah Start gagal. Dipakai via defer di
// pipeline, termasuk saat run dibatalkan — tidak boleh ada proses
// Chrome/MCP yatim.
func (c *Client) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil
	}
	c.closed = true
	// Ukur memori Chrome SEBELUM sesi ditutup (sesudah Close, server
	// MCP + Chrome sudah mati dan /proc-nya hilang). Pengukuran TIDAK
	// PERNAH menggagalkan Close: bila tidak tersedia, dicatat -1 dan
	// run lanjut seperti biasa (lihat memory.go).
	memBytes := c.chromeMemoryBytesLocked()
	if memBytes < 0 {
		slog.Info("browser: memori Chrome akhir run tidak tersedia (proses sudah mati atau /proc tidak ada)")
	} else {
		slog.Info("browser: memori Chrome akhir run",
			"bytes", memBytes,
			"mib", memBytes/(1024*1024),
			"melebihi_512mib", memBytes > ChromeMemoryHighBytes)
	}
	var err error
	if c.session != nil {
		err = c.session.Close()
		c.session = nil
	}
	if c.cfg.ProfileDir != "" {
		if rerr := os.RemoveAll(c.cfg.ProfileDir); rerr != nil {
			slog.Warn("browser: gagal hapus profil Chrome run", "dir", c.cfg.ProfileDir, "error", rerr)
		}
	}
	if err != nil {
		return fmt.Errorf("browser: gagal tutup sesi MCP: %w", err)
	}
	return nil
}

// ListTools menanyakan tools/list ke server MCP (mentah, tanpa filter).
// Caller (handler) memfilter lewat FilterAllowlist/SpecsFromTools.
// TIDAK dihitung ke budget per run (bukan panggilan tool).
func (c *Client) ListTools(ctx context.Context) ([]*mcp.Tool, error) {
	c.mu.Lock()
	session := c.session
	started := c.started
	callTimeout := c.callTimeout
	c.mu.Unlock()
	if !started || session == nil {
		return nil, fmt.Errorf("browser: client belum start")
	}
	callCtx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	res, err := session.ListTools(callCtx, &mcp.ListToolsParams{})
	if err != nil {
		return nil, fmt.Errorf("browser: tools/list gagal: %w", err)
	}
	if res == nil {
		return nil, nil
	}
	return res.Tools, nil
}

// CallTool memanggil satu tool MCP (nama TANPA prefix browser_) dengan
// argumen JSON. Timeout 30 dtk mengikuti deadline ctx pemanggil; hasil
// di-cap 64 KiB (truncate + marker), TERMASUK jalur error tool
// (IsError). Hanya tool allowlist §5 yang boleh dipanggil; argumen "url"
// (bila ada) wajib lolos validatePreviewURL (host localhost + port
// preview yang sudah dikunci, fail-closed bila belum diketahui).
// Setiap percobaan dihitung ke budget per run (reserveCall, maks 10
// panggilan / 5 menit — ListTools tidak dihitung). Setiap percobaan
// juga dicatat ke observer (metrik /metrics) — termasuk penolakan
// allowlist/URL/budget — dengan status success/error.
func (c *Client) CallTool(ctx context.Context, name string, args map[string]interface{}) (out string, err error) {
	start := time.Now()
	defer func() { c.observeCall(name, start, err) }()
	if !IsActiveTool(name) {
		return "", fmt.Errorf("browser: tool %q tidak aktif (allowlist §5: %s)", name, strings.Join(ActiveTools, ", "))
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

// toolResultText menggabungkan semua konten teks hasil tool.
func toolResultText(res *mcp.CallToolResult) string {
	var sb strings.Builder
	for _, content := range res.Content {
		if tc, ok := content.(*mcp.TextContent); ok {
			sb.WriteString(tc.Text)
		}
	}
	if res.StructuredContent != nil && sb.Len() == 0 {
		sb.WriteString(fmt.Sprint(res.StructuredContent))
	}
	return sb.String()
}

// TruncateOutput memotong hasil tool ke MaxOutputBytes dan menandai
// pemotongan, supaya satu tool tidak menghabiskan konteks model.
func TruncateOutput(s string) string {
	if len(s) <= MaxOutputBytes {
		return s
	}
	return s[:MaxOutputBytes] + "\n...[dipotong: output melebihi 64 KiB]"
}

// ValidateURL menolak URL di luar preview proyek sendiri — cek STATIS
// saja (skema + host), TANPA port: hanya http(s) ke 127.0.0.1 atau
// localhost (atau ::1) yang lolos; semua host lain, skema lain, dan URL
// relatif ditolak. Penyempitan ke port preview proyek yang bersangkutan
// (Fase 3) ditegakkan validatePreviewURL di atas, yang memakai
// previewPort Client — ValidateURL tetap dipakai sebagai langkah pertama
// di sana dan di entry point yang belum memegang Client (RunAcceptance,
// CaptureScreenshot), supaya URL luar ditolak sebelum Client dibuat.
func ValidateURL(raw string) error {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return fmt.Errorf("browser: URL tidak valid %q: %w", raw, err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("browser: URL di luar preview ditolak (skema %q): %s", u.Scheme, raw)
	}
	host := strings.ToLower(u.Hostname())
	if host != "127.0.0.1" && host != "localhost" && host != "::1" {
		return fmt.Errorf("browser: URL di luar preview ditolak (host %q): %s", host, raw)
	}
	return nil
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// logWriter meneruskan stderr subproses MCP ke slog (tanpa buffering baris
// penuh — server mencetak sedikit).
type logWriter struct{}

func (logWriter) Write(p []byte) (int, error) {
	if msg := strings.TrimSpace(string(p)); msg != "" {
		slog.Info("browser: stderr server MCP", "msg", msg)
	}
	return len(p), nil
}

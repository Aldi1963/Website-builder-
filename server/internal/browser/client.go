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
// localhost) yang boleh dibuka — ditegakkan di ValidateURL di lapis klien,
// bukan mengandalkan model. Fail-closed: bila flag nyala tapi Chrome/MCP
// tidak tersedia, Start mengembalikan error jelas dan agent berjalan tanpa
// alat browser (lihat lifecycle.go: Enabled + NewClientForRun).
package browser

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"os/exec"
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

// CallTimeout adalah batas per panggilan tool browser.
const CallTimeout = 30 * time.Second

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
// satu goroutine pipeline (panggilan tool diserialkan dengan mutex).
type Client struct {
	mu      sync.Mutex
	cfg     Config
	client  *mcp.Client
	session *mcp.ClientSession
	cmd     *exec.Cmd
	started bool
	closed  bool
}

// NewClient membuat Client dari Config (belum start).
func NewClient(cfg Config) *Client {
	return &Client{cfg: cfg}
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
func (c *Client) ListTools(ctx context.Context) ([]*mcp.Tool, error) {
	c.mu.Lock()
	session := c.session
	started := c.started
	c.mu.Unlock()
	if !started || session == nil {
		return nil, fmt.Errorf("browser: client belum start")
	}
	callCtx, cancel := context.WithTimeout(ctx, CallTimeout)
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
// di-cap 64 KiB (truncate + marker). Hanya tool allowlist §5 yang boleh
// dipanggil; argumen "url" (bila ada) wajib lolos ValidateURL.
func (c *Client) CallTool(ctx context.Context, name string, args map[string]interface{}) (string, error) {
	if !IsActiveTool(name) {
		return "", fmt.Errorf("browser: tool %q tidak aktif (allowlist §5: %s)", name, strings.Join(ActiveTools, ", "))
	}
	if rawURL, ok := args["url"]; ok {
		if s, ok := rawURL.(string); ok && strings.TrimSpace(s) != "" {
			if err := ValidateURL(s); err != nil {
				return "", err
			}
		}
	}
	c.mu.Lock()
	session := c.session
	started := c.started
	c.mu.Unlock()
	if !started || session == nil {
		return "", fmt.Errorf("browser: client belum start")
	}
	callCtx, cancel := context.WithTimeout(ctx, CallTimeout)
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

// ValidateURL menolak URL di luar preview proyek sendiri. Hanya http(s)
// ke 127.0.0.1 atau localhost (port berapa pun — port dev server berbeda
// tiap run) yang lolos; semua host lain, skema lain, dan URL relatif
// ditolak. Penyempitan ke port preview proyek yang bersangkutan dicatat
// untuk Fase 2 (saat navigate_page diaktifkan dan port diketahui pipeline).
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

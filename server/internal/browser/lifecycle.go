package browser

import (
	"fmt"
	"os"
	"path/filepath"
)

// NewClientForRun membuat Client untuk satu agent run, dengan workspace +
// profil Chrome di bawah runDir. Fail-closed:
//   - gating mati (Enabled() false) → ErrBrowserToolsDisabled;
//   - CHROME_FOR_TESTING_PATH diset tapi path tidak ada → ErrChromeNotFound
//     (error jelas, bukan gagal diam-diam saat Start);
//   - direktori run tidak bisa dibuat → error.
//
// Client yang dikembalikan BELUM start; caller memanggil Start lalu defer
// Close(). Bila Start gagal, agent berjalan TANPA alat browser (caller
// wajib log errornya — jangan diam-diam).
func NewClientForRun(runID uint, runDir string) (*Client, error) {
	if !Enabled() {
		return nil, ErrBrowserToolsDisabled
	}
	cfg := DefaultConfig("", "")
	if cfg.ChromePath != "" {
		if _, err := os.Stat(cfg.ChromePath); err != nil {
			return nil, fmt.Errorf("%w: %s (env CHROME_FOR_TESTING_PATH)", ErrChromeNotFound, cfg.ChromePath)
		}
	}
	workspaceDir := filepath.Join(runDir, "browser")
	profileDir := filepath.Join(workspaceDir, "chrome-profile")
	if err := os.MkdirAll(workspaceDir, 0o755); err != nil {
		return nil, fmt.Errorf("browser: gagal buat direktori run %s: %w", workspaceDir, err)
	}
	cfg.WorkspaceDir = workspaceDir
	cfg.ProfileDir = profileDir
	_ = runID // runID sudah tercermin di runDir (run-<id>); disimpan di sini untuk penamaan di masa depan.
	return NewClient(cfg), nil
}

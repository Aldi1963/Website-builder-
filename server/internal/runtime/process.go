package runtime

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// cappedWriter menyimpan output sampai batas, lalu membuang sisanya dan
// menandai Truncated. Dipakai terpisah untuk stdout dan stderr supaya satu
// stream yang berisik tidak menelan stream lainnya.
type cappedWriter struct {
	buf       bytes.Buffer
	limit     int64
	truncated bool
}

func (w *cappedWriter) Write(p []byte) (int, error) {
	if w.truncated {
		return len(p), nil
	}
	remaining := w.limit - int64(w.buf.Len())
	if remaining <= 0 {
		w.truncated = true
		return len(p), nil
	}
	if int64(len(p)) > remaining {
		w.buf.Write(p[:remaining])
		w.truncated = true
		return len(p), nil
	}
	w.buf.Write(p)
	return len(p), nil
}

func (w *cappedWriter) String() string { return w.buf.String() }

// ProcessExecutor mengeksekusi perintah tenant sebagai proses OS anak dengan:
//   - timeout via context (proses + seluruh grup prosesnya dibunuh SIGKILL),
//   - environment yang di-scrub (lihat env.go),
//   - working directory wajib di bawah Config.BaseDir,
//   - capture stdout/stderr dengan batas ukuran.
//
// Ini BUKAN sandbox kernel (tidak ada namespace/cgroup/seccomp). Ia membatasi
// permukaan yang paling gampang dieksploitasi (secret bocor, proses menggantung
// selamanya, output membanjiri memori, akses file di luar workspace), tetapi
// proses anak masih berbagi kernel dan UID dengan server. Untuk isolasi yang
// lebih kuat, pakai DockerExecutor bila daemon tersedia.
type ProcessExecutor struct {
	cfg Config
}

// NewProcessExecutor membuat executor proses dengan konfigurasi yang diberikan.
// Config kosong (nol) diganti DefaultConfig.
func NewProcessExecutor(cfg Config) *ProcessExecutor {
	if cfg.BaseDir == "" {
		cfg = DefaultConfig()
	}
	if cfg.DefaultTimeout <= 0 {
		cfg.DefaultTimeout = DefaultConfig().DefaultTimeout
	}
	if cfg.MaxOutputBytes <= 0 {
		cfg.MaxOutputBytes = DefaultConfig().MaxOutputBytes
	}
	return &ProcessExecutor{cfg: cfg}
}

func (e *ProcessExecutor) Name() string { return "process" }

// Available selalu true: exec proses OS selalu bisa dipakai di host ini.
// (Yang mengunci adalah flag eksekusi tenant, bukan ketersediaan backend.)
func (e *ProcessExecutor) Available() bool { return true }

// resolveDir memvalidasi/menyiapkan working directory. Dir kosong berarti
// buat direktori sementara baru di bawah BaseDir. Dir yang diberikan harus
// absolut dan berada di bawah BaseDir (menolak traversal ".." dan symlink
// escape lewat EvalSymlinks pada BaseDir).
func (e *ProcessExecutor) resolveDir(dir string) (string, bool, error) {
	base, err := filepath.Abs(e.cfg.BaseDir)
	if err != nil {
		return "", false, err
	}
	if err := os.MkdirAll(base, 0755); err != nil {
		return "", false, err
	}
	// EvalSymlinks pada base supaya perbandingan tidak bisa diakali symlink.
	if real, err := filepath.EvalSymlinks(base); err == nil {
		base = real
	}
	if dir == "" {
		tmp, err := os.MkdirTemp(base, "exec-")
		if err != nil {
			return "", false, err
		}
		return tmp, true, nil
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return "", false, err
	}
	if real, err := filepath.EvalSymlinks(abs); err == nil {
		abs = real
	} else if !os.IsNotExist(err) {
		return "", false, err
	}
	rel, err := filepath.Rel(base, abs)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return "", false, fmt.Errorf("working directory %q berada di luar sandbox base %q", dir, e.cfg.BaseDir)
	}
	if err := os.MkdirAll(abs, 0755); err != nil {
		return "", false, err
	}
	return abs, false, nil
}

func (e *ProcessExecutor) Run(ctx context.Context, cmd Command) (Result, error) {
	if !Enabled() {
		return Result{ExitCode: -1}, ErrTenantExecDisabled
	}
	if strings.TrimSpace(cmd.Name) == "" {
		return Result{ExitCode: -1}, errors.New("command name kosong")
	}
	timeout := cmd.Timeout
	if timeout <= 0 {
		timeout = e.cfg.DefaultTimeout
	}
	dir, tempDir, err := e.resolveDir(cmd.Dir)
	if err != nil {
		return Result{ExitCode: -1}, err
	}
	if tempDir {
		defer os.RemoveAll(dir)
	}

	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	start := time.Now()
	execCmd := exec.CommandContext(ctx, cmd.Name, cmd.Args...)
	execCmd.Dir = dir
	execCmd.Env = scrubEnv(cmd.Env)
	// Setpgid: proses anak jadi leader grup prosesnya sendiri, supaya saat
	// timeout kita bisa membunuh seluruh pohon proses (cucu yang di-spawn
	// shell/npm), bukan hanya proses langsung.
	execCmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	// Cancel dipanggil CommandContext saat ctx habis: bunuh grup, bukan
	// hanya proses utama. Tanpa ini, cucu (mis. vite/node) bisa hidup terus.
	execCmd.Cancel = func() error {
		if execCmd.Process != nil {
			_ = syscall.Kill(-execCmd.Process.Pid, syscall.SIGKILL)
		}
		return nil
	}
	stdout := &cappedWriter{limit: e.cfg.MaxOutputBytes}
	stderr := &cappedWriter{limit: e.cfg.MaxOutputBytes}
	execCmd.Stdout = stdout
	execCmd.Stderr = stderr

	runErr := execCmd.Run()
	dur := time.Since(start)

	res := Result{
		ExitCode:  -1,
		Stdout:    stdout.String(),
		Stderr:    stderr.String(),
		Truncated: stdout.truncated || stderr.truncated,
		Duration:  dur,
	}
	if execCmd.ProcessState != nil {
		res.ExitCode = execCmd.ProcessState.ExitCode()
	}
	if ctx.Err() == context.DeadlineExceeded {
		res.TimedOut = true
		// Pastikan grup proses benar-benar mati walau Cancel sudah dipanggil.
		if execCmd.Process != nil {
			_ = syscall.Kill(-execCmd.Process.Pid, syscall.SIGKILL)
		}
		return res, fmt.Errorf("command %q melewati batas waktu %s", cmd.Name, timeout)
	}
	if runErr != nil {
		// Kegagalan start (binary tidak ada) vs exit code non-nol: keduanya
		// dilaporkan sebagai error, tapi Result tetap membawa outputnya.
		var exitErr *exec.ExitError
		if errors.As(runErr, &exitErr) {
			return res, fmt.Errorf("command %q keluar dengan status %d: %s", cmd.Name, res.ExitCode, strings.TrimSpace(res.Stderr))
		}
		return res, runErr
	}
	// Sukses.
	return res, nil
}

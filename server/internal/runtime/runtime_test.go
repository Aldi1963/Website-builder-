package runtime

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testConfig(t *testing.T) Config {
	t.Helper()
	return Config{
		BaseDir:        t.TempDir(),
		DefaultTimeout: 5 * time.Second,
		MaxOutputBytes: 1 << 20,
	}
}

// (a) Eksekusi default MATI tanpa flag.
func TestTenantExecDisabledByDefault(t *testing.T) {
	t.Setenv(EnableTenantExecEnv, "")
	ex := NewProcessExecutor(testConfig(t))
	_, err := ex.Run(context.Background(), Command{Name: "echo", Args: []string{"hi"}})
	if !errors.Is(err, ErrTenantExecDisabled) {
		t.Fatalf("tanpa flag, Run harus ErrTenantExecDisabled, dapat %v", err)
	}
	if Enabled() {
		t.Fatal("Enabled() harus false tanpa flag")
	}
}

func TestTenantExecEnabledOnlyByExactOne(t *testing.T) {
	for _, v := range []string{"true", "yes", "on", "TRUE", " 1", "01"} {
		t.Setenv(EnableTenantExecEnv, v)
		if Enabled() {
			t.Fatalf("nilai %q tidak boleh menyalakan eksekusi tenant", v)
		}
	}
	t.Setenv(EnableTenantExecEnv, "1")
	if !Enabled() {
		t.Fatal("nilai \"1\" harus menyalakan eksekusi tenant")
	}
}

func TestProcessExecutorEcho(t *testing.T) {
	t.Setenv(EnableTenantExecEnv, "1")
	ex := NewProcessExecutor(testConfig(t))
	res, err := ex.Run(context.Background(), Command{Name: "echo", Args: []string{"hello"}})
	if err != nil {
		t.Fatalf("echo gagal: %v", err)
	}
	if res.ExitCode != 0 || strings.TrimSpace(res.Stdout) != "hello" {
		t.Fatalf("hasil echo salah: %+v", res)
	}
	if res.TimedOut || res.Truncated {
		t.Fatalf("echo tidak boleh timeout/truncated: %+v", res)
	}
}

// (b) Perintah yang melewati batas waktu benar-benar dibunuh.
func TestProcessExecutorTimeoutKillsProcess(t *testing.T) {
	t.Setenv(EnableTenantExecEnv, "1")
	ex := NewProcessExecutor(testConfig(t))
	start := time.Now()
	res, err := ex.Run(context.Background(), Command{Name: "sleep", Args: []string{"30"}, Timeout: 300 * time.Millisecond})
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("sleep 30 dengan timeout 300ms harus mengembalikan error")
	}
	if !res.TimedOut {
		t.Fatalf("TimedOut harus true, dapat %+v", res)
	}
	if elapsed > 5*time.Second {
		t.Fatalf("proses tidak dibunuh tepat waktu: elapsed=%s", elapsed)
	}
}

// (b2) Grup proses ikut dibunuh: shell yang men-spawn sleep tidak boleh
// meninggalkan cucu yang hidup.
func TestProcessExecutorTimeoutKillsProcessGroup(t *testing.T) {
	t.Setenv(EnableTenantExecEnv, "1")
	ex := NewProcessExecutor(testConfig(t))
	start := time.Now()
	res, err := ex.Run(context.Background(), Command{
		Name: "sh", Args: []string{"-c", "sleep 30 & wait"}, Timeout: 300 * time.Millisecond,
	})
	elapsed := time.Since(start)
	if err == nil || !res.TimedOut {
		t.Fatalf("sh+sleep harus timeout, err=%v res=%+v", err, res)
	}
	if elapsed > 5*time.Second {
		t.Fatalf("grup proses tidak dibunuh tepat waktu: elapsed=%s", elapsed)
	}
}

// (c) Secret dari environment host tidak bocor ke proses anak.
func TestProcessExecutorEnvScrub(t *testing.T) {
	t.Setenv(EnableTenantExecEnv, "1")
	// Variabel dummy yang menyerupai secret nyata.
	t.Setenv("JWT_SECRET", "dummy-jwt-secret-12345")
	t.Setenv("OPENAI_API_KEY", "sk-dummy-openai-key-67890")
	t.Setenv("DB_PASSWORD", "dummy-db-password")
	t.Setenv("WEBBUILDER_INTERNAL_TOKEN", "dummy-internal")
	ex := NewProcessExecutor(testConfig(t))
	res, err := ex.Run(context.Background(), Command{Name: "env"})
	if err != nil {
		t.Fatalf("env gagal: %v", err)
	}
	for _, secret := range []string{"dummy-jwt-secret-12345", "sk-dummy-openai-key-67890", "dummy-db-password", "dummy-internal"} {
		if strings.Contains(res.Stdout, secret) {
			t.Fatalf("secret bocor ke proses anak: %q ditemukan di output", secret)
		}
	}
	if !strings.Contains(res.Stdout, "PATH=") {
		t.Fatalf("PATH (allowlist) harus diteruskan, output: %q", res.Stdout)
	}
}

// Variabel tambahan yang tidak di-allowlist dibuang; VITE_* (publik) lolos.
func TestProcessExecutorExtraEnvAllowlist(t *testing.T) {
	t.Setenv(EnableTenantExecEnv, "1")
	ex := NewProcessExecutor(testConfig(t))
	res, err := ex.Run(context.Background(), Command{
		Name: "env",
		Env: map[string]string{
			"MY_API_KEY":        "harus-dibuang",
			"VITE_APP_NAME":     "Aplikasi Uji",
			"VITE_API_BASE_URL": "http://localhost:18082",
			"WEBBUILDER_EVIL":   "harus-dibuang",
		},
	})
	if err != nil {
		t.Fatalf("env gagal: %v", err)
	}
	if strings.Contains(res.Stdout, "harus-dibuang") {
		t.Fatalf("variabel non-allowlist bocor: %q", res.Stdout)
	}
	if !strings.Contains(res.Stdout, "VITE_APP_NAME=Aplikasi Uji") {
		t.Fatalf("VITE_APP_NAME harus diteruskan, output: %q", res.Stdout)
	}
}

// Output yang melebihi batas dipotong dan ditandai.
func TestProcessExecutorOutputCap(t *testing.T) {
	t.Setenv(EnableTenantExecEnv, "1")
	cfg := testConfig(t)
	cfg.MaxOutputBytes = 1024
	ex := NewProcessExecutor(cfg)
	res, err := ex.Run(context.Background(), Command{
		Name: "sh", Args: []string{"-c", "head -c 100000 /dev/zero | tr '\\0' 'x'"},
	})
	if err != nil {
		t.Fatalf("sh gagal: %v", err)
	}
	if !res.Truncated {
		t.Fatal("output 100KB dengan batas 1KB harus Truncated")
	}
	if len(res.Stdout) > 1024 {
		t.Fatalf("stdout melebihi batas: %d byte", len(res.Stdout))
	}
}

// Working directory di luar BaseDir ditolak.
func TestProcessExecutorDirEscapeRejected(t *testing.T) {
	t.Setenv(EnableTenantExecEnv, "1")
	cfg := testConfig(t)
	ex := NewProcessExecutor(cfg)
	outside := filepath.Join(os.TempDir(), "webbuilder-escape-test")
	_, err := ex.Run(context.Background(), Command{Name: "echo", Args: []string{"hi"}, Dir: outside})
	if err == nil {
		t.Fatalf("Dir di luar BaseDir (%q) harus ditolak", outside)
	}
}

// Binary yang tidak ada dilaporkan sebagai error, bukan panic.
func TestProcessExecutorMissingBinary(t *testing.T) {
	t.Setenv(EnableTenantExecEnv, "1")
	ex := NewProcessExecutor(testConfig(t))
	_, err := ex.Run(context.Background(), Command{Name: "webbuilder-binary-yang-tidak-ada-xyz"})
	if err == nil {
		t.Fatal("binary tidak ada harus mengembalikan error")
	}
}

// Docker: di VM ini docker tidak tersedia — adapter harus jujur soal itu.
func TestDockerExecutorUnavailableWithoutDaemon(t *testing.T) {
	t.Setenv(EnableTenantExecEnv, "1")
	d := NewDockerExecutor(testConfig(t), "")
	if d.Available() {
		t.Skip("docker ternyata tersedia di host ini; lewati asersi unavailable")
	}
	_, err := d.Run(context.Background(), Command{Name: "echo", Args: []string{"hi"}})
	if !errors.Is(err, ErrDockerUnavailable) {
		t.Fatalf("tanpa docker, Run harus ErrDockerUnavailable, dapat %v", err)
	}
}

func TestDockerExecutorStillNeedsFlag(t *testing.T) {
	t.Setenv(EnableTenantExecEnv, "")
	d := NewDockerExecutor(testConfig(t), "")
	_, err := d.Run(context.Background(), Command{Name: "echo", Args: []string{"hi"}})
	if !errors.Is(err, ErrTenantExecDisabled) {
		t.Fatalf("tanpa flag, Docker Run harus ErrTenantExecDisabled, dapat %v", err)
	}
}

func TestDefaultExecutorFallsBackToProcess(t *testing.T) {
	ex := DefaultExecutor(testConfig(t))
	if ex.Name() != "process" && ex.Name() != "docker" {
		t.Fatalf("nama executor tak dikenal: %q", ex.Name())
	}
}

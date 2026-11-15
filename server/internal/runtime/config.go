package runtime

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

// Nama flag env yang menyalakan eksekusi tenant. Nilai lain apa pun (termasuk
// "true"/"yes") dianggap MATI — hanya "1" yang menyalakan, supaya tidak ada
// ambiguitas.
const EnableTenantExecEnv = "WEBBUILDER_ENABLE_TENANT_EXEC"

// ErrTenantExecDisabled dikembalikan setiap kali ada yang mencoba mengeksekusi
// kode tenant sementara flag belum dinyalakan. Fail-closed: tanpa flag,
// tidak ada jalan untuk menjalankan kode tenant lewat paket ini.
var ErrTenantExecDisabled = errors.New("tenant execution is disabled (set WEBBUILDER_ENABLE_TENANT_EXEC=1 to enable)")

// Config adalah konfigurasi bersama semua Executor.
type Config struct {
	// BaseDir adalah direktori induk semua working directory tenant.
	// Setiap Command.Dir harus berada di bawah BaseDir. Bila kosong,
	// dipakai "runtime/sandbox" relatif terhadap working directory server.
	BaseDir string

	// DefaultTimeout adalah batas waktu eksekusi bila Command.Timeout nol.
	DefaultTimeout time.Duration

	// MaxOutputBytes adalah batas total byte stdout+stderr yang disimpan
	// per eksekusi. Kelebihan dipotong (Truncated=true pada Result).
	MaxOutputBytes int64
}

// DefaultConfig mengembalikan konfigurasi aman untuk dipakai langsung.
func DefaultConfig() Config {
	return Config{
		BaseDir:        filepath.Join("..", "runtime", "sandbox"),
		DefaultTimeout: 60 * time.Second,
		MaxOutputBytes: 1 << 20, // 1 MiB
	}
}

// Enabled melaporkan apakah eksekusi tenant diizinkan di proses ini.
// Membaca env setiap kali dipanggil supaya perubahan env (mis. di test)
// langsung berlaku; nilai yang diterima hanya "1".
func Enabled() bool {
	return os.Getenv(EnableTenantExecEnv) == "1"
}

// TimeoutSecondsEnv adalah nama env opsional untuk mengubah timeout default
// (detik). Bila tidak diset atau tidak valid, dipakai DefaultConfig.
func (c Config) WithEnvOverrides() Config {
	if v := os.Getenv("WEBBUILDER_TENANT_EXEC_TIMEOUT_SECONDS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			c.DefaultTimeout = time.Duration(n) * time.Second
		}
	}
	if v := os.Getenv("WEBBUILDER_TENANT_EXEC_MAX_OUTPUT_BYTES"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > 0 {
			c.MaxOutputBytes = n
		}
	}
	return c
}

// Command adalah satu perintah tenant yang akan dieksekusi.
type Command struct {
	// Name adalah nama binary (dicari via PATH yang di-scrub) atau path absolut.
	Name string
	// Args adalah argumen perintah.
	Args []string
	// Dir adalah working directory; harus berada di bawah Config.BaseDir.
	// Bila kosong, Executor membuat direktori sementara di bawah BaseDir.
	Dir string
	// Env adalah variabel tambahan (key=value) yang diminta caller.
	// Hanya key yang lolos allowlist yang diteruskan; sisanya dibuang diam-diam.
	Env map[string]string
	// Timeout membatasi durasi eksekusi; nol berarti Config.DefaultTimeout.
	Timeout time.Duration
}

// Result adalah hasil satu eksekusi.
type Result struct {
	// ExitCode adalah kode keluar proses (-1 bila tidak sempat start / dibunuh).
	ExitCode int
	// Stdout dan Stderr adalah output yang tertangkap, dipotong di batas.
	Stdout string
	Stderr string
	// Truncated true bila output melebihi batas dan dipotong.
	Truncated bool
	// TimedOut true bila proses dibunuh karena melewati batas waktu.
	TimedOut bool
	// Duration adalah durasi eksekusi.
	Duration time.Duration
}

// Executor adalah adapter eksekusi kode tenant. Implementasi WAJIB
// fail-closed: Run mengembalikan ErrTenantExecDisabled bila eksekusi tenant
// tidak diizinkan (flag mati atau backend tidak tersedia).
type Executor interface {
	// Name adalah nama adapter ("process", "docker", ...), untuk log/metrics.
	Name() string
	// Available melaporkan apakah backend adapter ini bisa dipakai di host ini.
	Available() bool
	// Run mengeksekusi cmd dan mengembalikan hasilnya. ctx boleh membawa
	// deadline sendiri; timeout efektif adalah yang lebih dulu habis antara
	// ctx dan cmd.Timeout.
	Run(ctx context.Context, cmd Command) (Result, error)
}

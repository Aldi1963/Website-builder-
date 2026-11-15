package runtime

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

// DockerExecutor menjalankan perintah tenant di dalam container Docker/OCI.
//
// Status di VM ini (2026-11-15): docker TIDAK tersedia — binary `docker`
// tidak ada dan tidak ada daemon. Karena itu Available() mengembalikan false
// dan Run() selalu gagal dengan error yang jelas. Adapter ini tetap disediakan
// supaya wiring-nya sudah ada: begitu daemon terpasang, DefaultExecutor bisa
// memilih adapter ini tanpa mengubah call site.
//
// Syarat mengaktifkan adapter ini di host:
//  1. Docker Engine / daemon berjalan dan user server ada di grup `docker`
//     (atau DOCKER_HOST menunjuk daemon remote yang sudah diautentikasi).
//  2. Image yang dipakai sudah di-pull sebelumnya (default node:20-alpine)
//     — container tidak boleh menarik image arbitrer dari registry saat
//     eksekusi tenant.
//  3. Flag WEBBUILDER_ENABLE_TENANT_EXEC=1 tetap wajib; Docker bukan
//     jalan pintas melewati flag tersebut.
//  4. Daemon harus dikonfigurasi dengan user namespace remapping atau
//     rootless mode untuk isolasi UID yang sesungguhnya; tanpa itu,
//     proses di container masih berjalan sebagai root host bila image
//     dijalankan sebagai root — adapter ini memaksa --user 65534:65534
//     (nobody) sebagai pertahanan.
//
// Hardening yang diterapkan saat container dijalankan:
// --network=none (tanpa jaringan), --read-only (rootfs read-only),
// --tmpfs /tmp (satu-satunya tempat tulis selain workdir),
// --memory/--cpus/--pids-limit (batas resource), --user nobody,
// dan environment yang di-scrub sama seperti ProcessExecutor.
type DockerExecutor struct {
	cfg   Config
	image string
}

// NewDockerExecutor membuat adapter Docker. image kosong berarti
// "node:20-alpine".
func NewDockerExecutor(cfg Config, image string) *DockerExecutor {
	if cfg.BaseDir == "" {
		cfg = DefaultConfig()
	}
	if image == "" {
		image = "node:20-alpine"
	}
	return &DockerExecutor{cfg: cfg, image: image}
}

func (e *DockerExecutor) Name() string { return "docker" }

// Available memeriksa apakah daemon docker benar-benar bisa dipakai:
// binary ada DAN `docker info` berhasil dalam 5 detik. Pemeriksaan ini
// sengaja tidak di-cache: daemon bisa mati/hidup selama proses berjalan.
func (e *DockerExecutor) Available() bool {
	if _, err := exec.LookPath("docker"); err != nil {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "docker", "info")
	// `docker info` tidak butuh argumen rahasia; outputnya dibuang.
	if err := cmd.Run(); err != nil {
		return false
	}
	return true
}

// ErrDockerUnavailable menjelaskan kenapa adapter Docker tidak bisa dipakai.
var ErrDockerUnavailable = errors.New("docker tidak tersedia di host ini (binary/daemon tidak ditemukan); pasang Docker Engine dan pastikan `docker info` berhasil, atau pakai ProcessExecutor")

func (e *DockerExecutor) Run(ctx context.Context, cmd Command) (Result, error) {
	if !Enabled() {
		return Result{ExitCode: -1}, ErrTenantExecDisabled
	}
	if !e.Available() {
		return Result{ExitCode: -1}, ErrDockerUnavailable
	}
	timeout := cmd.Timeout
	if timeout <= 0 {
		timeout = e.cfg.DefaultTimeout
	}
	// Working directory tetap diselesaikan lewat aturan yang sama dengan
	// ProcessExecutor (harus di bawah BaseDir).
	pe := NewProcessExecutor(e.cfg)
	dir, tempDir, err := pe.resolveDir(cmd.Dir)
	if err != nil {
		return Result{ExitCode: -1}, err
	}
	if tempDir {
		defer func() {
			// Direktori sementara dihapus setelah container selesai.
			_ = os.RemoveAll(dir)
		}()
	}

	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	args := []string{"run", "--rm",
		"--network=none",
		"--read-only",
		"--tmpfs", "/tmp",
		"--memory=512m",
		"--cpus=1.0",
		"--pids-limit=128",
		"--user=65534:65534",
		"--workdir=/work",
		"-v", dir + ":/work",
	}
	for _, kv := range scrubEnv(cmd.Env) {
		args = append(args, "-e", kv)
	}
	args = append(args, e.image, cmd.Name)
	args = append(args, cmd.Args...)

	start := time.Now()
	execCmd := exec.CommandContext(ctx, "docker", args...)
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
		return res, fmt.Errorf("docker run %q melewati batas waktu %s", cmd.Name, timeout)
	}
	if runErr != nil {
		var exitErr *exec.ExitError
		if errors.As(runErr, &exitErr) {
			return res, fmt.Errorf("docker run %q keluar dengan status %d: %s", cmd.Name, res.ExitCode, strings.TrimSpace(res.Stderr))
		}
		return res, runErr
	}
	return res, nil
}

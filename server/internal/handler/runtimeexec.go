// runtimeexec.go — jembatan runtime preview lama ke adapter isolasi
// (server/internal/runtime/).
//
// Satu-shot eksekusi tenant (install/build/verify/pipeline + `npm run build`
// tool agent) lewat runtimeRun: bila flag WEBBUILDER_ENABLE_TENANT_EXEC=1,
// perintah dijalankan adapter isolasi (ProcessExecutor, atau DockerExecutor
// bila daemon tersedia); bila flag mati, runtimeRun memakai jalur lama
// persis seperti sebelum migrasi (os.Environ() penuh, tanpa batas output).
//
// Yang SENGAJA TIDAK dimigrasi (lihat docs/isolation.md):
//   - dev server (runtimeDevStart/Stop): proses long-running dengan restart
//     loop + log streaming — adapter saat ini one-shot (Run) dan tidak punya
//     Start/Stop. Memaksanya ke Run akan merusak desain adapter.
//   - screenshot (runtimeCaptureScreenshot) + browserAcceptance: menjalankan
//     skrip milik server (playwright-core), bukan kode tenant — tidak ada
//     manfaat keamanan dari migrasi, dan path Chromium/playwright-nya sudah
//     rapuh antar host.
//   - customdomain.go (ssh infra) + payment.go (binary clipkupay): bukan
//     kode tenant.
package handler

import (
	"context"
	"path/filepath"
	"strings"
	"sync"
	"time"

	tenantRuntime "webbuilder/internal/runtime"
)

// tenantExecBaseDir adalah BaseDir adapter isolasi: induk dari
// projectRuntimeRoot ("../runtime/project-<id>"). Diubah hanya oleh test
// (CWD test = server/internal/handler, jadi default "../runtime" menunjuk
// ke server/internal/runtime — test yang memakai runtimeRun wajib
// mengesetnya ke t.TempDir() dan mereset executor lewat resetTenantExecutor).
var tenantExecBaseDir = filepath.Join("..", "runtime")

var (
	tenantExecutorOnce   sync.Once
	tenantExecutorCached tenantRuntime.Executor
)

// tenantExecutor membangun (sekali, di-cache) executor tenant dari
// runtime.DefaultExecutor: Docker bila daemon benar-benar ada, kalau tidak
// ProcessExecutor. Pemilihan adapter TIDAK melewati flag eksekusi tenant —
// Run() tetap menolak bila flag mati. Cache penting karena pengecekan
// ketersediaan Docker (`docker info`, sampai 5 detik) tidak boleh dibayar
// di setiap install/build.
func tenantExecutor() tenantRuntime.Executor {
	tenantExecutorOnce.Do(func() {
		cfg := tenantRuntime.Config{
			BaseDir:        tenantExecBaseDir,
			DefaultTimeout: 60 * time.Second,
			MaxOutputBytes: 1 << 20, // 1 MiB per stream
		}.WithEnvOverrides()
		tenantExecutorCached = tenantRuntime.DefaultExecutor(cfg)
	})
	return tenantExecutorCached
}

// resetTenantExecutor mengembalikan executor tenant ke keadaan awal.
// Dipakai test agar tiap test bisa memakai BaseDir-nya sendiri; jangan
// dipakai di luar test.
func resetTenantExecutor() {
	tenantExecutorOnce = sync.Once{}
	tenantExecutorCached = nil
	tenantExecBaseDir = filepath.Join("..", "runtime")
}

// tenantExecEnv adalah variabel tambahan yang selalu diminta untuk eksekusi
// tenant — sama seperti jalur lama (runtimeRun): CI=1 + npm_config_*.
// Semuanya ada di allowlist adapter (lihat runtime/env.go), jadi diteruskan;
// variabel host lain tetap di-scrub.
func tenantExecEnv() map[string]string {
	return map[string]string{
		"CI":                          "1",
		"npm_config_fund":             "false",
		"npm_config_audit":            "false",
		"npm_config_legacy_peer_deps": "true",
	}
}

// runtimeRunIsolated menjalankan satu perintah tenant lewat adapter isolasi.
// Timeout diambil dari deadline ctx pemanggil (yang dipakai jalur lama
// selama ini: install 4 mnt, build 3 mnt, pipeline/verify 7 mnt, run_build
// 5 mnt) — adapter memakai yang lebih dulu habis antara ctx dan timeout
// ini, jadi perilaku batas waktu tidak lebih ketat dari sebelumnya. Bila
// ctx tidak punya deadline, dipakai 5 menit sebagai batas atas.
//
// Perbedaan hasil dibanding jalur lama (sengaja, dan aman bagi pemanggil):
//   - output = stdout + stderr digabung (jalur lama: CombinedOutput yang
//     ter-interleave). Isi sama, urutan antar-stream bisa berbeda —
//     diagnostik (pencocokan substring) dan tampilan tidak terpengaruh.
//   - error non-nol membawa pesan "command ... keluar dengan status N: ..."
//     (jalur lama: "exit status N"). Pemanggil hanya memeriksa err != nil
//     dan menampilkan pesannya, jadi lebih informatif tanpa merusak logika.
//   - output tiap stream dibatasi MaxOutputBytes (default 1 MiB) dan
//     dipotong — jalur lama tanpa batas. Pemanggil yang memotong output
//     sendiri (mis. run_build, 12000 byte terakhir) tetap jalan.
func runtimeRunIsolated(ctx context.Context, dir string, command string, args ...string) (string, int, error) {
	timeout := 5 * time.Minute
	if deadline, ok := ctx.Deadline(); ok {
		timeout = time.Until(deadline)
		if timeout < time.Second {
			timeout = time.Second
		}
	}
	res, err := tenantExecutor().Run(ctx, tenantRuntime.Command{
		Name:    command,
		Args:    args,
		Dir:     dir,
		Env:     tenantExecEnv(),
		Timeout: timeout,
	})
	return combineRuntimeOutput(res.Stdout, res.Stderr), res.ExitCode, err
}

// combineRuntimeOutput menggabungkan stdout dan stderr hasil adapter menjadi
// satu string seperti CombinedOutput jalur lama. Bagian yang kosong dilewati
// supaya tidak ada baris kosong di depan/belakang.
func combineRuntimeOutput(stdout, stderr string) string {
	parts := []string{}
	if strings.TrimSpace(stdout) != "" {
		parts = append(parts, strings.TrimRight(stdout, "\n"))
	}
	if strings.TrimSpace(stderr) != "" {
		parts = append(parts, strings.TrimRight(stderr, "\n"))
	}
	return strings.Join(parts, "\n")
}

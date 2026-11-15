// Tes migrasi runtime preview ke adapter isolasi (server/internal/runtime).
//
// Prinsip: flag WEBBUILDER_ENABLE_TENANT_EXEC mati -> runtimeRun memakai
// jalur lama persis seperti sebelum migrasi (os.Environ() penuh, tanpa batas
// output); flag nyala ("1") -> perintah satu-shot lewat adapter isolasi
// (ProcessExecutor di VM ini; DockerExecutor tidak tersedia).
// Test memakai proyek palsu (script node -e, tanpa network) supaya cepat
// dan deterministik, plus satu test build vite nyata (lewat proxy yang
// di-scrub) untuk membuktikan install+build sungguhan jalan dengan flag nyala.
package handler

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"webbuilder/internal/database/models"
)

// resetTenantExecutorForTest mengeset BaseDir executor tenant + mereset
// cache executor, lalu mengembalikan semuanya sesudah test. Wajib dipanggil
// tiap test yang menyentuh runtimeRun, karena executor di-cache (sync.Once)
// dan BaseDir default "../runtime" menunjuk ke server/internal/runtime dari
// CWD test.
func resetTenantExecutorForTest(t *testing.T, baseDir string) {
	t.Helper()
	tenantExecBaseDir = baseDir
	tenantExecutorOnce = sync.Once{}
	tenantExecutorCached = nil
	t.Cleanup(func() {
		tenantExecutorOnce = sync.Once{}
		tenantExecutorCached = nil
		tenantExecBaseDir = filepath.Join("..", "runtime")
	})
}

// fakeTenantProject membuat direktori proyek palsu dengan package.json yang
// script build-nya menjalankan node -e (tanpa dependensi, tanpa network).
func fakeTenantProject(t *testing.T, dir, buildJS string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatalf("mkdir proyek palsu: %v", err)
	}
	manifest := map[string]interface{}{
		"name":    "uji",
		"private": true,
		"version": "0.0.0",
		"type":    "module",
		"scripts": map[string]interface{}{"build": "node -e " + strconv.Quote(buildJS)},
	}
	raw, _ := json.Marshal(manifest)
	if err := os.WriteFile(filepath.Join(dir, "package.json"), raw, 0644); err != nil {
		t.Fatalf("tulis package.json palsu: %v", err)
	}
}

// Flag MATI -> jalur lama: proses anak mewarisi os.Environ() penuh, jadi
// secret dummy dari environment test TERLIHAT di output. Ini perilaku lama
// yang sengaja dipertahankan (bukan kebocoran baru).
func TestRuntimeRunFlagOffUsesLegacyPath(t *testing.T) {
	base := t.TempDir()
	resetTenantExecutorForTest(t, base)
	t.Setenv("WEBBUILDER_ENABLE_TENANT_EXEC", "")
	t.Setenv("JWT_SECRET", "dummy-jwt-secret-legacy-12345")
	dir := filepath.Join(base, "proj-off")
	fakeTenantProject(t, dir, "console.log('built-ok'); console.log('secret=' + (process.env.JWT_SECRET || 'absent'))")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	out, code, err := runtimeRun(ctx, dir, "npm", "run", "build")
	if err != nil || code != 0 {
		t.Fatalf("flag mati: build palsu harus sukses, code=%d err=%v out=%q", code, err, out)
	}
	if !strings.Contains(out, "built-ok") {
		t.Fatalf("flag mati: output harus memuat 'built-ok', dapat %q", out)
	}
	if !strings.Contains(out, "dummy-jwt-secret-legacy-12345") {
		t.Fatalf("flag mati: jalur lama harus mewarisi JWT_SECRET, output %q", out)
	}
}

// Flag NYALA -> adapter isolasi: secret dari environment host TIDAK BOLEH
// bocor ke proses anak, dan build tetap berhasil dengan output yang sama.
func TestRuntimeRunFlagOnScrubsSecrets(t *testing.T) {
	base := t.TempDir()
	resetTenantExecutorForTest(t, base)
	t.Setenv("WEBBUILDER_ENABLE_TENANT_EXEC", "1")
	t.Setenv("JWT_SECRET", "dummy-jwt-secret-isolated-67890")
	t.Setenv("OPENAI_API_KEY", "sk-dummy-isolated-abcde")
	dir := filepath.Join(base, "proj-on")
	fakeTenantProject(t, dir, "console.log('built-ok'); console.log('secret=' + (process.env.JWT_SECRET || 'absent')); console.log('key=' + (process.env.OPENAI_API_KEY || 'absent'))")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	out, code, err := runtimeRun(ctx, dir, "npm", "run", "build")
	if err != nil || code != 0 {
		t.Fatalf("flag nyala: build palsu harus sukses, code=%d err=%v out=%q", code, err, out)
	}
	if !strings.Contains(out, "built-ok") || !strings.Contains(out, "secret=absent") || !strings.Contains(out, "key=absent") {
		t.Fatalf("flag nyala: secret harus di-scrub, output %q", out)
	}
	for _, leaked := range []string{"dummy-jwt-secret-isolated-67890", "sk-dummy-isolated-abcde"} {
		if strings.Contains(out, leaked) {
			t.Fatalf("flag nyala: secret bocor ke output: %q", leaked)
		}
	}
}

// Flag NYALA + batas output kecil -> output dipotong dan ditandai (bagian
// akhir hilang), bukan dibiarkan membanjiri memori seperti jalur lama.
func TestRuntimeRunFlagOnOutputCap(t *testing.T) {
	base := t.TempDir()
	resetTenantExecutorForTest(t, base)
	t.Setenv("WEBBUILDER_ENABLE_TENANT_EXEC", "1")
	t.Setenv("WEBBUILDER_TENANT_EXEC_MAX_OUTPUT_BYTES", "1024")
	dir := filepath.Join(base, "proj-cap")
	// 100 KB 'x' lalu marker di akhir: bila dipotong, marker tidak sampai.
	// Marker dirangkai ('TAIL-' + 'MARKER') supaya tidak muncul di echo
	// perintah npm sendiri ("node -e ..."), yang ikut tertangkap di stderr.
	fakeTenantProject(t, dir, "process.stdout.write('x'.repeat(100000)); console.log('TAIL-' + 'MARKER')")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	out, code, err := runtimeRun(ctx, dir, "npm", "run", "build")
	if err != nil || code != 0 {
		t.Fatalf("flag nyala + cap: build harus sukses, code=%d err=%v", code, err)
	}
	if len(out) > 2048 {
		t.Fatalf("flag nyala + cap 1KB: output harus dipotong (<=2048 byte), dapat %d byte", len(out))
	}
	if strings.Contains(out, "TAIL-MARKER") {
		t.Fatalf("flag nyala + cap 1KB: marker akhir tidak boleh sampai (output tidak dipotong)")
	}
}

// Flag NYALA + proses menggantung -> adapter membunuh tepat waktu (bukan
// menunggu sampai ctx pemanggil habis tanpa membunuh grup proses).
func TestRuntimeRunFlagOnTimeout(t *testing.T) {
	base := t.TempDir()
	resetTenantExecutorForTest(t, base)
	t.Setenv("WEBBUILDER_ENABLE_TENANT_EXEC", "1")
	dir := filepath.Join(base, "proj-timeout")
	fakeTenantProject(t, dir, "setTimeout(()=>{}, 30000)")
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, _, err := runtimeRun(ctx, dir, "npm", "run", "build")
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("flag nyala + timeout: proses 30 dtk dengan deadline 500ms harus error")
	}
	if elapsed > 5*time.Second {
		t.Fatalf("flag nyala + timeout: proses tidak dibunuh tepat waktu, elapsed=%s", elapsed)
	}
}

// Flag NYALA + proyek vite nyata: npm install + vite build sungguhan harus
// berhasil lewat env yang di-scrub (proxy diteruskan tanpa kredensial).
// Memakai contractFiles() seperti test E2E queue: package.json minimal,
// prepareRuntimeWorkspace melengkapi vite/react/react-dom.
func TestRuntimeRunFlagOnRealViteBuild(t *testing.T) {
	db := openAgentTestDB(t)
	user := makeAdminUser(t, db, "uji-isolasi-vite@example.com")
	files := contractFiles()
	fj, _ := json.Marshal(files)
	p := models.Project{UserID: user.ID, Name: "Uji Isolasi Vite", Slug: "uji-isolasi-" + randHex(6), Files: string(fj)}
	if err := db.Create(&p).Error; err != nil {
		t.Fatalf("create project: %v", err)
	}
	dir := projectRuntimeRoot(p.ID)
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	if _, err := prepareRuntimeWorkspace(&p); err != nil {
		t.Fatalf("prepareRuntimeWorkspace: %v", err)
	}
	// BaseDir default "../runtime" (induk projectRuntimeRoot) + reset cache
	// supaya executor dibangun dengan base itu, bukan base test lain.
	resetTenantExecutorForTest(t, filepath.Join("..", "runtime"))
	t.Setenv("WEBBUILDER_ENABLE_TENANT_EXEC", "1")
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Minute)
	defer cancel()
	command, installArgs, buildArgs := runtimeToolchain(dir)
	installOut, installCode, installErr := runtimeRun(ctx, dir, command, installArgs...)
	if installErr != nil || installCode != 0 {
		t.Fatalf("flag nyala: npm install harus sukses, code=%d err=%v out=%.500s", installCode, installErr, installOut)
	}
	buildOut, buildCode, buildErr := runtimeRun(ctx, dir, command, buildArgs...)
	if buildErr != nil || buildCode != 0 {
		t.Fatalf("flag nyala: vite build harus sukses, code=%d err=%v out=%.500s", buildCode, buildErr, buildOut)
	}
	if _, err := os.Stat(filepath.Join(dir, "dist", "index.html")); err != nil {
		t.Fatalf("flag nyala: dist/index.html harus ada sesudah vite build: %v", err)
	}
}

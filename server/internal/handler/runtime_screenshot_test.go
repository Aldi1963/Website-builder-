// Tes endpoint penyajian screenshot verifikasi browser:
// GET /api/projects/:id/runtime/screenshots/verification/:runId/:name
// (lihat runtimeVerificationScreenshotFile di runtime.go) dan helper
// verificationScreenshotURL yang mengisi field screenshotUrl di event
// SSE result. Route lama capture-*.png harus tetap berperilaku sama.
package handler

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"webbuilder/internal/database/models"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// testPNG adalah fixture PNG minimal (signature + isi palsu); cukup
// untuk membuktikan file disajikan utuh sebagai image/png.
var testPNG = []byte("\x89PNG\r\n\x1a\n" + "SCREENSHOT-PALSU")

func setupScreenshotTest(t *testing.T) (*gorm.DB, *gin.Engine, models.User, models.Project, models.AgentRun) {
	t.Helper()
	t.Setenv("JWT_SECRET", "test-secret-shot")
	db := openTestDB(t)
	if err := db.AutoMigrate(&models.Project{}, &models.AgentRun{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	user := makeUser(t, db, "shot@x.id", "rahasia1")
	p := models.Project{UserID: user.ID, Name: "Uji Screenshot", Slug: "uji-shot-" + randHex(6), Framework: "react", Files: "{}"}
	if err := db.Create(&p).Error; err != nil {
		t.Fatalf("create project: %v", err)
	}
	run := models.AgentRun{ProjectID: p.ID, UserID: user.ID, Mode: "edit", Status: "running", Phase: "browser_verify", Request: "verifikasi"}
	if err := db.Create(&run).Error; err != nil {
		t.Fatalf("create run: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(projectRuntimeRoot(p.ID)) })

	r := gin.New()
	r.Use(authMiddleware(db))
	r.GET("/api/projects/:id/runtime/screenshots/:name", runtimeScreenshotFile(db))
	r.GET("/api/projects/:id/runtime/screenshots/verification/:runId/:name", runtimeVerificationScreenshotFile(db))
	return db, r, user, p, run
}

func writeShotFixture(t *testing.T, p models.Project, run models.AgentRun, name string) {
	t.Helper()
	dir := filepath.Join(projectRuntimeRoot(p.ID), fmt.Sprintf("run-%d", run.ID))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), testPNG, 0o644); err != nil {
		t.Fatal(err)
	}
}

func callShot(t *testing.T, r *gin.Engine, target, token string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, target, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	r.ServeHTTP(w, req)
	return w
}

func TestRuntimeVerificationScreenshotServes(t *testing.T) {
	_, r, user, p, run := setupScreenshotTest(t)
	writeShotFixture(t, p, run, "screenshot-1.png")

	target := fmt.Sprintf("/api/projects/%d/runtime/screenshots/verification/%d/screenshot-1.png", p.ID, run.ID)
	w := callShot(t, r, target, makeToken(user.ID))
	if w.Code != 200 {
		t.Fatalf("screenshot verifikasi sah: mau 200, dapat %d (%s)", w.Code, w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); ct != "image/png" {
		t.Fatalf("content-type harus image/png, dapat %q", ct)
	}
	if w.Body.String() != string(testPNG) {
		t.Fatal("isi file yang disajikan harus sama persis dengan fixture PNG")
	}
}

func TestRuntimeVerificationScreenshotRejects(t *testing.T) {
	db, r, user, p, run := setupScreenshotTest(t)
	writeShotFixture(t, p, run, "screenshot-1.png")
	tok := makeToken(user.ID)
	other := makeUser(t, db, "lain@x.id", "rahasia1")

	// Proyek + run lain (user berbeda): run-nya ada, tapi bukan milik
	// proyek ini — harus 404, bukan file.
	p2 := models.Project{UserID: other.ID, Name: "Proyek Lain", Slug: "lain-" + randHex(6), Framework: "react", Files: "{}"}
	if err := db.Create(&p2).Error; err != nil {
		t.Fatalf("create project lain: %v", err)
	}
	run2 := models.AgentRun{ProjectID: p2.ID, UserID: other.ID, Mode: "edit", Status: "running", Phase: "browser_verify", Request: "verifikasi"}
	if err := db.Create(&run2).Error; err != nil {
		t.Fatalf("create run lain: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(projectRuntimeRoot(p2.ID)) })
	writeShotFixture(t, p2, run2, "screenshot-1.png")

	base := fmt.Sprintf("/api/projects/%d/runtime/screenshots/verification/", p.ID)
	cases := []struct {
		name   string
		target string
		token  string
		want   int
	}{
		{"tanpa token", base + fmt.Sprintf("%d/screenshot-1.png", run.ID), "", 401},
		{"user lain bukan owner", base + fmt.Sprintf("%d/screenshot-1.png", run.ID), makeToken(other.ID), 403},
		{"run proyek lain", base + fmt.Sprintf("%d/screenshot-1.png", run2.ID), tok, 404},
		{"run tidak ada", base + "999999/screenshot-1.png", tok, 404},
		{"runId bukan angka", base + "run-" + fmt.Sprint(run.ID) + "/screenshot-1.png", tok, 404},
		{"runId traversal ..", base + "../screenshot-1.png", tok, 404},
		{"runId traversal encoded", base + "%2e%2e/screenshot-1.png", tok, 404},
		{"nama bukan angka", base + fmt.Sprintf("%d/screenshot-abc.png", run.ID), tok, 404},
		{"nama tanpa nomor", base + fmt.Sprintf("%d/screenshot-.png", run.ID), tok, 404},
		{"nama ekstensi lain", base + fmt.Sprintf("%d/screenshot-1.jpg", run.ID), tok, 404},
		{"nama capture di route verifikasi", base + fmt.Sprintf("%d/capture-1.png", run.ID), tok, 404},
		{"nama traversal slash", base + fmt.Sprintf("%d/..%%2fscreenshot-1.png", run.ID), tok, 404},
		{"nama traversal encoded", base + fmt.Sprintf("%d/%%2e%%2e%%2fscreenshot-1.png", run.ID), tok, 404},
		{"nama traversal backslash", base + fmt.Sprintf("%d/..%%5cscreenshot-1.png", run.ID), tok, 404},
		{"file tidak ada di run", base + fmt.Sprintf("%d/screenshot-2.png", run.ID), tok, 404},
	}
	for _, tc := range cases {
		if w := callShot(t, r, tc.target, tc.token); w.Code != tc.want {
			t.Fatalf("%s: mau %d, dapat %d (%s)", tc.name, tc.want, w.Code, w.Body.String())
		}
	}
}

func TestRuntimeCaptureScreenshotRouteUnchanged(t *testing.T) {
	_, r, user, p, run := setupScreenshotTest(t)
	// Fixture capture di route lama + screenshot verifikasi di run dir.
	dir := filepath.Join(projectRuntimeRoot(p.ID), "screenshots")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "capture-1.png"), testPNG, 0o644); err != nil {
		t.Fatal(err)
	}
	writeShotFixture(t, p, run, "screenshot-1.png")
	tok := makeToken(user.ID)

	// Route lama tetap melayani capture-*.png ...
	w := callShot(t, r, fmt.Sprintf("/api/projects/%d/runtime/screenshots/capture-1.png", p.ID), tok)
	if w.Code != 200 || w.Body.String() != string(testPNG) {
		t.Fatalf("route lama capture: mau 200 + isi PNG, dapat %d", w.Code)
	}
	// ... dan tetap menolak screenshot verifikasi di route lama.
	w = callShot(t, r, fmt.Sprintf("/api/projects/%d/runtime/screenshots/screenshot-1.png", p.ID), tok)
	if w.Code != 404 {
		t.Fatalf("route lama harus tetap 404 untuk screenshot-1.png, dapat %d", w.Code)
	}
}

func TestVerificationScreenshotURL(t *testing.T) {
	_, _, _, p, run := setupScreenshotTest(t)
	shot := filepath.Join(projectRuntimeRoot(p.ID), fmt.Sprintf("run-%d", run.ID), "screenshot-2.png")
	want := fmt.Sprintf("/api/projects/%d/runtime/screenshots/verification/%d/screenshot-2.png", p.ID, run.ID)
	if got := verificationScreenshotURL(p.ID, run.ID, shot); got != want {
		t.Fatalf("URL sah: mau %q, dapat %q", want, got)
	}
	cases := []struct {
		name string
		pid  uint
		rid  uint
		path string
	}{
		{"path kosong (verifikasi tidak jalan)", p.ID, run.ID, ""},
		{"path workspace MCP (pindah gagal)", p.ID, run.ID, filepath.Join("runDir", "browser", "screenshot-1.png")},
		{"direktori run lain", p.ID, run.ID, filepath.Join(projectRuntimeRoot(p.ID), "run-999", "screenshot-1.png")},
		{"direktori proyek lain", p.ID, run.ID, filepath.Join(projectRuntimeRoot(p.ID+1), fmt.Sprintf("run-%d", run.ID), "screenshot-1.png")},
		{"nama capture bukan verifikasi", p.ID, run.ID, filepath.Join(projectRuntimeRoot(p.ID), fmt.Sprintf("run-%d", run.ID), "capture-1.png")},
		{"nama bukan angka", p.ID, run.ID, filepath.Join(projectRuntimeRoot(p.ID), fmt.Sprintf("run-%d", run.ID), "screenshot-x.png")},
	}
	for _, tc := range cases {
		if got := verificationScreenshotURL(tc.pid, tc.rid, tc.path); got != "" {
			t.Fatalf("%s: mau URL kosong, dapat %q", tc.name, got)
		}
	}
}

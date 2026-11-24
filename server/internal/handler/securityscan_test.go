// Tes gating security scan di alur publish: temuan kritis memblokir
// publish (fail-closed), temuan non-kritis hanya jadi peringatan, dan
// laporan tersimpan sehingga bisa dibaca ulang lewat GET security-scan.
package handler

import (
	"encoding/json"
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

func makePublishableProject(t *testing.T, db *gorm.DB, userID uint, filesJSON string) models.Project {
	t.Helper()
	p := models.Project{
		UserID: userID, Name: "Uji Scan", Slug: "uji-scan-" + randHex(6),
		Framework: "react", Files: filesJSON,
		BuildStatus: "success", PublishState: "draft",
	}
	if err := db.Create(&p).Error; err != nil {
		t.Fatalf("create project: %v", err)
	}
	// Artifact production yang disyaratkan publishProject.
	dir := filepath.Join(projectRuntimeRoot(p.ID), "dist")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatalf("mkdir dist: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html></html>"), 0644); err != nil {
		t.Fatalf("write dist: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(projectRuntimeRoot(p.ID)) })
	return p
}

func TestPublishBlockedByCriticalFinding(t *testing.T) {
	t.Setenv("JWT_SECRET", "test-secret-scan")
	db := openTestDB(t)
	if err := db.AutoMigrate(&models.Project{}, &models.Deployment{}, &models.Notification{}, &models.ProjectWebhook{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	user := makeUser(t, db, "scan-block@x.id", "rahasia1")
	files, _ := json.Marshal(map[string]string{
		"src/App.tsx": "export default function App() { return <div>halo</div>; }",
		// Kunci palsu dirangkai saat jalan supaya push protection GitHub
		// tidak mengira ini secret sungguhan.
		"src/config.ts": `export const KEY = "` + "sk_live_" + "abcdefghijklmnop1234567890" + `";`,
	})
	p := makePublishableProject(t, db, user.ID, string(files))

	r := gin.New()
	r.Use(authMiddleware(db))
	r.POST("/api/projects/:id/publish", publishProject(db))
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/projects/%d/publish", p.ID), nil)
	req.Header.Set("Authorization", "Bearer "+makeToken(user.ID))
	r.ServeHTTP(w, req)
	if w.Code != 409 {
		t.Fatalf("publish dengan secret harus 409, dapat %d (%s)", w.Code, w.Body.String())
	}
	var resp struct {
		Status       string         `json:"status"`
		SecurityScan map[string]any `json:"securityScan"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("parse respons: %v", err)
	}
	if resp.Status != "blocked" {
		t.Fatalf("status harus blocked, dapat %q", resp.Status)
	}
	summary, _ := resp.SecurityScan["summary"].(map[string]any)
	if summary["critical"] == nil || summary["critical"].(float64) < 1 {
		t.Fatalf("laporan harus membawa >=1 kritis, dapat %v", resp.SecurityScan["summary"])
	}
	// Proyek tetap tidak terpublish.
	var back models.Project
	db.First(&back, p.ID)
	if back.Published {
		t.Fatal("proyek dengan temuan kritis tidak boleh jadi published")
	}
	// Laporan tersimpan dan bisa dibaca ulang.
	if back.SecurityScan == "" {
		t.Fatal("laporan scan harus tersimpan di proyek")
	}
}

func TestPublishWarnsOnNonCriticalFinding(t *testing.T) {
	t.Setenv("JWT_SECRET", "test-secret-scan")
	db := openTestDB(t)
	if err := db.AutoMigrate(&models.Project{}, &models.Deployment{}, &models.Notification{}, &models.ProjectWebhook{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	user := makeUser(t, db, "scan-warn@x.id", "rahasia1")
	files, _ := json.Marshal(map[string]string{
		"src/App.tsx": "export function View({ html }: any) {\n  return <div dangerouslySetInnerHTML={{ __html: html }} />;\n}\n",
	})
	p := makePublishableProject(t, db, user.ID, string(files))

	r := gin.New()
	r.Use(authMiddleware(db))
	r.POST("/api/projects/:id/publish", publishProject(db))
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/projects/%d/publish", p.ID), nil)
	req.Header.Set("Authorization", "Bearer "+makeToken(user.ID))
	r.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("temuan high saja harus tetap publish (200), dapat %d (%s)", w.Code, w.Body.String())
	}
	var resp struct {
		SecurityWarning string         `json:"securityWarning"`
		SecurityScan    map[string]any `json:"securityScan"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("parse respons: %v", err)
	}
	if resp.SecurityWarning == "" {
		t.Fatal("respons publish harus membawa securityWarning bila ada temuan non-kritis")
	}
	if resp.SecurityScan["passed"] != true {
		t.Fatalf("passed harus true tanpa temuan kritis, dapat %v", resp.SecurityScan)
	}
}

func TestPublishCleanProjectPasses(t *testing.T) {
	t.Setenv("JWT_SECRET", "test-secret-scan")
	db := openTestDB(t)
	if err := db.AutoMigrate(&models.Project{}, &models.Deployment{}, &models.Notification{}, &models.ProjectWebhook{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	user := makeUser(t, db, "scan-clean@x.id", "rahasia1")
	files, _ := json.Marshal(map[string]string{
		"src/App.tsx": "export default function App() { return <div>halo</div>; }",
		"src/api.ts":  "export async function load(id: string) { return cloudDb.query(\"SELECT * FROM items WHERE id = $1\", [id]); }",
	})
	p := makePublishableProject(t, db, user.ID, string(files))

	r := gin.New()
	r.Use(authMiddleware(db))
	r.POST("/api/projects/:id/publish", publishProject(db))
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/projects/%d/publish", p.ID), nil)
	req.Header.Set("Authorization", "Bearer "+makeToken(user.ID))
	r.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("proyek bersih harus publish (200), dapat %d (%s)", w.Code, w.Body.String())
	}
	var resp struct {
		SecurityScan map[string]any `json:"securityScan"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	summary, _ := resp.SecurityScan["summary"].(map[string]any)
	if summary["total"] != nil && summary["total"].(float64) != 0 {
		t.Fatalf("proyek bersih harus 0 temuan, dapat %v", summary)
	}
	if _, hasLimit := resp.SecurityScan["limitations"]; !hasLimit {
		t.Fatal("laporan harus selalu membawa limitations")
	}
}

func TestSecurityScanEndpoints(t *testing.T) {
	t.Setenv("JWT_SECRET", "test-secret-scan")
	db := openTestDB(t)
	if err := db.AutoMigrate(&models.Project{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	user := makeUser(t, db, "scan-ep@x.id", "rahasia1")
	files, _ := json.Marshal(map[string]string{
		"src/api.ts": "export async function cari(n: string) { return cloudDb.query(`SELECT * FROM u WHERE name='${n}'`); }",
	})
	p := models.Project{UserID: user.ID, Name: "Uji Scan EP", Slug: "uji-scan-ep-" + randHex(6), Files: string(files)}
	if err := db.Create(&p).Error; err != nil {
		t.Fatalf("create project: %v", err)
	}

	r := gin.New()
	r.Use(authMiddleware(db))
	r.GET("/api/projects/:id/security-scan", getSecurityScan(db))
	r.POST("/api/projects/:id/security-scan", runSecurityScan(db))
	call := func(method, path string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(method, path, nil)
		req.Header.Set("Authorization", "Bearer "+makeToken(user.ID))
		r.ServeHTTP(w, req)
		return w
	}
	// Sebelum pernah dipindai: 404 yang jelas.
	if w := call(http.MethodGet, fmt.Sprintf("/api/projects/%d/security-scan", p.ID)); w.Code != 404 {
		t.Fatalf("GET sebelum scan harus 404, dapat %d (%s)", w.Code, w.Body.String())
	}
	// POST menjalankan scan: SQLi template literal = kritis -> blocked.
	w := call(http.MethodPost, fmt.Sprintf("/api/projects/%d/security-scan", p.ID))
	if w.Code != 200 {
		t.Fatalf("POST scan harus 200, dapat %d (%s)", w.Code, w.Body.String())
	}
	var resp struct {
		SecurityScan map[string]any `json:"securityScan"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("parse respons: %v", err)
	}
	if resp.SecurityScan["blocked"] != true {
		t.Fatalf("scan SQLi harus blocked=true, dapat %v", resp.SecurityScan)
	}
	// GET sesudahnya mengembalikan laporan yang sama (tersimpan).
	w = call(http.MethodGet, fmt.Sprintf("/api/projects/%d/security-scan", p.ID))
	if w.Code != 200 {
		t.Fatalf("GET sesudah scan harus 200, dapat %d (%s)", w.Code, w.Body.String())
	}
	var resp2 struct {
		SecurityScan map[string]any `json:"securityScan"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &resp2)
	if fmt.Sprint(resp2.SecurityScan["summary"]) != fmt.Sprint(resp.SecurityScan["summary"]) {
		t.Fatalf("laporan tersimpan harus sama dengan hasil POST:\n%v\n%v", resp.SecurityScan["summary"], resp2.SecurityScan["summary"])
	}
}

package handler

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

// Regresi trek wb265-preview-empty: token preview (pv_...) yang baru
// diterbitkan issueRuntimePreviewToken harus lolos getRuntimePreviewGrant
// dan authMiddleware pada path preview. Sempat dicurigai sebagai akar
// 401 preview; ternyata middleware melihat token dengan benar — akar
// sebenarnya adalah Vite yang memantulkan path preview balik ke Go
// (lihat viteAPIProxyEntry). Tes ini mengunci perilaku token itu sendiri.
func TestRuntimePreviewGrantRoundTrip(t *testing.T) {
	t.Setenv("JWT_SECRET", "test-secret-untuk-tes-saja")
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	tok := issueRuntimePreviewToken(1, 1)
	if tok == "" {
		t.Fatal("token kosong")
	}
	t.Logf("token: %s", tok)
	grant, ok := getRuntimePreviewGrant(tok)
	if !ok {
		t.Fatalf("grant round-trip gagal untuk token yang baru diterbitkan: %s", tok)
	}
	if grant.ProjectID != 1 || grant.UserID != 1 {
		t.Fatalf("grant salah: %+v", grant)
	}

	// Lewat middleware persis seperti request iframe.
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(authMiddleware(db))
	r.GET("/api/projects/:id/runtime/preview/*filepath", func(c *gin.Context) {
		c.JSON(200, gin.H{"uid": c.GetUint("userID")})
	})
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/projects/1/runtime/preview/?token="+tok, nil)
	r.ServeHTTP(w, req)
	t.Logf("middleware status=%d body=%s", w.Code, w.Body.String())
	if w.Code != 200 {
		t.Fatalf("middleware menolak token preview asli: %d %s", w.Code, w.Body.String())
	}

	// Cookie wb_preview (tanpa query): import bersarang modul JS memakai
	// URL absolut tanpa ?token= — middleware harus menerima token dari
	// cookie yang diset saat dokumen preview dimuat.
	w2 := httptest.NewRecorder()
	req2 := httptest.NewRequest(http.MethodGet, "/api/projects/1/runtime/preview/src/main.tsx", nil)
	req2.AddCookie(&http.Cookie{Name: "wb_preview", Value: tok})
	r.ServeHTTP(w2, req2)
	if w2.Code != 200 {
		t.Fatalf("middleware menolak token preview via cookie: %d %s", w2.Code, w2.Body.String())
	}

	// Cookie salah: tetap 401.
	w3 := httptest.NewRecorder()
	req3 := httptest.NewRequest(http.MethodGet, "/api/projects/1/runtime/preview/src/main.tsx", nil)
	req3.AddCookie(&http.Cookie{Name: "wb_preview", Value: "pv_tidakvalid"})
	r.ServeHTTP(w3, req3)
	if w3.Code != 401 {
		t.Fatalf("cookie preview salah harus 401, dapat %d", w3.Code)
	}

	// Fallback WS HMR: @vite/client mengirim ?token=<wsToken internal
	// Vite> (bukan token preview) — middleware harus jatuh ke cookie
	// wb_preview supaya handshake WS lewat proxy tidak 401.
	w4 := httptest.NewRecorder()
	req4 := httptest.NewRequest(http.MethodGet, "/api/projects/1/runtime/preview/?token=mKoOHwEq3Wui", nil)
	req4.AddCookie(&http.Cookie{Name: "wb_preview", Value: tok})
	r.ServeHTTP(w4, req4)
	if w4.Code != 200 {
		t.Fatalf("WS HMR dengan token internal Vite + cookie valid harus 200, dapat %d %s", w4.Code, w4.Body.String())
	}

	// Token internal Vite TANPA cookie: tetap 401.
	w5 := httptest.NewRecorder()
	req5 := httptest.NewRequest(http.MethodGet, "/api/projects/1/runtime/preview/?token=mKoOHwEq3Wui", nil)
	r.ServeHTTP(w5, req5)
	if w5.Code != 401 {
		t.Fatalf("token internal Vite tanpa cookie harus 401, dapat %d", w5.Code)
	}
}

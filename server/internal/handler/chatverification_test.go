// Tes verifikasi browser PERSISTEN di pesan chat: hasil loop verifikasi
// yang dulu hanya hidup di event SSE `result` kini tersimpan di kolom
// ChatMessage.Verification dan kembali lewat GET /api/projects/:id/chat,
// supaya kartu verifikasi bertahan setelah reload. Pesan lama / tanpa
// verifikasi / dengan isi kolom rusak tetap tampil tanpa kartu.
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
)

func TestChatVerificationJSON(t *testing.T) {
	if got := chatVerificationJSON(""); got != nil {
		t.Fatalf("kosong: mau nil, dapat %q", string(got))
	}
	if got := chatVerificationJSON("   "); got != nil {
		t.Fatalf("spasi saja: mau nil, dapat %q", string(got))
	}
	if got := chatVerificationJSON("{bukan json"); got != nil {
		t.Fatalf("rusak: mau nil, dapat %q", string(got))
	}
	if got := chatVerificationJSON(`"hanya string"`); got != nil {
		t.Fatalf("bukan objek: mau nil, dapat %q", string(got))
	}
	raw := `{"attempted":true,"passed":false,"rounds":2,"consoleErrors":["e1"],"failedRequests":[],"screenshotPath":"p","screenshotUrl":"u"}`
	if got := chatVerificationJSON(raw); string(got) != raw {
		t.Fatalf("objek sah harus kembali utuh: mau %q, dapat %q", raw, string(got))
	}
}

func TestSaveChatVerificationSkipsWhenNotAttempted(t *testing.T) {
	db := openTestDB(t)
	if err := db.AutoMigrate(&models.ChatMessage{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	msg := models.ChatMessage{SessionID: 1, Role: "assistant", Content: "selesai"}
	if err := db.Create(&msg).Error; err != nil {
		t.Fatalf("create: %v", err)
	}
	// Loop tidak jalan: tidak ada yang disimpan, walau pesan ada.
	obj := saveChatVerification(db, msg.ID, 1, 1, browserVerificationOutcome{Attempted: false})
	if obj["attempted"] != false {
		t.Fatalf("objek SSE harus tetap membawa attempted=false, dapat %v", obj["attempted"])
	}
	var back models.ChatMessage
	db.First(&back, msg.ID)
	if back.Verification != "" {
		t.Fatalf("verification tidak-attempted harus tetap kosong, dapat %q", back.Verification)
	}
	// Tanpa pesan asisten (jawaban model kosong): tidak ada yang ditulis,
	// dan tidak panic.
	saveChatVerification(db, 0, 1, 1, browserVerificationOutcome{Attempted: true, Passed: true, Rounds: 1})
}

func TestChatMessageAutoMigrateHasVerificationColumn(t *testing.T) {
	db := openTestDB(t)
	if err := db.AutoMigrate(&models.ChatMessage{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if !db.Migrator().HasColumn(&models.ChatMessage{}, "verification") {
		t.Fatal("AutoMigrate harus membuat kolom verification di chat_messages (jalur SQLite)")
	}
}

func TestGetChatReturnsPersistedVerification(t *testing.T) {
	t.Setenv("JWT_SECRET", "test-secret-verif")
	db := openTestDB(t)
	if err := db.AutoMigrate(&models.Project{}, &models.ChatSession{}, &models.ChatMessage{}, &models.AgentRun{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	user := makeUser(t, db, "verif@x.id", "rahasia1")
	p := models.Project{UserID: user.ID, Name: "Uji Verifikasi", Slug: "uji-verif-" + randHex(6), Framework: "react", Files: "{}"}
	if err := db.Create(&p).Error; err != nil {
		t.Fatalf("create project: %v", err)
	}
	session := models.ChatSession{ProjectID: p.ID, Title: "uji"}
	if err := db.Create(&session).Error; err != nil {
		t.Fatalf("create session: %v", err)
	}
	run := models.AgentRun{ProjectID: p.ID, UserID: user.ID, Mode: "edit", Status: "running", Phase: "browser_verify", Request: "verifikasi"}
	if err := db.Create(&run).Error; err != nil {
		t.Fatalf("create run: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(projectRuntimeRoot(p.ID)) })

	// 1. Pesan user lama (tanpa verifikasi).
	if err := db.Create(&models.ChatMessage{SessionID: session.ID, Role: "user", Content: "buat landing page"}).Error; err != nil {
		t.Fatalf("create user msg: %v", err)
	}
	// 2. Pesan asisten dengan verifikasi — ditulis lewat helper yang sama
	// dengan yang dipakai pipeline (saveChatVerification), bukan tiruan.
	shotPath := filepath.Join(projectRuntimeRoot(p.ID), fmt.Sprintf("run-%d", run.ID), "screenshot-1.png")
	assistantMsg := models.ChatMessage{SessionID: session.ID, Role: "assistant", Content: "selesai, sudah diverifikasi"}
	if err := db.Create(&assistantMsg).Error; err != nil {
		t.Fatalf("create assistant msg: %v", err)
	}
	outcome := browserVerificationOutcome{Attempted: true, Passed: true, Rounds: 1, ScreenshotPath: shotPath, ConsoleErrors: []string{}, FailedRequests: []string{}}
	sseObj := saveChatVerification(db, assistantMsg.ID, p.ID, run.ID, outcome)
	// 3. Pesan dengan isi kolom rusak — harus tampil tanpa kartu.
	if err := db.Create(&models.ChatMessage{SessionID: session.ID, Role: "assistant", Content: "pesan rusak", Verification: "{bukan json"}).Error; err != nil {
		t.Fatalf("create corrupt msg: %v", err)
	}
	// 4. Pesan asisten run tanpa verifikasi (loop tidak jalan).
	plainMsg := models.ChatMessage{SessionID: session.ID, Role: "assistant", Content: "tanpa verifikasi"}
	if err := db.Create(&plainMsg).Error; err != nil {
		t.Fatalf("create plain msg: %v", err)
	}
	saveChatVerification(db, plainMsg.ID, p.ID, run.ID, browserVerificationOutcome{Attempted: false})

	// Kolom mentah di DB harus sama persis dengan objek SSE `result`.
	var stored models.ChatMessage
	db.First(&stored, assistantMsg.ID)
	var storedObj map[string]any
	if err := json.Unmarshal([]byte(stored.Verification), &storedObj); err != nil {
		t.Fatalf("kolom verification harus JSON sah: %v", err)
	}
	sseJSON, _ := json.Marshal(sseObj)
	var sseMap map[string]any
	_ = json.Unmarshal(sseJSON, &sseMap)
	if fmt.Sprint(storedObj) != fmt.Sprint(sseMap) {
		t.Fatalf("kolom DB != objek SSE:\nDB:  %v\nSSE: %v", storedObj, sseMap)
	}

	// Muat riwayat lewat endpoint yang sama dengan frontend.
	r := gin.New()
	r.Use(authMiddleware(db))
	r.GET("/api/projects/:id/chat", getChat(db))
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/projects/%d/chat", p.ID), nil)
	req.Header.Set("Authorization", "Bearer "+makeToken(user.ID))
	r.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("GET chat: mau 200, dapat %d (%s)", w.Code, w.Body.String())
	}
	var resp struct {
		Messages []map[string]any `json:"messages"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("parse respons: %v", err)
	}
	if len(resp.Messages) != 4 {
		t.Fatalf("jumlah pesan = %d, want 4: %v", len(resp.Messages), resp.Messages)
	}
	// Pesan 1 (user lama): tanpa kunci verification.
	if _, ok := resp.Messages[0]["verification"]; ok {
		t.Fatalf("pesan user lama tidak boleh membawa verification: %v", resp.Messages[0])
	}
	// Pesan 2 (asisten terverifikasi): verification utuh, sama seperti SSE.
	ver, ok := resp.Messages[1]["verification"].(map[string]any)
	if !ok {
		t.Fatalf("pesan asisten harus membawa objek verification: %v", resp.Messages[1])
	}
	wantURL := fmt.Sprintf("/api/projects/%d/runtime/screenshots/verification/%d/screenshot-1.png", p.ID, run.ID)
	checks := []struct {
		key  string
		want any
	}{
		{"attempted", true},
		{"passed", true},
		{"rounds", float64(1)},
		{"screenshotPath", shotPath},
		{"screenshotUrl", wantURL},
	}
	for _, ck := range checks {
		if ver[ck.key] != ck.want {
			t.Fatalf("verification.%s = %v (%T), want %v", ck.key, ver[ck.key], ver[ck.key], ck.want)
		}
	}
	for _, key := range []string{"consoleErrors", "failedRequests"} {
		arr, ok := ver[key].([]any)
		if !ok || len(arr) != 0 {
			t.Fatalf("verification.%s harus array kosong, dapat %v", key, ver[key])
		}
	}
	// Pesan 3 (kolom rusak) dan 4 (tanpa verifikasi): tanpa kartu.
	for i, idx := range []int{2, 3} {
		if _, ok := resp.Messages[idx]["verification"]; ok {
			t.Fatalf("pesan %d tidak boleh membawa verification: %v", i+3, resp.Messages[idx])
		}
	}
}

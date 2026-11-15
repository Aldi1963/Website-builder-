package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"webbuilder/internal/database/models"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// openProviderTestDB membuka DB test + migrasi model yang dipakai trek
// provider per prompt.
func openProviderTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	db := openTestDB(t)
	ensureTestKeyEnc(t)
	if err := db.AutoMigrate(
		&models.AIConfig{}, &models.AIProviderConfig{},
		&models.AgentRun{}, &models.ChatMessage{},
	); err != nil {
		t.Fatalf("migrate provider: %v", err)
	}
	return db
}

// noAIEnv memastikan trio env AI tidak bocor dari environment test runner.
func noAIEnv(t *testing.T) {
	t.Helper()
	t.Setenv("AI_BASE_URL", "")
	t.Setenv("AI_API_KEY", "")
	t.Setenv("AI_MODEL", "")
}

func mustEncryptKey(t *testing.T, plain string) string {
	t.Helper()
	enc, err := keyEnc.Encrypt(plain)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	return enc
}

func makeProvider(t *testing.T, db *gorm.DB, name, baseURL, key string, ms []string, isDefault bool) models.AIProviderConfig {
	t.Helper()
	enc := ""
	if key != "" {
		enc = mustEncryptKey(t, key)
	}
	row := models.AIProviderConfig{
		Name: name, BaseURL: baseURL, APIKey: enc,
		Models: marshalProviderModels(normalizeProviderModels(ms)), IsDefault: isDefault, Enabled: true,
	}
	if err := db.Create(&row).Error; err != nil {
		t.Fatalf("create provider: %v", err)
	}
	return row
}

func TestSeedDefaultProviderFromLegacyConfig(t *testing.T) {
	db := openProviderTestDB(t)
	noAIEnv(t)
	enc := mustEncryptKey(t, "legacy-key-123")
	if err := db.Create(&models.AIConfig{ID: 1, BaseURL: "https://legacy.example/v1", APIKey: enc, Model: "legacy-model"}).Error; err != nil {
		t.Fatalf("create ai_config: %v", err)
	}
	if !ensureDefaultProviderSeeded(db) {
		t.Fatal("seed harus dibuat dari konfigurasi lama")
	}
	if ensureDefaultProviderSeeded(db) {
		t.Fatal("seed kedua harus no-op (idempoten)")
	}
	var row models.AIProviderConfig
	if err := db.First(&row).Error; err != nil {
		t.Fatalf("provider hasil seed tidak ada: %v", err)
	}
	if row.Name != "Default" || !row.IsDefault || !row.Enabled {
		t.Fatalf("provider seed salah: %+v", row)
	}
	if got := parseProviderModels(row.Models); len(got) != 1 || got[0] != "legacy-model" {
		t.Fatalf("models seed salah: %v", got)
	}
	if dec, err := keyEnc.Decrypt(row.APIKey); err != nil || dec != "legacy-key-123" {
		t.Fatalf("key seed harus terenkripsi + bisa didekripsi, dapat %q err %v", dec, err)
	}
	// Resolve default memakai hasil seed.
	p, name, err := resolveAIProvider(db, 0, "")
	if err != nil {
		t.Fatalf("resolve default: %v", err)
	}
	if name != "Default" || p.Model != "legacy-model" || p.APIKey != "legacy-key-123" || p.BaseURL != "https://legacy.example/v1" {
		t.Fatalf("resolve default salah: name=%q provider=%+v", name, p)
	}
}

func TestSeedDefaultProviderFromEnv(t *testing.T) {
	db := openProviderTestDB(t)
	t.Setenv("AI_BASE_URL", "https://ai.clipku.com/v1")
	t.Setenv("AI_API_KEY", "env-key-9router")
	t.Setenv("AI_MODEL", "cx/gpt-5.6-luna")
	if !ensureDefaultProviderSeeded(db) {
		t.Fatal("seed dari env harus dibuat")
	}
	p, name, err := resolveAIProvider(db, 0, "")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if name != "Default" || p.Model != "cx/gpt-5.6-luna" || p.APIKey != "env-key-9router" {
		t.Fatalf("resolve dari env salah: name=%q provider=%+v", name, p)
	}
}

func TestResolveAIProviderExplicit(t *testing.T) {
	db := openProviderTestDB(t)
	noAIEnv(t)
	row := makeProvider(t, db, "9router", "https://ai.clipku.com/v1", "k-123", []string{"model-b", "model-a"}, true)

	p, name, err := resolveAIProvider(db, row.ID, "model-b")
	if err != nil {
		t.Fatalf("resolve eksplisit: %v", err)
	}
	if name != "9router" || p.Model != "model-b" || p.BaseURL != "https://ai.clipku.com/v1" || p.APIKey != "k-123" {
		t.Fatalf("resolve eksplisit salah: name=%q provider=%+v", name, p)
	}
	// Model kosong -> pertama di daftar (terurut).
	p, _, err = resolveAIProvider(db, row.ID, "")
	if err != nil || p.Model != "model-a" {
		t.Fatalf("model kosong harus jadi model-a, dapat %q err %v", p.Model, err)
	}
	// Model di luar daftar ditolak — jangan diam-diam ganti model.
	if _, _, err := resolveAIProvider(db, row.ID, "model-x"); err == nil {
		t.Fatal("model di luar daftar harus error")
	}
	// ID tidak ada ditolak.
	if _, _, err := resolveAIProvider(db, 9999, ""); err == nil {
		t.Fatal("provider tidak ada harus error")
	}
	// Provider nonaktif ditolak.
	db.Model(&row).Update("enabled", false)
	if _, _, err := resolveAIProvider(db, row.ID, ""); err == nil {
		t.Fatal("provider nonaktif harus error")
	}
}

// ID eksplisit ke tabel kosong: seed Default harus jalan dulu, supaya
// chat pertama instalasi baru yang mengirim providerId=1 (dari dropdown
// yang dimuat sebelum seed) tidak gagal 400. Tanpa konfigurasi apa pun,
// seed tidak membuat apa-apa dan ID tetap ditolak.
func TestResolveAIProviderExplicitSeedsEmptyTable(t *testing.T) {
	db := openProviderTestDB(t)
	t.Setenv("AI_BASE_URL", "https://ai.clipku.com/v1")
	t.Setenv("AI_API_KEY", "env-key-9router")
	t.Setenv("AI_MODEL", "cx/gpt-5.6-luna")
	p, name, err := resolveAIProvider(db, 1, "cx/gpt-5.6-luna")
	if err != nil {
		t.Fatalf("resolve eksplisit ke tabel kosong: %v", err)
	}
	if name != "Default" || p.Model != "cx/gpt-5.6-luna" || p.APIKey != "env-key-9router" {
		t.Fatalf("resolve eksplisit hasil seed salah: name=%q provider=%+v", name, p)
	}

	db2 := openProviderTestDB(t)
	noAIEnv(t)
	if _, _, err := resolveAIProvider(db2, 1, ""); err == nil {
		t.Fatal("tanpa konfigurasi, provider #1 harus tetap ditolak")
	}
}

func TestResolveAIProviderDefaultPicksDefaultRow(t *testing.T) {
	db := openProviderTestDB(t)
	noAIEnv(t)
	makeProvider(t, db, "Lain", "https://lain.example/v1", "k-1", []string{"lain-1"}, false)
	def := makeProvider(t, db, "Utama", "https://utama.example/v1", "k-2", []string{"utama-1"}, true)
	p, name, err := resolveAIProvider(db, 0, "")
	if err != nil {
		t.Fatalf("resolve default: %v", err)
	}
	if name != "Utama" || p.BaseURL != "https://utama.example/v1" || p.Model != "utama-1" {
		t.Fatalf("default harus provider Utama, dapat name=%q provider=%+v", name, p)
	}
	// Model milik provider lain tidak boleh lolos lewat default.
	if _, _, err := resolveAIProvider(db, 0, "lain-1"); err == nil {
		t.Fatal("model provider lain harus ditolak saat resolve default")
	}
	_ = def
}

func TestResolveAIProviderNoConfig(t *testing.T) {
	db := openProviderTestDB(t)
	noAIEnv(t)
	p, name, err := resolveAIProvider(db, 0, "")
	if err != nil {
		t.Fatalf("tanpa konfigurasi resolve tidak boleh error, dapat %v", err)
	}
	if name != "Default" || p.configured() {
		t.Fatalf("tanpa konfigurasi provider harus tidak configured, dapat name=%q %+v", name, p)
	}
}

func TestFetchModelsFromProviderShapes(t *testing.T) {
	openAI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/models" {
			w.WriteHeader(404)
			return
		}
		fmt.Fprint(w, `{"data":[{"id":"z-model"},{"id":"a-model"},{"id":"z-model"}]}`)
	}))
	defer openAI.Close()
	ids, err := fetchModelsFromProvider(t.Context(), openAI.URL, "k")
	if err != nil {
		t.Fatalf("openai shape: %v", err)
	}
	if len(ids) != 2 || ids[0] != "a-model" || ids[1] != "z-model" {
		t.Fatalf("openai shape harus terurut + dedupe: %v", ids)
	}

	ollama := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"models":[{"name":"llama3.1:latest"},{"name":"qwen2.5"}]}`)
	}))
	defer ollama.Close()
	ids, err = fetchModelsFromProvider(t.Context(), ollama.URL, "")
	if err != nil {
		t.Fatalf("ollama shape: %v", err)
	}
	if len(ids) != 2 || ids[0] != "llama3.1:latest" || ids[1] != "qwen2.5" {
		t.Fatalf("ollama shape salah: %v", ids)
	}

	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
		fmt.Fprint(w, "boom")
	}))
	defer bad.Close()
	if _, err := fetchModelsFromProvider(t.Context(), bad.URL, ""); err == nil {
		t.Fatal("HTTP 500 harus error")
	}
}

// TestStreamChatWithoutKeySendsNoAuthHeader membuktikan provider tanpa key
// (Ollama lokal) tidak dikirimi header "Bearer " kosong.
func TestStreamChatWithoutKeySendsNoAuthHeader(t *testing.T) {
	var gotAuth string
	var gotModel string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		var req struct {
			Model string `json:"model"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		gotModel = req.Model
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"halo\"}}]}\n\ndata: [DONE]\n\n")
	}))
	defer srv.Close()
	p := &AIProvider{BaseURL: srv.URL, APIKey: "", Model: "llama3.1:latest"}
	if !p.configured() {
		t.Fatal("provider tanpa key harus configured (base URL + model cukup)")
	}
	var out strings.Builder
	if err := p.streamChat("sys", "hi", func(s string) { out.WriteString(s) }); err != nil {
		t.Fatalf("streamChat: %v", err)
	}
	if out.String() != "halo" {
		t.Fatalf("konten stream salah: %q", out.String())
	}
	if gotAuth != "" {
		t.Fatalf("header Authorization harus kosong untuk provider tanpa key, dapat %q", gotAuth)
	}
	if gotModel != "llama3.1:latest" {
		t.Fatalf("model yang dikirim salah: %q", gotModel)
	}
}

// doProviderJSON memanggil handler dengan userID + param :id (untuk
// rute /admin/ai-providers/:id).
func doProviderJSON(t *testing.T, h gin.HandlerFunc, method, target, body string, userID uint, idParam string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	var r *http.Request
	if body != "" {
		r = httptest.NewRequest(method, target, strings.NewReader(body))
	} else {
		r = httptest.NewRequest(method, target, nil)
	}
	r.Header.Set("Content-Type", "application/json")
	c, _ := gin.CreateTestContext(w)
	c.Request = r
	if userID != 0 {
		c.Set("userID", userID)
	}
	if idParam != "" {
		c.Params = gin.Params{{Key: "id", Value: idParam}}
	}
	h(c)
	return w
}

func TestProviderAdminCRUDHidesKey(t *testing.T) {
	db := openProviderTestDB(t)
	noAIEnv(t)
	admin := makeAdminUser(t, db, "admin-provider@example.com")
	user := makeUser(t, db, "biasa-provider@example.com", "rahasia123")

	// Non-admin ditolak.
	w := doProviderJSON(t, createAIProvider(db), "POST", "/api/admin/ai-providers",
		`{"name":"X","baseUrl":"https://x.example/v1"}`, user.ID, "")
	if w.Code != 403 {
		t.Fatalf("non-admin create: mau 403, dapat %d (%s)", w.Code, w.Body.String())
	}
	// Base URL tidak valid ditolak.
	w = doProviderJSON(t, createAIProvider(db), "POST", "/api/admin/ai-providers",
		`{"name":"X","baseUrl":"bukan-url"}`, admin.ID, "")
	if w.Code != 400 {
		t.Fatalf("base URL jelek: mau 400, dapat %d", w.Code)
	}
	// Buat provider 9router + satu lagi.
	w = doProviderJSON(t, createAIProvider(db), "POST", "/api/admin/ai-providers",
		`{"name":"9router","baseUrl":"https://ai.clipku.com/v1","apiKey":"rahasia-9router","models":["cx/gpt-5.6-luna","oc/deepseek/deepseek-v4.1-flash"]}`, admin.ID, "")
	if w.Code != 201 {
		t.Fatalf("create: mau 201, dapat %d (%s)", w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), "rahasia-9router") {
		t.Fatal("respons create TIDAK BOLEH memuat API key")
	}
	var created struct {
		Provider struct {
			ID        uint     `json:"id"`
			Name      string   `json:"name"`
			Models    []string `json:"models"`
			IsDefault bool     `json:"isDefault"`
			HasKey    bool     `json:"hasKey"`
		} `json:"provider"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatalf("parse create: %v", err)
	}
	if !created.Provider.HasKey || !created.Provider.IsDefault {
		t.Fatalf("provider pertama harus hasKey + default: %+v", created.Provider)
	}
	if len(created.Provider.Models) != 2 {
		t.Fatalf("models create salah: %v", created.Provider.Models)
	}
	// Key tersimpan terenkripsi di DB, bukan plaintext.
	var stored models.AIProviderConfig
	db.First(&stored, created.Provider.ID)
	if stored.APIKey == "rahasia-9router" {
		t.Fatal("key TIDAK BOLEH tersimpan plaintext")
	}
	if dec, err := keyEnc.Decrypt(stored.APIKey); err != nil || dec != "rahasia-9router" {
		t.Fatalf("key harus bisa didekripsi: %q %v", dec, err)
	}

	w = doProviderJSON(t, createAIProvider(db), "POST", "/api/admin/ai-providers",
		`{"name":"Kedua","baseUrl":"https://kedua.example/v1","apiKey":"k2","models":["m2"]}`, admin.ID, "")
	if w.Code != 201 {
		t.Fatalf("create kedua: mau 201, dapat %d", w.Code)
	}
	var created2 struct {
		Provider struct {
			ID uint `json:"id"`
		} `json:"provider"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &created2)

	// Jadikan provider kedua default -> default lama lepas.
	w = doProviderJSON(t, updateAIProvider(db), "PUT", "/api/admin/ai-providers/2",
		`{"isDefault":true}`, admin.ID, fmt.Sprint(created2.Provider.ID))
	if w.Code != 200 {
		t.Fatalf("update default: mau 200, dapat %d (%s)", w.Code, w.Body.String())
	}
	var first models.AIProviderConfig
	db.First(&first, created.Provider.ID)
	if first.IsDefault {
		t.Fatal("default lama harus lepas saat default baru diset")
	}
	// Hapus default baru -> default kembali ke provider pertama.
	w = doProviderJSON(t, deleteAIProvider(db), "DELETE", "/api/admin/ai-providers/2", "", admin.ID, fmt.Sprint(created2.Provider.ID))
	if w.Code != 200 {
		t.Fatalf("delete: mau 200, dapat %d", w.Code)
	}
	db.First(&first, created.Provider.ID)
	if !first.IsDefault {
		t.Fatal("sesudah hapus default, provider tersisa harus dipromosikan jadi default")
	}
	// List user (tanpa key) memuat provider + tidak memuat key.
	w = doProviderJSON(t, listAIProviders(db), "GET", "/api/ai-providers", "", user.ID, "")
	if w.Code != 200 {
		t.Fatalf("list user: mau 200, dapat %d", w.Code)
	}
	if strings.Contains(w.Body.String(), "rahasia-9router") {
		t.Fatal("list user TIDAK BOLEH memuat API key")
	}
	var list struct {
		Providers []struct {
			Name   string   `json:"name"`
			Models []string `json:"models"`
		} `json:"providers"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil {
		t.Fatalf("parse list: %v", err)
	}
	if len(list.Providers) != 1 || list.Providers[0].Name != "9router" || len(list.Providers[0].Models) != 2 {
		t.Fatalf("list user salah: %+v", list.Providers)
	}
}

func TestFetchAIProviderModelsHandler(t *testing.T) {
	db := openProviderTestDB(t)
	noAIEnv(t)
	admin := makeAdminUser(t, db, "admin-fetch@example.com")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/models" {
			w.WriteHeader(404)
			return
		}
		fmt.Fprint(w, `{"data":[{"id":"m-2"},{"id":"m-1"}]}`)
	}))
	defer srv.Close()
	row := makeProvider(t, db, "Uji", srv.URL, "k", nil, true)
	w := doProviderJSON(t, fetchAIProviderModels(db), "POST", "/api/admin/ai-providers/1/fetch-models", "", admin.ID, fmt.Sprint(row.ID))
	if w.Code != 200 {
		t.Fatalf("fetch-models: mau 200, dapat %d (%s)", w.Code, w.Body.String())
	}
	var saved models.AIProviderConfig
	db.First(&saved, row.ID)
	if got := parseProviderModels(saved.Models); len(got) != 2 || got[0] != "m-1" || got[1] != "m-2" {
		t.Fatalf("models harus tersimpan terurut: %v", got)
	}
}

func TestProviderModelColumnsPersist(t *testing.T) {
	db := openProviderTestDB(t)
	run := &models.AgentRun{ProjectID: 7, UserID: 8, Mode: "build", Status: "completed", Request: "x", Provider: "9router", Model: "cx/gpt-5.6-luna"}
	if err := db.Create(run).Error; err != nil {
		t.Fatalf("create run: %v", err)
	}
	msg := &models.ChatMessage{SessionID: 9, Role: "user", Content: "halo", Provider: "9router", Model: "cx/gpt-5.6-luna"}
	if err := db.Create(msg).Error; err != nil {
		t.Fatalf("create message: %v", err)
	}
	var r2 models.AgentRun
	db.First(&r2, run.ID)
	if r2.Provider != "9router" || r2.Model != "cx/gpt-5.6-luna" {
		t.Fatalf("kolom provider/model run tidak tersimpan: %+v", r2)
	}
	var m2 models.ChatMessage
	db.First(&m2, msg.ID)
	if m2.Provider != "9router" || m2.Model != "cx/gpt-5.6-luna" {
		t.Fatalf("kolom provider/model pesan tidak tersimpan: %+v", m2)
	}
}

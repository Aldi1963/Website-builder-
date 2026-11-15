// Provider AI per prompt (trek 1/4 adopsi Website-builder).
//
// Sebelum trek ini hanya ada SATU provider OpenAI-compatible: konfigurasi
// AI Global admin (AIConfig id 1, fallback env AI_BASE_URL/AI_API_KEY/
// AI_MODEL). File ini menambahkan provider yang dikelola admin lewat
// Settings (tabel ai_provider_configs, model AIProviderConfig) dan
// resolusi provider+model PER PROMPT untuk chat:
//
//   - Admin: CRUD provider (nama, base URL, key, daftar model) + ambil
//     daftar model dari provider (GET {base}/models — bentuk OpenAI
//     {"data":[{"id":...}]} maupun Ollama {"models":[{"name":...}]})
//     + tes koneksi. Key disimpan terenkripsi AES-256-GCM dengan pola
//     yang sama seperti AIConfig (keyEnc, lihat crypto.go); key tidak
//     pernah dikembalikan ke klien (hanya hasKey).
//   - User: GET /api/ai-providers (tanpa key) untuk dropdown composer.
//   - Chat: POST /chat menerima providerId + model; pilihan dicatat di
//     AgentRun dan ChatMessage (kolom provider/model) supaya riwayat
//     konsisten; kuota tetap dihitung per run (recordAIUsage memakai
//     provider.Model hasil resolusi).
//
// Default: bila tabel provider masih kosong, konfigurasi AI lama
// (AIConfig/env) di-seed sekali menjadi provider "Default" — jadi
// default lama tetap berlaku tanpa migrasi manual, dan admin tinggal
// menambah provider lain / memuat daftar model 9router. Seed hanya
// terjadi bila konfigurasi lama memang ada; instalasi baru tanpa AI
// tetap tanpa provider (chat menolak dengan 500 seperti sebelumnya).
//
// Ollama lokal didukung tanpa key: API key boleh kosong — header
// Authorization hanya dikirim bila key terisi (lihat AIProvider.setAuth
// di ai.go) — dan daftar modelnya dibaca dari bentuk {"models": [...]}.
package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"

	"webbuilder/internal/database/models"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// maxProviderModels adalah batas model yang disimpan per provider —
// sama seperti batas listAIModels (9router mengembalikan ~100 model).
const maxProviderModels = 400

// parseProviderModels mengubah JSON array di AIProviderConfig.Models
// menjadi daftar ID model (tahan terhadap isi rusak: kembalikan kosong).
func parseProviderModels(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	var out []string
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return nil
	}
	clean := out[:0]
	for _, m := range out {
		if m = strings.TrimSpace(m); m != "" {
			clean = append(clean, m)
		}
	}
	return clean
}

func marshalProviderModels(models []string) string {
	if len(models) == 0 {
		return "[]"
	}
	b, _ := json.Marshal(models)
	return string(b)
}

// normalizeProviderModels merapikan daftar model: trim, buang kosong +
// duplikat, urut, batasi maxProviderModels.
func normalizeProviderModels(in []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(in))
	for _, m := range in {
		m = strings.TrimSpace(m)
		if m == "" || seen[m] {
			continue
		}
		seen[m] = true
		out = append(out, m)
	}
	sort.Strings(out)
	if len(out) > maxProviderModels {
		out = out[:maxProviderModels]
	}
	return out
}

// fetchModelsFromProvider mengambil daftar model dari GET {baseURL}/models.
// Menerima bentuk OpenAI ({"data":[{"id":...}]}) dan Ollama
// ({"models":[{"name":...}]}). Dipakai admin (listAIModels lama +
// fetch-models per provider).
func fetchModelsFromProvider(ctx context.Context, baseURL, key string) ([]string, error) {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		return nil, fmt.Errorf("base URL kosong")
	}
	req, err := http.NewRequestWithContext(ctx, "GET", baseURL+"/models", nil)
	if err != nil {
		return nil, fmt.Errorf("base URL tidak valid: %w", err)
	}
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	resp, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
	if err != nil {
		return nil, fmt.Errorf("gagal mengambil daftar model: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("provider menolak daftar model (HTTP %d)", resp.StatusCode)
	}
	var parsed struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
		Models []struct {
			Name string `json:"name"`
		} `json:"models"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("format daftar model tidak dikenali")
	}
	ids := make([]string, 0, len(parsed.Data)+len(parsed.Models))
	for _, m := range parsed.Data {
		if m.ID != "" {
			ids = append(ids, m.ID)
		}
	}
	for _, m := range parsed.Models {
		if m.Name != "" {
			ids = append(ids, m.Name)
		}
	}
	return normalizeProviderModels(ids), nil
}

// decryptProviderKey mendekripsi key tersimpan satu provider. Pola sama
// seperti getEffectiveAIProvider: key plaintext lama dimigrasikan ke
// terenkripsi saat dibaca (bukan diam-diam dibiarkan plaintext).
func decryptProviderKey(db *gorm.DB, cfg *models.AIProviderConfig) string {
	if cfg.APIKey == "" {
		return ""
	}
	if dec, err := keyEnc.Decrypt(cfg.APIKey); err == nil {
		return dec
	}
	if enc, eerr := keyEnc.Encrypt(cfg.APIKey); eerr == nil {
		db.Model(cfg).Update("api_key", enc)
	}
	return cfg.APIKey
}

// providerToAIProvider mengubah baris provider menjadi AIProvider siap
// pakai (key terdekripsi). Model diisi caller (resolveAIProvider) karena
// model bisa di-override per prompt.
func providerToAIProvider(db *gorm.DB, cfg *models.AIProviderConfig) *AIProvider {
	return &AIProvider{BaseURL: strings.TrimRight(cfg.BaseURL, "/"), APIKey: decryptProviderKey(db, cfg)}
}

// ensureDefaultProviderSeeded membuat provider "Default" dari konfigurasi
// AI lama (AIConfig id 1, fallback env AI_*) bila tabel provider masih
// kosong. Idempoten: tidak melakukan apa pun bila sudah ada satu baris.
// Mengembalikan true bila seed dibuat.
func ensureDefaultProviderSeeded(db *gorm.DB) bool {
	var n int64
	db.Model(&models.AIProviderConfig{}).Count(&n)
	if n > 0 {
		return false
	}
	var cfg models.AIConfig
	db.First(&cfg, 1)
	baseURL, key, model := cfg.BaseURL, cfg.APIKey, cfg.Model
	if baseURL != "" && key != "" {
		// Key AIConfig tersimpan terenkripsi ("enc1:...") — atau plaintext
		// lama. Dekripsi dulu supaya seed tidak mengenkripsi ganda
		// (dekripsi sekali di bawah akan mengembalikan "enc1:..." bila
		// key sudah terenkripsi dua kali).
		if dec, err := keyEnc.Decrypt(key); err == nil {
			key = dec
		}
	}
	if baseURL == "" {
		baseURL = strings.TrimRight(os.Getenv("AI_BASE_URL"), "/")
		key = os.Getenv("AI_API_KEY")
		model = os.Getenv("AI_MODEL")
	}
	if baseURL == "" || model == "" {
		return false
	}
	enc := key
	if key != "" {
		if e, err := keyEnc.Encrypt(key); err == nil {
			enc = e
		}
	}
	modelsJSON := "[]"
	if model != "" {
		modelsJSON = marshalProviderModels([]string{model})
	}
	db.Create(&models.AIProviderConfig{
		Name: "Default", BaseURL: strings.TrimRight(baseURL, "/"), APIKey: enc,
		Models: modelsJSON, IsDefault: true, Enabled: true,
	})
	return true
}

// defaultProviderRow mengembalikan provider default: baris IsDefault yang
// aktif, fallback baris aktif pertama (ID terkecil). Nil bila tabel kosong.
func defaultProviderRow(db *gorm.DB) *models.AIProviderConfig {
	var cfg models.AIProviderConfig
	if err := db.Where("is_default = ? AND enabled = ?", true, true).Order("id ASC").First(&cfg).Error; err == nil {
		return &cfg
	}
	if err := db.Where("enabled = ?", true).Order("id ASC").First(&cfg).Error; err == nil {
		return &cfg
	}
	return nil
}

// resolveAIProvider menyelesaikan pilihan provider+model satu prompt
// menjadi AIProvider siap pakai + nama tampil provider (untuk dicatat di
// AgentRun/ChatMessage). Aturan:
//   - providerId > 0: baris itu (harus ada + aktif). Model kosong -> model
//     pertama di daftar provider; model di luar daftar (bila daftar
//     terisi) -> error 400 dari caller.
//   - providerId == 0: provider default (seed dulu bila tabel kosong);
//     bila tetap tidak ada provider -> konfigurasi AI lama (AIConfig/env),
//     dengan model override bila diminta.
//   - Key boleh kosong (Ollama lokal); configured() hanya mensyaratkan
//     base URL + model.
//
// Seed dipanggil di awal untuk KEDUA cabang: tanpa ini, chat pertama ke
// instalasi baru yang mengirim providerId eksplisit (mis. 1, dari
// dropdown yang dimuat sebelum seed sempat jalan) gagal 400 "provider #1
// tidak ditemukan" padahal Default bisa dibuat otomatis dari konfigurasi
// lama/env. Seed idempoten (no-op bila tabel sudah berisi baris), jadi
// provider yang dihapus admin tidak pernah dibuat ulang diam-diam.
func resolveAIProvider(db *gorm.DB, providerID uint, model string) (*AIProvider, string, error) {
	model = strings.TrimSpace(model)
	ensureDefaultProviderSeeded(db)
	if providerID > 0 {
		var cfg models.AIProviderConfig
		if err := db.First(&cfg, providerID).Error; err != nil {
			return nil, "", fmt.Errorf("provider #%d tidak ditemukan", providerID)
		}
		if !cfg.Enabled {
			return nil, "", fmt.Errorf("provider %q sedang nonaktif", cfg.Name)
		}
		list := parseProviderModels(cfg.Models)
		if model == "" {
			if len(list) == 0 {
				return nil, "", fmt.Errorf("provider %q belum punya daftar model — pilih model atau minta admin memuat daftar model", cfg.Name)
			}
			model = list[0]
		} else if len(list) > 0 {
			found := false
			for _, m := range list {
				if m == model {
					found = true
					break
				}
			}
			if !found {
				return nil, "", fmt.Errorf("model %q tidak terdaftar di provider %q", model, cfg.Name)
			}
		}
		p := providerToAIProvider(db, &cfg)
		p.Model = model
		return p, cfg.Name, nil
	}
	// (Seed sudah dipanggil di awal fungsi — lihat komentar di atas.)
	if cfg := defaultProviderRow(db); cfg != nil {
		list := parseProviderModels(cfg.Models)
		if model == "" {
			if len(list) == 0 {
				return nil, "", fmt.Errorf("provider %q belum punya daftar model — pilih model atau minta admin memuat daftar model", cfg.Name)
			}
			model = list[0]
		} else if len(list) > 0 {
			found := false
			for _, m := range list {
				if m == model {
					found = true
					break
				}
			}
			if !found {
				return nil, "", fmt.Errorf("model %q tidak terdaftar di provider %q", model, cfg.Name)
			}
		}
		p := providerToAIProvider(db, cfg)
		p.Model = model
		return p, cfg.Name, nil
	}
	// Belum ada provider sama sekali: konfigurasi AI lama (AIConfig/env).
	p := getEffectiveAIProvider(db)
	if model != "" {
		p.Model = model
	}
	return p, "Default", nil
}

// providerPublic adalah bentuk provider untuk klien (dropdown composer +
// admin): key TIDAK PERNAH disertakan, hanya hasKey.
func providerPublic(db *gorm.DB, cfg models.AIProviderConfig) gin.H {
	return gin.H{
		"id": cfg.ID, "name": cfg.Name, "baseUrl": cfg.BaseURL,
		"models": parseProviderModels(cfg.Models),
		"isDefault": cfg.IsDefault, "enabled": cfg.Enabled,
		"hasKey": cfg.APIKey != "",
	}
}

// listAIProviders mengembalikan provider untuk pemilih di composer chat
// (semua user login; hanya yang aktif). Seed dari konfigurasi lama dulu
// supaya instalasi lama langsung punya opsi "Default".
func listAIProviders(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		ensureDefaultProviderSeeded(db)
		var rows []models.AIProviderConfig
		db.Where("enabled = ?", true).Order("is_default DESC, id ASC").Find(&rows)
		out := make([]gin.H, 0, len(rows))
		for _, r := range rows {
			out = append(out, providerPublic(db, r))
		}
		c.JSON(200, gin.H{"providers": out})
	}
}

// ── Admin: CRUD provider ──

func requireAdminProvider(c *gin.Context, db *gorm.DB) bool {
	if !isAdmin(db, c.GetUint("userID")) {
		c.JSON(403, gin.H{"message": "Khusus admin"})
		return false
	}
	return true
}

func listAdminAIProviders(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		if !requireAdminProvider(c, db) {
			return
		}
		ensureDefaultProviderSeeded(db)
		var rows []models.AIProviderConfig
		db.Order("id ASC").Find(&rows)
		out := make([]gin.H, 0, len(rows))
		for _, r := range rows {
			out = append(out, providerPublic(db, r))
		}
		c.JSON(200, gin.H{"providers": out})
	}
}

func validProviderBaseURL(raw string) bool {
	u, err := url.Parse(strings.TrimSpace(raw))
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != ""
}

func createAIProvider(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		if !requireAdminProvider(c, db) {
			return
		}
		var req struct {
			Name      string   `json:"name"`
			BaseURL   string   `json:"baseUrl"`
			APIKey    string   `json:"apiKey"`
			Models    []string `json:"models"`
			IsDefault *bool    `json:"isDefault"`
			Enabled   *bool    `json:"enabled"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(400, gin.H{"message": "Data provider tidak valid"})
			return
		}
		req.Name = strings.TrimSpace(req.Name)
		req.BaseURL = strings.TrimRight(strings.TrimSpace(req.BaseURL), "/")
		if req.Name == "" || req.BaseURL == "" {
			c.JSON(400, gin.H{"message": "Nama dan base URL wajib diisi"})
			return
		}
		if !validProviderBaseURL(req.BaseURL) {
			c.JSON(400, gin.H{"message": "Base URL harus URL http(s) absolut"})
			return
		}
		enc := ""
		if req.APIKey != "" {
			e, err := keyEnc.Encrypt(req.APIKey)
			if err != nil {
				c.JSON(500, gin.H{"message": "Gagal enkripsi key"})
				return
			}
			enc = e
		}
		var n int64
		db.Model(&models.AIProviderConfig{}).Count(&n)
		isDefault := n == 0 // provider pertama otomatis jadi default
		if req.IsDefault != nil {
			isDefault = *req.IsDefault
		}
		enabled := true
		if req.Enabled != nil {
			enabled = *req.Enabled
		}
		if isDefault {
			db.Model(&models.AIProviderConfig{}).Where("is_default = ?", true).Update("is_default", false)
		}
		row := models.AIProviderConfig{
			Name: req.Name, BaseURL: req.BaseURL, APIKey: enc,
			Models: marshalProviderModels(normalizeProviderModels(req.Models)),
			IsDefault: isDefault, Enabled: enabled,
		}
		if err := db.Create(&row).Error; err != nil {
			c.JSON(500, gin.H{"message": "Gagal menyimpan provider"})
			return
		}
		c.JSON(201, gin.H{"provider": providerPublic(db, row)})
	}
}

func updateAIProvider(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		if !requireAdminProvider(c, db) {
			return
		}
		var row models.AIProviderConfig
		if err := db.First(&row, c.Param("id")).Error; err != nil {
			c.JSON(404, gin.H{"message": "Provider tidak ada"})
			return
		}
		var req struct {
			Name      *string   `json:"name"`
			BaseURL   *string   `json:"baseUrl"`
			APIKey    *string   `json:"apiKey"`
			Models    *[]string `json:"models"`
			IsDefault *bool     `json:"isDefault"`
			Enabled   *bool     `json:"enabled"`
		}
		// Models pointer: nil = "models" tidak ada di body (biarkan daftar
		// lama); non-nil walau [] = ganti daftar (boleh dikosongkan).
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(400, gin.H{"message": "Data provider tidak valid"})
			return
		}
		updates := map[string]interface{}{}
		if req.Name != nil {
			if strings.TrimSpace(*req.Name) == "" {
				c.JSON(400, gin.H{"message": "Nama wajib diisi"})
				return
			}
			updates["name"] = strings.TrimSpace(*req.Name)
		}
		if req.BaseURL != nil {
			bu := strings.TrimRight(strings.TrimSpace(*req.BaseURL), "/")
			if !validProviderBaseURL(bu) {
				c.JSON(400, gin.H{"message": "Base URL harus URL http(s) absolut"})
				return
			}
			updates["base_url"] = bu
		}
		if req.APIKey != nil && *req.APIKey != "" {
			enc, err := keyEnc.Encrypt(*req.APIKey)
			if err != nil {
				c.JSON(500, gin.H{"message": "Gagal enkripsi key"})
				return
			}
			updates["api_key"] = enc
		}
		if req.Models != nil {
			updates["models"] = marshalProviderModels(normalizeProviderModels(*req.Models))
		}
		if req.Enabled != nil {
			updates["enabled"] = *req.Enabled
		}
		if req.IsDefault != nil && *req.IsDefault {
			db.Model(&models.AIProviderConfig{}).Where("is_default = ? AND id <> ?", true, row.ID).Update("is_default", false)
			updates["is_default"] = true
		} else if req.IsDefault != nil {
			updates["is_default"] = false
		}
		if len(updates) > 0 {
			db.Model(&row).Updates(updates)
		}
		db.First(&row, row.ID)
		c.JSON(200, gin.H{"provider": providerPublic(db, row)})
	}
}

func deleteAIProvider(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		if !requireAdminProvider(c, db) {
			return
		}
		var row models.AIProviderConfig
		if err := db.First(&row, c.Param("id")).Error; err != nil {
			c.JSON(404, gin.H{"message": "Provider tidak ada"})
			return
		}
		wasDefault := row.IsDefault
		db.Delete(&row)
		if wasDefault {
			// Jangan biarkan tanpa default: promosikan provider aktif
			// pertama (ID terkecil) bila masih ada.
			var next models.AIProviderConfig
			if err := db.Where("enabled = ?", true).Order("id ASC").First(&next).Error; err == nil {
				db.Model(&next).Update("is_default", true)
			}
		}
		c.JSON(200, gin.H{"message": "Provider dihapus"})
	}
}

// fetchAIProviderModels mengambil daftar model dari provider (GET
// {base}/models) lalu menyimpannya ke baris provider. Dipakai admin
// sesudah menambah provider 9router supaya 100 modelnya langsung bisa
// dipilih di composer tanpa ketik manual.
func fetchAIProviderModels(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		if !requireAdminProvider(c, db) {
			return
		}
		var row models.AIProviderConfig
		if err := db.First(&row, c.Param("id")).Error; err != nil {
			c.JSON(404, gin.H{"message": "Provider tidak ada"})
			return
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Second)
		defer cancel()
		ids, err := fetchModelsFromProvider(ctx, row.BaseURL, decryptProviderKey(db, &row))
		if err != nil {
			c.JSON(502, gin.H{"message": err.Error()})
			return
		}
		db.Model(&row).Update("models", marshalProviderModels(ids))
		c.JSON(200, gin.H{"models": ids, "count": len(ids)})
	}
}

// probeChatCompletion adalah satu panggilan chat non-streaming kecil untuk
// tes koneksi provider ("Reply with exactly: connected"). Dipakai
// testAIProvider dan testAIConfig (platform.go).
func probeChatCompletion(ctx context.Context, baseURL, key, model string) (string, error) {
	body, _ := json.Marshal(map[string]interface{}{
		"model":      model,
		"messages":   []map[string]string{{"role": "user", "content": "Reply with exactly: connected"}},
		"max_tokens": 24,
		"stream":     false,
	})
	req, _ := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(baseURL, "/")+"/chat/completions", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	resp, err := (&http.Client{Timeout: 45 * time.Second}).Do(req)
	if err != nil {
		return "", fmt.Errorf("gagal menghubungi provider: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("HTTP %d — %s", resp.StatusCode, shortStr(strings.TrimSpace(string(raw)), 300))
	}
	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", fmt.Errorf("respons provider bukan JSON: %s", shortStr(string(raw), 160))
	}
	reply := ""
	if len(out.Choices) > 0 {
		reply = strings.TrimSpace(out.Choices[0].Message.Content)
	}
	if reply == "" {
		reply = "(200 OK, tanpa teks)"
	}
	return reply, nil
}

// testAIProvider menguji koneksi satu provider tersimpan (key dari DB,
// model dari body atau pertama di daftar).
func testAIProvider(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		if !requireAdminProvider(c, db) {
			return
		}
		var row models.AIProviderConfig
		if err := db.First(&row, c.Param("id")).Error; err != nil {
			c.JSON(404, gin.H{"message": "Provider tidak ada"})
			return
		}
		var req struct {
			Model string `json:"model"`
		}
		_ = c.ShouldBindJSON(&req)
		model := strings.TrimSpace(req.Model)
		if model == "" {
			if list := parseProviderModels(row.Models); len(list) > 0 {
				model = list[0]
			}
		}
		if model == "" {
			c.JSON(400, gin.H{"message": "Model belum diatur untuk provider ini"})
			return
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 40*time.Second)
		defer cancel()
		reply, err := probeChatCompletion(ctx, row.BaseURL, decryptProviderKey(db, &row), model)
		if err != nil {
			c.JSON(502, gin.H{"message": err.Error()})
			return
		}
		c.JSON(200, gin.H{"message": "Koneksi berhasil", "reply": reply, "model": model})
	}
}

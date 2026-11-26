package handler

import (
	"encoding/json"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"webbuilder/internal/database/models"
)

// ── Form backend otomatis ──
// Setiap proyek publish bisa menerima data formulir lewat endpoint publik
// POST /f/:token (tanpa auth, proteksi token + honeypot + rate limit).

// Rate limit in-memory: max 30 request/menit per IP per token.
type formRLEntry struct {
	count int
	start time.Time
}

var (
	formRLMu  sync.Mutex
	formRL    = map[string]*formRLEntry{}
	formRLOne sync.Once
)

func formRateAllowed(key string) bool {
	formRLOne.Do(func() {
		go func() {
			for {
				time.Sleep(5 * time.Minute)
				now := time.Now()
				formRLMu.Lock()
				for k, e := range formRL {
					if now.Sub(e.start) > 5*time.Minute {
						delete(formRL, k)
					}
				}
				formRLMu.Unlock()
			}
		}()
	})
	now := time.Now()
	formRLMu.Lock()
	defer formRLMu.Unlock()
	e, ok := formRL[key]
	if !ok || now.Sub(e.start) > time.Minute {
		formRL[key] = &formRLEntry{count: 1, start: now}
		return true
	}
	e.count++
	return e.count <= 30
}

func newFormToken() string {
	return "frm_" + randHex(12)
}

// POST /f/:token — publik, tanpa auth. Body: {data: object, hp: string honeypot}
func submitFormPublic(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		token := c.Param("token")
		var p models.Project
		if token == "" || db.Where("form_token = ?", token).First(&p).Error != nil {
			c.JSON(404, gin.H{"message": "Tidak ditemukan"})
			return
		}
		if !p.FormEnabled {
			c.JSON(403, gin.H{"message": "Formulir dinonaktifkan"})
			return
		}
		var req struct {
			Data map[string]interface{} `json:"data"`
			HP   string                 `json:"hp"`
		}
		if err := c.ShouldBindJSON(&req); err != nil || len(req.Data) == 0 {
			c.JSON(400, gin.H{"message": "Data tidak valid"})
			return
		}
		// Honeypot: bot yang mengisi field tersembunyi dapat respons palsu
		if req.HP != "" {
			c.JSON(200, gin.H{"ok": true})
			return
		}
		if !formRateAllowed(token + "|" + c.ClientIP()) {
			c.JSON(429, gin.H{"message": "Terlalu banyak, coba lagi nanti"})
			return
		}
		raw, _ := json.Marshal(req.Data)
		sub := models.FormSubmission{ProjectID: p.ID, Data: string(raw), IP: c.ClientIP()}
		db.Create(&sub)
		notify(db, p.UserID, "Formulir baru", p.Name+" menerima data formulir baru")
		fireWebhook(db, p.ID, "form.submission", map[string]interface{}{
			"submissionId": sub.ID,
			"data":         req.Data,
			"ip":           c.ClientIP(),
		})
		var owner models.User
		if db.First(&owner, p.UserID).Error == nil && owner.Email != "" {
			go sendMail(db, owner.Email, "Formulir baru: "+p.Name, "Situs "+p.Name+" baru saja menerima pengisian formulir:\n\n"+string(raw))
		}
		c.JSON(200, gin.H{"ok": true})
	}
}

// GET /api/projects/:id/forms — list submission, terbaru dulu
func listFormSubmissions(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, _, ok := requireProject(db, c, "viewer")
		if !ok {
			return
		}
		page := int(atoi(c.Query("page")))
		limit := int(atoi(c.Query("limit")))
		if page < 1 {
			page = 1
		}
		if limit < 1 {
			limit = 20
		}
		if limit > 100 {
			limit = 100
		}
		var total int64
		db.Model(&models.FormSubmission{}).Where("project_id = ?", p.ID).Count(&total)
		var subs []models.FormSubmission
		db.Where("project_id = ?", p.ID).Order("id DESC").
			Offset((page - 1) * limit).Limit(limit).Find(&subs)
		items := make([]gin.H, 0, len(subs))
		for _, s := range subs {
			var data interface{}
			if json.Unmarshal([]byte(s.Data), &data) != nil {
				data = s.Data
			}
			items = append(items, gin.H{
				"id": s.ID, "projectId": s.ProjectID, "data": data,
				"ip": s.IP, "createdAt": s.CreatedAt,
			})
		}
		c.JSON(200, gin.H{"items": items, "total": total})
	}
}

// DELETE /api/projects/:id/forms/:sid — owner only
func deleteFormSubmission(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, _, ok := requireProject(db, c, "owner")
		if !ok {
			return
		}
		var s models.FormSubmission
		if err := db.Where("id = ? AND project_id = ?", c.Param("sid"), p.ID).First(&s).Error; err != nil {
			c.JSON(404, gin.H{"message": "Tidak ditemukan"})
			return
		}
		db.Delete(&s)
		c.JSON(200, gin.H{"message": "Dihapus"})
	}
}

// GET /api/projects/:id/form-settings — backfill token bila kosong
func getFormSettings(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, _, ok := requireProject(db, c, "viewer")
		if !ok {
			return
		}
		if p.FormToken == "" {
			p.FormToken = newFormToken()
			db.Model(&p).Update("form_token", p.FormToken)
		}
		c.JSON(200, gin.H{
			"enabled": p.FormEnabled, "token": p.FormToken,
			"endpoint": formEndpoint(db, c, p.FormToken),
		})
	}
}

// PUT /api/projects/:id/form-settings {enabled} / {regenerate:true} — owner only
func updateFormSettings(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, _, ok := requireProject(db, c, "owner")
		if !ok {
			return
		}
		var req struct {
			Enabled    *bool `json:"enabled"`
			Regenerate bool  `json:"regenerate"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(400, gin.H{"message": "Data tidak valid"})
			return
		}
		if req.Enabled != nil {
			p.FormEnabled = *req.Enabled
			db.Model(&p).Update("form_enabled", p.FormEnabled)
		}
		if req.Regenerate {
			p.FormToken = newFormToken()
			db.Model(&p).Update("form_token", p.FormToken)
		}
		c.JSON(200, gin.H{
			"enabled": p.FormEnabled, "token": p.FormToken,
			"endpoint": formEndpoint(db, c, p.FormToken),
		})
	}
}

func formEndpoint(db *gorm.DB, c *gin.Context, token string) string {
	base := getSetting(db, "site_url")
	if base == "" {
		base = "https://" + c.Request.Host
	}
	return strings.TrimSuffix(base, "/") + "/f/" + token
}

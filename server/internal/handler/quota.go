package handler

import (
	"strconv"
	"time"

	"webbuilder/internal/database/models"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// ── Kuota plan + kontrol biaya AI ──

// userPlan: plan aktif user ("free"/"pro"/"team"). Subscription yang
// expired otomatis turun ke free via getSubscription (payment.go).
func userPlan(db *gorm.DB, uid uint) string {
	var u models.User
	if db.Select("is_admin").First(&u, uid).Error == nil && u.IsAdmin {
		return "admin"
	}
	return getSubscription(db, uid).Plan
}

// planQuota: batas (maxProyek, maxTokenBulanan) per plan.
// Dibaca dari settings agar admin bisa ubah tanpa deploy.
// Key: quota_projects_<plan>, quota_tokens_<plan>.
func planQuota(db *gorm.DB, plan string) (maxProjects int, maxTokensPerMonth int) {
	// Admin tidak dibatasi settings quota maupun pemakaian bulanan.
	if plan == "admin" {
		maxInt := int(^uint(0) >> 1)
		return maxInt, maxInt
	}
	defs := map[string][2]int{
		"free":  {3, 100000},
		"pro":   {50, 2000000},
		"team":  {999999, 20000000},
		"admin": {999999999, 2147483647},
	}
	d, ok := defs[plan]
	if !ok {
		d = defs["free"]
	}
	maxProjects = d[0]
	maxTokensPerMonth = d[1]
	if v := getSetting(db, "quota_projects_"+plan); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			maxProjects = n
		}
	}
	if v := getSetting(db, "quota_tokens_"+plan); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			maxTokensPerMonth = n
		}
	}
	return maxProjects, maxTokensPerMonth
}

// monthUsage: agregasi AIUsage bulan berjalan. Return (jumlahPanggilan, totalToken).
func monthUsage(db *gorm.DB, uid uint) (calls int64, tokens int64) {
	month := time.Now().Format("2006-01")
	db.Model(&models.AIUsage{}).
		Where("user_id = ? AND strftime('%Y-%m', created_at) = ?", uid, month).
		Select("COALESCE(SUM(tokens),0)").Scan(&tokens)
	db.Model(&models.AIUsage{}).
		Where("user_id = ? AND strftime('%Y-%m', created_at) = ?", uid, month).
		Count(&calls)
	return calls, tokens
}

// recordAIUsage: catat satu pemanggilan AI. Provider tidak memberi usage,
// jadi estimasi token ≈ (len(prompt)+len(completion))/4.
func recordAIUsage(db *gorm.DB, uid uint, model, prompt, completion string) {
	toks := (len(prompt) + len(completion)) / 4
	if toks < 1 {
		toks = 1
	}
	db.Create(&models.AIUsage{UserID: uid, Tokens: toks, Model: model})
}

// ── Admin: daftar user teratas pemakaian AI bulan ini ──

func adminAIUsage(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		month := time.Now().Format("2006-01")
		type row struct {
			UserID uint
			Calls  int64
			Tokens int64
		}
		var rows []row
		db.Model(&models.AIUsage{}).
			Select("user_id, COUNT(*) AS calls, COALESCE(SUM(tokens),0) AS tokens").
			Where("strftime('%Y-%m', created_at) = ?", month).
			Group("user_id").Order("tokens DESC").Limit(50).
			Scan(&rows)
		out := []gin.H{}
		for _, r := range rows {
			var u models.User
			db.Select("name", "email").First(&u, r.UserID)
			out = append(out, gin.H{
				"userId": r.UserID, "name": u.Name, "email": u.Email,
				"plan":  userPlan(db, r.UserID),
				"calls": r.Calls, "tokens": r.Tokens,
			})
		}
		c.JSON(200, gin.H{"month": month, "users": out})
	}
}

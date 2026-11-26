package handler

import (
	"fmt"
	"strings"
	"sync"
	"time"

	"webbuilder/internal/database/models"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"gorm.io/gorm"
)

// ── Admin extras ──

// POST /api/admin/users/:id/impersonate — admin login sebagai user (mode support)
func impersonateUser(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var target models.User
		if err := db.First(&target, c.Param("id")).Error; err != nil {
			c.JSON(404, gin.H{"message": "User tidak ditemukan"})
			return
		}
		if target.Suspended {
			c.JSON(403, gin.H{"message": "User sedang disuspend"})
			return
		}
		adminID := c.GetUint("userID")
		t := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
			"uid":             target.ID,
			"impersonated_by": adminID,
			"exp":             time.Now().Add(30 * time.Minute).Unix(),
		})
		s, err := t.SignedString(jwtSecret())
		if err != nil {
			c.JSON(500, gin.H{"message": "Gagal buat token"})
			return
		}
		audit(db, adminID, "impersonate", target.Email, c.ClientIP())
		c.JSON(200, gin.H{"token": s})
	}
}

// GET /api/admin/revenue — rekap pembayaran paid
func adminRevenue(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var total int64
		db.Model(&models.Payment{}).Where("status = ?", "paid").Select("COALESCE(SUM(amount),0)").Scan(&total)
		type dayRow struct {
			Date  string `json:"date"`
			Total int64  `json:"total"`
		}
		var byDay []dayRow
		db.Model(&models.Payment{}).
			Select("date(created_at) AS date, COALESCE(SUM(amount),0) AS total").
			Where("status = ? AND created_at >= ?", "paid", time.Now().AddDate(0, 0, -30)).
			Group("date(created_at)").Order("date").Scan(&byDay)
		type planRow struct {
			Plan  string `json:"plan"`
			Total int64  `json:"total"`
			Count int64  `json:"count"`
		}
		var byPlan []planRow
		db.Model(&models.Payment{}).
			Select("plan, COALESCE(SUM(amount),0) AS total, COUNT(*) AS count").
			Where("status = ?", "paid").Group("plan").Scan(&byPlan)
		if byDay == nil {
			byDay = []dayRow{}
		}
		if byPlan == nil {
			byPlan = []planRow{}
		}
		c.JSON(200, gin.H{"total": total, "byDay": byDay, "byPlan": byPlan})
	}
}

// GET /api/public-settings — tanpa auth (pengumuman & status maintenance)
func publicSettings(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.JSON(200, gin.H{
			"announcement": getSetting(db, "announcement"),
			"maintenance":  getSetting(db, "maintenance_mode") == "1",
		})
	}
}

// ── Maintenance mode ──

var maintCache = struct {
	sync.Mutex
	val string
	exp time.Time
}{}

func maintenanceOn(db *gorm.DB) bool {
	maintCache.Lock()
	defer maintCache.Unlock()
	if time.Now().Before(maintCache.exp) {
		return maintCache.val == "1"
	}
	maintCache.val = getSetting(db, "maintenance_mode")
	maintCache.exp = time.Now().Add(30 * time.Second)
	return maintCache.val == "1"
}

// maintenanceMiddleware: saat maintenance_mode=1, semua /api/* kecuali yang
// dikecualikan → 503 untuk non-admin. Admin tetap bisa lewat.
func maintenanceMiddleware(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p := c.Request.URL.Path
		if !strings.HasPrefix(p, "/api/") {
			c.Next()
			return
		}
		switch {
		case p == "/api/health", p == "/api/public-settings", p == "/api/billing/webhook":
			c.Next()
			return
		case strings.HasPrefix(p, "/api/auth/"):
			c.Next()
			return
		}
		if !maintenanceOn(db) {
			c.Next()
			return
		}
		if isAdmin(db, c.GetUint("userID")) {
			c.Next()
			return
		}
		c.JSON(503, gin.H{"error": "maintenance", "message": "Server sedang maintenance, coba lagi nanti"})
		c.Abort()
	}
}

// POST /api/admin/broadcast — kirim notifikasi in-app ke seluruh user
func adminBroadcastNotification(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Title string `json:"title" binding:"required"`
			Body  string `json:"body" binding:"required"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(400, gin.H{"message": "Title dan Body wajib"})
			return
		}
		var uids []uint
		db.Model(&models.User{}).Pluck("id", &uids)
		for _, uid := range uids {
			notify(db, uid, req.Title, req.Body)
		}
		audit(db, c.GetUint("userID"), "broadcast_notification", req.Title, c.ClientIP())
		c.JSON(200, gin.H{"message": fmt.Sprintf("Notifikasi dikirim ke %d pengguna", len(uids))})
	}
}

// POST /api/admin/users/:id/plan — update paket & tanggal kadaluarsa user manual
func adminUpdateUserPlan(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Plan    string `json:"plan" binding:"required"`
			Days    int    `json:"days"`
			Suspend *bool  `json:"suspend"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(400, gin.H{"message": "Plan wajib"})
			return
		}
		uidStr := c.Param("id")
		var target models.User
		if err := db.First(&target, uidStr).Error; err != nil {
			c.JSON(404, gin.H{"message": "User tidak ditemukan"})
			return
		}
		if req.Suspend != nil {
			db.Model(&target).Update("suspended", *req.Suspend)
		}
		var sub models.Subscription
		if err := db.Where("user_id = ?", target.ID).First(&sub).Error; err != nil {
			sub = models.Subscription{UserID: target.ID}
		}
		sub.Plan = req.Plan
		sub.Status = "active"
		if req.Days > 0 {
			exp := time.Now().AddDate(0, 0, req.Days)
			sub.ExpiresAt = &exp
		} else {
			sub.ExpiresAt = nil
		}
		db.Save(&sub)
		audit(db, c.GetUint("userID"), "update_user_plan", fmt.Sprintf("User %d -> %s (%d days)", target.ID, req.Plan, req.Days), c.ClientIP())
		c.JSON(200, gin.H{"message": "Plan berhasil diperbarui"})
	}
}

// POST /api/admin/maintenance — set toggle maintenance
func adminToggleMaintenance(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Enabled bool `json:"enabled"`
		}
		c.ShouldBindJSON(&req)
		val := "0"
		if req.Enabled {
			val = "1"
		}
		db.Where("key = ?", "maintenance_mode").Assign(models.PlatformSetting{Value: val}).FirstOrCreate(&models.PlatformSetting{Key: "maintenance_mode"})
		maintCache.Lock()
		maintCache.val = val
		maintCache.exp = time.Now().Add(30 * time.Second)
		maintCache.Unlock()
		audit(db, c.GetUint("userID"), "toggle_maintenance", val, c.ClientIP())
		c.JSON(200, gin.H{"message": "Maintenance mode diperbarui", "enabled": req.Enabled})
	}
}

// GET /api/admin/export/users — export CSV data user
func adminExportUsersCSV(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var users []models.User
		db.Order("id DESC").Find(&users)
		c.Header("Content-Type", "text/csv")
		c.Header("Content-Disposition", "attachment;filename=users_export.csv")
		var sb strings.Builder
		sb.WriteString("ID,Name,Email,IsAdmin,Suspended,CreatedAt\n")
		for _, u := range users {
			sb.WriteString(fmt.Sprintf("%d,\"%s\",\"%s\",%t,%t,\"%s\"\n",
				u.ID, strings.ReplaceAll(u.Name, "\"", "\"\""), strings.ReplaceAll(u.Email, "\"", "\"\""),
				u.IsAdmin, u.Suspended, u.CreatedAt.Format(time.RFC3339)))
		}
		c.String(200, sb.String())
	}
}

// GET /api/admin/export/revenue — export CSV data transaksi
func adminExportRevenueCSV(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var payments []models.Payment
		db.Where("status = ?", "paid").Order("id DESC").Find(&payments)
		c.Header("Content-Type", "text/csv")
		c.Header("Content-Disposition", "attachment;filename=revenue_export.csv")
		var sb strings.Builder
		sb.WriteString("ID,UserID,OrderID,Plan,Amount,Status,CreatedAt\n")
		for _, p := range payments {
			sb.WriteString(fmt.Sprintf("%d,%d,\"%s\",\"%s\",%d,\"%s\",\"%s\"\n",
				p.ID, p.UserID, p.OrderID, p.Plan, p.Amount, p.Status, p.CreatedAt.Format(time.RFC3339)))
		}
		c.String(200, sb.String())
	}
}

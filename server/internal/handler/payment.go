package handler

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"time"

	"webbuilder/internal/database/models"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

var planPrices = map[string]int64{"pro": 99000, "team": 299000}

func getSubscription(db *gorm.DB, uid uint) *models.Subscription {
	var s models.Subscription
	if err := db.Where("user_id = ?", uid).First(&s).Error; err != nil {
		s = models.Subscription{UserID: uid, Plan: "free", Status: "active"}
		db.Create(&s)
	}
	// expired -> turun ke free
	if s.Plan != "free" && s.ExpiresAt != nil && time.Now().After(*s.ExpiresAt) {
		db.Model(&s).Updates(map[string]interface{}{"plan": "free", "status": "expired"})
		s.Plan = "free"
	}
	return &s
}

func checkoutPlan(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := c.GetUint("userID")
		var req struct {
			Plan string `json:"plan" binding:"required"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(400, gin.H{"message": "Plan wajib"})
			return
		}
		amount, ok := planPrices[req.Plan]
		if !ok {
			c.JSON(400, gin.H{"message": "Plan tidak valid"})
			return
		}
		var u models.User
		db.First(&u, uid)
		orderID := fmt.Sprintf("WB-%d-%d", uid, time.Now().Unix())
		webhookURL := siteBaseURL(db) + "/api/billing/webhook"
		out, err := exec.Command("/home/hatch/workspace/skills/clipkupay/bin/clipkupay",
			"create", "--order-id", orderID, "--amount", fmt.Sprintf("%d", amount),
			"--channel", "qris", "--name", u.Name, "--email", u.Email,
			"--webhook-url", webhookURL).CombinedOutput()
		if err != nil {
			c.JSON(500, gin.H{"message": "Gagal buat pembayaran: " + string(out)[:200]})
			return
		}
		var resp struct {
			PayURL string `json:"pay_url"`
			QR     string `json:"qr"`
			Status string `json:"status"`
		}
		json.Unmarshal(out, &resp)
		payURL := resp.PayURL
		if payURL == "" {
			payURL = resp.QR
		}
		db.Create(&models.Payment{
			UserID: uid, OrderID: orderID, Plan: req.Plan,
			Amount: amount, Status: "pending", PayURL: payURL,
		})
		audit(db, uid, "billing.checkout", req.Plan+" "+orderID, c.ClientIP())
		c.JSON(200, gin.H{"orderId": orderID, "payUrl": payURL, "amount": amount})
	}
}

func paymentStatus(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := c.GetUint("userID")
		var p models.Payment
		if err := db.Where("order_id = ? AND user_id = ?", c.Param("orderId"), uid).First(&p).Error; err != nil {
			c.JSON(404, gin.H{"message": "Tidak ada"})
			return
		}
		// cek ke Clipkupay
		out, err := exec.Command("/home/hatch/workspace/skills/clipkupay/bin/clipkupay",
			"get", "--order-id", p.OrderID).CombinedOutput()
		if err == nil {
			var resp struct {
				Status string `json:"status"`
			}
			json.Unmarshal(out, &resp)
			st := resp.Status
			if st == "paid" || st == "success" || st == "settlement" {
				activateSubscription(db, &p)
			} else if st != "" {
				db.Model(&p).Update("status", st)
			}
			db.First(&p, p.ID)
		}
		c.JSON(200, gin.H{"status": p.Status, "plan": p.Plan})
	}
}

func activateSubscription(db *gorm.DB, p *models.Payment) {
	if p.Status == "paid" {
		return
	}
	db.Model(p).Update("status", "paid")
	exp := time.Now().AddDate(0, 1, 0)
	var s models.Subscription
	db.Where("user_id = ?", p.UserID).FirstOrCreate(&s, models.Subscription{UserID: p.UserID})
	db.Model(&s).Updates(map[string]interface{}{
		"plan": p.Plan, "status": "active", "expires_at": exp,
	})
	notify(db, p.UserID, "Pembayaran berhasil", "Plan "+p.Plan+" aktif sampai "+exp.Format("02 Jan 2006"))
	audit(db, p.UserID, "billing.paid", p.OrderID, "")
}

// Webhook dari Clipkupay (tanpa auth JWT)
func billingWebhook(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			OrderID string `json:"order_id"`
			Status  string `json:"status"`
		}
		c.ShouldBindJSON(&req)
		if req.OrderID == "" {
			c.JSON(400, gin.H{"message": "order_id wajib"})
			return
		}
		var p models.Payment
		if err := db.Where("order_id = ?", req.OrderID).First(&p).Error; err != nil {
			c.JSON(404, gin.H{"message": "Tidak ada"})
			return
		}
		// verifikasi ulang ke Clipkupay (sumber kebenaran)
		out, err := exec.Command("/home/hatch/workspace/skills/clipkupay/bin/clipkupay",
			"get", "--order-id", p.OrderID).CombinedOutput()
		if err != nil {
			c.JSON(500, gin.H{"message": "Verifikasi gagal"})
			return
		}
		var resp struct {
			Status string `json:"status"`
		}
		json.Unmarshal(out, &resp)
		if resp.Status == "paid" || resp.Status == "success" || resp.Status == "settlement" {
			activateSubscription(db, &p)
		}
		c.JSON(200, gin.H{"message": "OK"})
	}
}

func getBilling(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := c.GetUint("userID")
		sub := getSubscription(db, uid)
		plans := []gin.H{
			{"name": "Free", "id": "free", "price": "Rp 0", "features": []string{"10 proyek", "1M token AI", "Preview"}},
			{"name": "Pro", "id": "pro", "price": "Rp 99rb/bln", "features": []string{"Unlimited proyek", "10M token AI", "Deployment", "Custom domain"}, "popular": true},
			{"name": "Team", "id": "team", "price": "Rp 299rb/bln", "features": []string{"Semua Pro", "50M token AI", "Kolaborasi tim", "Prioritas support"}},
		}
		var pays []models.Payment
		db.Where("user_id = ?", uid).Order("id DESC").Limit(10).Find(&pays)
		c.JSON(200, gin.H{"plan": sub.Plan, "expiresAt": sub.ExpiresAt, "plans": plans, "payments": pays})
	}
}

func getUsage(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := c.GetUint("userID")
		plan := userPlan(db, uid)
		maxProjects, maxTokens := planQuota(db, plan)
		calls, tokensUsed := monthUsage(db, uid)
		var totalTokens int64
		db.Model(&models.AIUsage{}).Where("user_id = ?", uid).Select("COALESCE(SUM(tokens),0)").Scan(&totalTokens)
		var projects int64
		db.Model(&models.Project{}).Where("user_id = ?", uid).Count(&projects)
		var deployments int64
		db.Model(&models.Deployment{}).Where("user_id = ?", uid).Count(&deployments)
		c.JSON(200, gin.H{
			"plan":         plan,
			"projectsUsed": projects, "projectsLimit": maxProjects,
			"tokensUsed": tokensUsed, "tokensLimit": maxTokens,
			"aiCalls": calls,
			// kompatibilitas lama
			"tokens": totalTokens, "requests": calls,
			"projects": projects, "deployments": deployments,
			"limits": gin.H{"tokens": maxTokens, "projects": maxProjects, "deployments": 100},
		})
	}
}

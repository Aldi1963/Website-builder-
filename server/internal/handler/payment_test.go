package handler

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"webbuilder/internal/database/models"

	"github.com/gin-gonic/gin"
)

func TestGetSubscriptionDowngradesExpired(t *testing.T) {
	db := openTestDB(t)
	u := makeUser(t, db, "sub@x.id", "rahasia1")

	// User baru: subscription free dibuat otomatis.
	s := getSubscription(db, u.ID)
	if s.Plan != "free" || s.Status != "active" {
		t.Fatalf("user baru: mau free/active, dapat %s/%s", s.Plan, s.Status)
	}
	// Pro yang kedaluwarsa turun ke free DAN baris DB ikut diperbarui.
	past := time.Now().Add(-24 * time.Hour)
	db.Model(&models.Subscription{}).Where("user_id = ?", u.ID).Updates(map[string]interface{}{
		"plan": "pro", "status": "active", "expires_at": past,
	})
	s = getSubscription(db, u.ID)
	if s.Plan != "free" {
		t.Fatalf("pro kedaluwarsa: mau free, dapat %s", s.Plan)
	}
	var stored models.Subscription
	db.Where("user_id = ?", u.ID).First(&stored)
	if stored.Plan != "free" || stored.Status != "expired" {
		t.Fatalf("baris DB tidak diturunkan: %s/%s", stored.Plan, stored.Status)
	}
	// Pro yang masih berlaku tetap pro.
	future := time.Now().Add(30 * 24 * time.Hour)
	db.Model(&models.Subscription{}).Where("user_id = ?", u.ID).Updates(map[string]interface{}{
		"plan": "pro", "status": "active", "expires_at": future,
	})
	if s := getSubscription(db, u.ID); s.Plan != "pro" {
		t.Fatalf("pro aktif: mau pro, dapat %s", s.Plan)
	}
}

func TestActivateSubscription(t *testing.T) {
	db := openTestDB(t)
	u := makeUser(t, db, "bayar@x.id", "rahasia1")
	p := models.Payment{UserID: u.ID, OrderID: "WB-1-test", Plan: "pro", Amount: 99000, Status: "pending"}
	db.Create(&p)

	activateSubscription(db, &p)

	var paid models.Payment
	db.Where("order_id = ?", "WB-1-test").First(&paid)
	if paid.Status != "paid" {
		t.Fatalf("payment: mau paid, dapat %s", paid.Status)
	}
	var s models.Subscription
	db.Where("user_id = ?", u.ID).First(&s)
	if s.Plan != "pro" || s.Status != "active" || s.ExpiresAt == nil {
		t.Fatalf("subscription: mau pro/active + expiry, dapat %+v", s)
	}
	if time.Until(*s.ExpiresAt) < 27*24*time.Hour || time.Until(*s.ExpiresAt) > 32*24*time.Hour {
		t.Fatalf("expiry bukan ~1 bulan: %v", s.ExpiresAt)
	}
	// Idempoten: aktivasi kedua tidak boleh memperpanjang expiry / membuat
	// notifikasi kedua. Webhook yang datang ganda tidak boleh memberi 2 bulan.
	firstExp := *s.ExpiresAt
	var notifs int64
	db.Model(&models.Notification{}).Where("user_id = ?", u.ID).Count(&notifs)
	activateSubscription(db, &paid)
	db.Where("user_id = ?", u.ID).First(&s)
	if !s.ExpiresAt.Equal(firstExp) {
		t.Fatalf("aktivasi ganda memperpanjang expiry: %v -> %v", firstExp, s.ExpiresAt)
	}
	var notifs2 int64
	db.Model(&models.Notification{}).Where("user_id = ?", u.ID).Count(&notifs2)
	if notifs2 != notifs {
		t.Fatalf("aktivasi ganda menambah notifikasi: %d -> %d", notifs, notifs2)
	}
}

func TestBillingWebhookValidationPaths(t *testing.T) {
	db := openTestDB(t)
	h := billingWebhook(db)
	do := func(body string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/api/billing/webhook", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		c, _ := gin.CreateTestContext(w)
		c.Request = req
		h(c)
		return w
	}
	// Tanpa order_id -> 400 (belum menyentuh gateway).
	if w := do(`{}`); w.Code != 400 {
		t.Fatalf("tanpa order_id: mau 400, dapat %d", w.Code)
	}
	// order_id tidak dikenal -> 404 (belum menyentuh gateway).
	if w := do(`{"order_id":"WB-tidak-ada","status":"paid"}`); w.Code != 404 {
		t.Fatalf("order tidak ada: mau 404, dapat %d", w.Code)
	}
	// Catatan: jalur sukses webhook memanggil biner clipkupay eksternal dan
	// tidak diuji di sini — butuh gateway; lihat docs/api-contracts.md.
}

func TestCheckoutPlanRejectsUnknownPlan(t *testing.T) {
	db := openTestDB(t)
	u := makeUser(t, db, "checkout@x.id", "rahasia1")
	h := checkoutPlan(db)
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/billing/checkout", strings.NewReader(`{"plan":"diamond"}`))
	req.Header.Set("Content-Type", "application/json")
	c, _ := gin.CreateTestContext(w)
	c.Request = req
	c.Set("userID", u.ID)
	h(c)
	// Plan tidak ada di planPrices -> 400, tanpa memanggil gateway.
	if w.Code != 400 {
		t.Fatalf("plan tidak dikenal: mau 400, dapat %d (%s)", w.Code, w.Body.String())
	}
	var out struct {
		Message string `json:"message"`
	}
	json.Unmarshal(w.Body.Bytes(), &out)
	if out.Message == "" {
		t.Fatal("respons 400 tanpa pesan")
	}
}

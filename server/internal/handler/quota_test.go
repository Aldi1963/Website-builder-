package handler

import (
	"testing"
	"time"

	"webbuilder/internal/database/models"
)

// planQuota: default per plan tidak boleh berubah diam-diam — ini batas
// penagihan. Bila default berubah sengaja, test ini yang memberi tahu.

func TestPlanQuotaDefaults(t *testing.T) {
	db := openTestDB(t)
	cases := []struct {
		plan        string
		maxProjects int
		maxTokens   int
	}{
		{"free", 3, 100000},
		{"pro", 50, 2000000},
		{"team", 999999, 20000000},
	}
	for _, c := range cases {
		p, tok := planQuota(db, c.plan)
		if p != c.maxProjects || tok != c.maxTokens {
			t.Errorf("plan %s: mau (%d,%d), dapat (%d,%d)", c.plan, c.maxProjects, c.maxTokens, p, tok)
		}
	}
	// Plan tidak dikenal jatuh ke free, bukan ke tanpa batas.
	if p, tok := planQuota(db, "enterprise"); p != 3 || tok != 100000 {
		t.Errorf("plan asing: mau (3,100000), dapat (%d,%d)", p, tok)
	}
	if p, tok := planQuota(db, ""); p != 3 || tok != 100000 {
		t.Errorf("plan kosong: mau (3,100000), dapat (%d,%d)", p, tok)
	}
	// Admin tidak dibatasi.
	if p, tok := planQuota(db, "admin"); p < 1<<30 || tok < 1<<30 {
		t.Errorf("plan admin: mau praktis tanpa batas, dapat (%d,%d)", p, tok)
	}
}

func TestPlanQuotaSettingOverride(t *testing.T) {
	db := openTestDB(t)
	// Override via settings harus menang atas default, dan nilai negatif /
	// bukan angka harus diabaikan (bukan merusak kuota).
	db.Create(&models.PlatformSetting{Key: "quota_projects_free", Value: "10"})
	db.Create(&models.PlatformSetting{Key: "quota_tokens_free", Value: "5000"})
	if p, tok := planQuota(db, "free"); p != 10 || tok != 5000 {
		t.Fatalf("override: mau (10,5000), dapat (%d,%d)", p, tok)
	}
	db.Model(&models.PlatformSetting{}).Where("key = ?", "quota_projects_free").Update("value", "-3")
	db.Model(&models.PlatformSetting{}).Where("key = ?", "quota_tokens_free").Update("value", "bukan-angka")
	if p, tok := planQuota(db, "free"); p != 3 || tok != 100000 {
		t.Fatalf("override tidak valid harus diabaikan: mau (3,100000), dapat (%d,%d)", p, tok)
	}
	// Override 0 sah (artinya: tidak boleh buat proyek).
	db.Model(&models.PlatformSetting{}).Where("key = ?", "quota_projects_free").Update("value", "0")
	if p, _ := planQuota(db, "free"); p != 0 {
		t.Fatalf("override 0: mau 0 proyek, dapat %d", p)
	}
}

func TestUserPlan(t *testing.T) {
	db := openTestDB(t)
	admin := makeUser(t, db, "admin@x.id", "rahasia1")
	db.Model(&admin).Update("is_admin", true)
	if got := userPlan(db, admin.ID); got != "admin" {
		t.Fatalf("user admin: mau plan admin, dapat %q", got)
	}
	u := makeUser(t, db, "biasa@x.id", "rahasia1")
	// Tanpa subscription -> free (getSubscription membuat baris free).
	if got := userPlan(db, u.ID); got != "free" {
		t.Fatalf("user baru: mau free, dapat %q", got)
	}
	// Subscription pro aktif -> pro.
	db.Model(&models.Subscription{}).Where("user_id = ?", u.ID).Updates(map[string]interface{}{
		"plan": "pro", "status": "active", "expires_at": time.Now().Add(30 * 24 * time.Hour),
	})
	if got := userPlan(db, u.ID); got != "pro" {
		t.Fatalf("user pro: mau pro, dapat %q", got)
	}
}

func TestMonthUsageAndRecordAIUsage(t *testing.T) {
	db := openTestDB(t)
	u := makeUser(t, db, "pakai@x.id", "rahasia1")

	if calls, tokens := monthUsage(db, u.ID); calls != 0 || tokens != 0 {
		t.Fatalf("tanpa pemakaian: mau (0,0), dapat (%d,%d)", calls, tokens)
	}
	// Estimasi token = (len(prompt)+len(completion))/4, minimal 1.
	recordAIUsage(db, u.ID, "m", "abcd", "efgh")         // (4+4)/4 = 2
	recordAIUsage(db, u.ID, "m", "a", "")                // (1+0)/4 = 0 -> 1
	recordAIUsage(db, u.ID, "m", "abcdefgh", "ijklmnop") // (8+8)/4 = 4
	calls, tokens := monthUsage(db, u.ID)
	if calls != 3 || tokens != 7 {
		t.Fatalf("mau (3 panggilan, 7 token), dapat (%d,%d)", calls, tokens)
	}
	// Pemakaian user lain tidak ikut terhitung.
	other := makeUser(t, db, "lain@x.id", "rahasia1")
	recordAIUsage(db, other.ID, "m", "abcdefghij", "klmnopqrst") // 5 token
	if calls, tokens := monthUsage(db, u.ID); calls != 3 || tokens != 7 {
		t.Fatalf("pemakaian user lain bocor: mau (3,7), dapat (%d,%d)", calls, tokens)
	}
	// Pemakaian bulan lalu tidak ikut terhitung.
	lastMonth := time.Now().AddDate(0, -1, 0)
	db.Create(&models.AIUsage{UserID: u.ID, Tokens: 999, Model: "m", CreatedAt: lastMonth})
	if calls, tokens := monthUsage(db, u.ID); calls != 3 || tokens != 7 {
		t.Fatalf("pemakaian bulan lalu bocor: mau (3,7), dapat (%d,%d)", calls, tokens)
	}
}

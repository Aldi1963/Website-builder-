package handler

import (
	"crypto/rand"
	"encoding/hex"
	"testing"

	"webbuilder/internal/database/models"

	"golang.org/x/crypto/bcrypt"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

// openTestDB membuka SQLite in-memory khusus satu test (DSN unik per test
// + satu koneksi, supaya tidak ada state yang bocor antar test) dan
// memigrasikan model yang dipakai handler auth/kuota/payment.
func openTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		t.Fatalf("rand: %v", err)
	}
	dsn := "file:test_" + hex.EncodeToString(b) + "?mode=memory&cache=shared"
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatalf("buka sqlite test: %v", err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatalf("db.DB: %v", err)
	}
	sqlDB.SetMaxOpenConns(1)
	t.Cleanup(func() { sqlDB.Close() })
	if err := db.AutoMigrate(
		&models.User{},
		&models.Subscription{},
		&models.Payment{},
		&models.AIUsage{},
		&models.PasswordReset{},
		&models.UserAPIKey{},
		&models.UserTOTP{},
		&models.PlatformSetting{},
		&models.AuditLog{},
		&models.Notification{},
	); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return db
}

// makeUser membuat user dengan password bcrypt di DB test.
func makeUser(t *testing.T, db *gorm.DB, email, password string) models.User {
	t.Helper()
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.MinCost)
	if err != nil {
		t.Fatalf("bcrypt: %v", err)
	}
	u := models.User{Name: "Penguji", Email: email, Password: string(hash), ReferralCode: "WB" + randHex(6)}
	if err := db.Create(&u).Error; err != nil {
		t.Fatalf("create user: %v", err)
	}
	return u
}

// resetLoginAttempts mengosongkan map rate limiter login global antar test.
func resetLoginAttempts() {
	attemptMu.Lock()
	defer attemptMu.Unlock()
	loginAttempts = map[string]*attemptInfo{}
}

package database

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"

	"webbuilder/internal/database/models"
)

func TestOpenDefaultsToSQLite(t *testing.T) {
	dir := t.TempDir()
	db, driver, err := OpenWithDSN("", filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	if driver != DriverSQLite {
		t.Fatalf("driver = %q, want sqlite", driver)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	defer sqlDB.Close()
	if _, err := os.Stat(filepath.Join(dir, "test.db")); err != nil {
		t.Fatalf("file sqlite tidak dibuat: %v", err)
	}
}

func TestOpenRejectsUnknownURL(t *testing.T) {
	if _, _, err := OpenWithDSN("mysql://user:pass@host/db", "x.db"); err == nil {
		t.Fatal("URL mysql harus ditolak")
	}
	// Host yang pasti tidak ada: harus gagal koneksi, bukan jatuh ke SQLite.
	if _, _, err := OpenWithDSN("postgres://invalid.invalid:1/db", "x.db"); err == nil {
		t.Fatal("postgres ke host tak ada harus gagal, bukan lolos")
	}
}

func TestOpenSQLiteURL(t *testing.T) {
	dir := t.TempDir()
	db, driver, err := OpenWithDSN("sqlite://"+filepath.Join(dir, "u.db"), "")
	if err != nil {
		t.Fatal(err)
	}
	if driver != DriverSQLite {
		t.Fatalf("driver = %q, want sqlite", driver)
	}
	sqlDB, _ := db.DB()
	sqlDB.Close()
}

func TestModelsHasNoDuplicates(t *testing.T) {
	seen := map[string]bool{}
	for _, m := range Models() {
		name := reflect.TypeOf(m).Elem().Name()
		if seen[name] {
			t.Fatalf("model %s terdaftar dua kali", name)
		}
		seen[name] = true
	}
	if len(Models()) != 33 {
		t.Fatalf("jumlah model = %d, want 33 (tambah model baru = tambah ke Models + migrasi)", len(Models()))
	}
}

func TestAutoMigrateSQLiteCreatesAllTables(t *testing.T) {
	dir := t.TempDir()
	db, _, err := OpenWithDSN("", filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	defer sqlDB.Close()
	if err := AutoMigrate(db); err != nil {
		t.Fatal(err)
	}
	var tables []string
	if err := db.Raw("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").Scan(&tables).Error; err != nil {
		t.Fatal(err)
	}
	want := []string{
		"agent_contexts", "agent_runs", "agent_tool_calls", "ai_configs",
		"ai_proposals", "ai_usages", "app_cron_jobs", "app_files", "audit_logs",
		"blocked_words", "chat_messages", "chat_sessions", "deployments",
		"domains", "file_comments", "form_submissions", "git_hub_configs",
		"notifications", "password_resets", "payments", "platform_settings",
		"project_envs", "project_members", "project_migrations",
		"project_versions", "project_webhooks", "projects", "subscriptions",
		"templates", "user_api_keys", "user_totps", "users", "visit_stats",
	}
	sort.Strings(want)
	if fmt.Sprint(tables) != fmt.Sprint(want) {
		t.Fatalf("tabel = %v\nwant %v", tables, want)
	}
}

// TestMigrateUpPostgres menguji migrasi goose terhadap Postgres sungguhan.
// Dijalankan hanya bila WB_TEST_POSTGRES_URL diset (URL postgres:// lengkap), mis.:
// WB_TEST_POSTGRES_URL="postgres://postgres@127.0.0.1:55433/wbtest_mig?sslmode=disable" go test ./internal/database/ -run TestMigrateUpPostgres -v
// Di CI tanpa Postgres, test ini di-skip (bukan gagal).
func TestMigrateUpPostgres(t *testing.T) {
	dsn := os.Getenv("WB_TEST_POSTGRES_URL")
	if dsn == "" {
		t.Skip("WB_TEST_POSTGRES_URL tidak diset — lewati uji Postgres-live")
	}
	db, driver, err := OpenWithDSN(dsn, "")
	if err != nil {
		t.Fatal(err)
	}
	if driver != DriverPostgres {
		t.Fatalf("driver = %q, want postgres", driver)
	}
	sqlDB, _ := db.DB()
	defer sqlDB.Close()
	// Bersihkan skema agar uji berulang dari nol.
	if _, err := sqlDB.Exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public;"); err != nil {
		t.Fatal(err)
	}
	if err := MigrateUp(t.Context(), db); err != nil {
		t.Fatalf("MigrateUp: %v", err)
	}
	v, err := MigrationVersion(t.Context(), db)
	if err != nil {
		t.Fatal(err)
	}
	if v != 3 {
		t.Fatalf("versi migrasi = %d, want 3", v)
	}
	var tables []string
	if err := db.Raw("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT LIKE 'goose_%' ORDER BY tablename").Scan(&tables).Error; err != nil {
		t.Fatal(err)
	}
	want := []string{
		"agent_contexts", "agent_runs", "agent_tool_calls", "ai_configs",
		"ai_proposals", "ai_usages", "app_cron_jobs", "app_files", "audit_logs",
		"blocked_words", "chat_messages", "chat_sessions", "deployments",
		"domains", "file_comments", "form_submissions", "git_hub_configs",
		"notifications", "password_resets", "payments", "platform_settings",
		"project_envs", "project_members", "project_migrations",
		"project_versions", "project_webhooks", "projects", "queue_jobs",
		"subscriptions", "templates", "user_api_keys", "user_totps", "users",
		"visit_stats",
	}
	sort.Strings(want)
	if fmt.Sprint(tables) != fmt.Sprint(want) {
		t.Fatalf("tabel = %v\nwant %v", tables, want)
	}
	// GORM tetap bisa baca/tulis di atas skema hasil migrasi (cek kolom aneh
	// seoog_image / s_eofavicon ikut terbaca).
	if err := db.Exec("INSERT INTO users (name, email, created_at) VALUES ('Uji', 'uji@example.com', NOW())").Error; err != nil {
		t.Fatalf("insert user: %v", err)
	}
	if err := db.Exec("INSERT INTO projects (user_id, name, slug, seoog_image, s_eofavicon, created_at, updated_at) VALUES (1, 'P', 'p', 'og.png', 'fav.ico', NOW(), NOW())").Error; err != nil {
		t.Fatalf("insert project (kolom GORM): %v", err)
	}
	// Kolom verification (migrasi 00003) ada dan bisa dibaca/tulis GORM
	// dengan isi JSON yang sama seperti event SSE `result`.
	if err := db.Exec("INSERT INTO chat_sessions (project_id, title, created_at) VALUES (1, 'S', NOW())").Error; err != nil {
		t.Fatalf("insert chat_session: %v", err)
	}
	wantVer := `{"attempted":true,"passed":true,"rounds":1,"consoleErrors":[],"failedRequests":[],"screenshotPath":"runtime/project-1/run-1/screenshot-1.png","screenshotUrl":"/api/projects/1/runtime/screenshots/verification/1/screenshot-1.png"}`
	msg := models.ChatMessage{SessionID: 1, Role: "assistant", Content: "selesai", Verification: wantVer}
	if err := db.Create(&msg).Error; err != nil {
		t.Fatalf("insert chat_message (kolom verification): %v", err)
	}
	var back models.ChatMessage
	if err := db.First(&back, msg.ID).Error; err != nil {
		t.Fatalf("baca chat_message: %v", err)
	}
	if back.Verification != wantVer {
		t.Fatalf("verification = %q, want %q", back.Verification, wantVer)
	}
	// Baris lama tanpa verifikasi: kolom terbaca sebagai string kosong.
	if err := db.Exec("INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (1, 'user', 'halo', NOW())").Error; err != nil {
		t.Fatalf("insert chat_message lama: %v", err)
	}
	var legacy models.ChatMessage
	if err := db.Where("role = ?", "user").First(&legacy).Error; err != nil {
		t.Fatalf("baca chat_message lama: %v", err)
	}
	if legacy.Verification != "" {
		t.Fatalf("verification pesan lama = %q, want kosong", legacy.Verification)
	}
}

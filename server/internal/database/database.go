// Package database memilih dan menyiapkan penyimpanan WebBuilder.
//
// Perilaku default TIDAK berubah: tanpa DATABASE_URL, dipakai SQLite di
// ../data/webbuilder.db dengan GORM AutoMigrate seperti sebelumnya.
// Bila DATABASE_URL berisi URL postgres:// (atau postgresql://), dipakai
// Postgres via pgx/GORM dan skema dibuat oleh migrasi berversi goose
// (server/migrations), bukan AutoMigrate — supaya perubahan skema Postgres
// bisa dilacak, di-review, dan di-rollback.
package database

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"strings"

	"webbuilder/internal/database/models"
	"webbuilder/migrations"

	"github.com/pressly/goose/v3"
	"gorm.io/driver/postgres"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

// DefaultSQLitePath adalah lokasi file SQLite bila DATABASE_URL kosong.
// Sama seperti yang dipakai main.go sebelum trek ini.
const DefaultSQLitePath = "../data/webbuilder.db"

// Driver adalah backend penyimpanan yang dipilih dari environment.
type Driver string

const (
	DriverSQLite   Driver = "sqlite"
	DriverPostgres Driver = "postgres"
)

// Open membuka database sesuai DATABASE_URL di environment.
// Mengembalikan juga driver yang terpilih supaya pemanggil bisa memilih
// cara menyiapkan skema (lihat Migrate).
func Open() (*gorm.DB, Driver, error) {
	return OpenWithDSN(os.Getenv("DATABASE_URL"), DefaultSQLitePath)
}

// OpenWithDSN adalah Open dengan DSN eksplisit (dipakai test).
// Aturan: "" -> SQLite default; postgres://... -> Postgres;
// sqlite://<path> atau file:<path> -> SQLite di path itu.
// Nilai lain ditolak dengan error, bukan ditebak.
func OpenWithDSN(databaseURL, sqlitePath string) (*gorm.DB, Driver, error) {
	u := strings.TrimSpace(databaseURL)
	if u == "" {
		return openSQLite(sqlitePath)
	}
	if strings.HasPrefix(u, "postgres://") || strings.HasPrefix(u, "postgresql://") {
		db, err := gorm.Open(postgres.Open(u), &gorm.Config{})
		if err != nil {
			return nil, "", fmt.Errorf("open postgres: %w", err)
		}
		return db, DriverPostgres, nil
	}
	if rest, ok := strings.CutPrefix(u, "sqlite://"); ok {
		return openSQLite(rest)
	}
	if strings.HasPrefix(u, "file:") {
		return openSQLite(u)
	}
	return nil, "", fmt.Errorf("DATABASE_URL tidak dikenali (harapkan postgres://, sqlite://, atau kosong untuk SQLite default)")
}

func openSQLite(path string) (*gorm.DB, Driver, error) {
	if strings.TrimSpace(path) == "" {
		path = DefaultSQLitePath
	}
	db, err := gorm.Open(sqlite.Open(path), &gorm.Config{})
	if err != nil {
		return nil, "", fmt.Errorf("open sqlite %s: %w", path, err)
	}
	return db, DriverSQLite, nil
}

// Models mengembalikan seluruh model GORM, masing-masing tepat satu kali.
// (main.go lama mendaftarkan AgentRun dan AgentToolCall dua kali di AutoMigrate;
// duplikasi itu dihapus di sini — GORM mengabaikannya, tapi daftar ini adalah
// satu-satunya sumber kebenaran untuk AutoMigrate.)
func Models() []any {
	return []any{
		&models.User{}, &models.Project{}, &models.ChatSession{},
		&models.ChatMessage{}, &models.ProjectVersion{}, &models.ProjectMigration{},
		&models.ProjectEnv{}, &models.AIUsage{}, &models.AgentRun{}, &models.AgentToolCall{},
		&models.AgentContext{},
		&models.Template{}, &models.Deployment{}, &models.Domain{}, &models.AIConfig{},
		&models.AIProviderConfig{},
		&models.PasswordReset{}, &models.GitHubConfig{}, &models.AuditLog{},
		&models.PlatformSetting{}, &models.Notification{}, &models.ProjectMember{},
		&models.UserAPIKey{}, &models.ProjectWebhook{}, &models.VisitStat{},
		&models.BlockedWord{}, &models.UserTOTP{}, &models.AIProposal{},
		&models.FileComment{}, &models.Subscription{}, &models.Payment{},
		&models.FormSubmission{}, &models.AppFile{}, &models.AppCronJob{},
	}
}

// AutoMigrate menjalankan GORM AutoMigrate atas seluruh model.
// Dipakai untuk jalur SQLite (default/live). Jalur Postgres memakai migrasi
// berversi (MigrateUp) agar skema bisa di-rollback dan dilacak versinya.
func AutoMigrate(db *gorm.DB) error {
	return db.AutoMigrate(Models()...)
}

// Migrate menyiapkan skema sesuai driver:
//   - postgres: goose Up atas migrasi yang di-embed (server/migrations).
//     Gagal -> error; server tidak boleh start dengan skema setengah jalan.
//   - sqlite: AutoMigrate seperti sebelumnya.
func Migrate(ctx context.Context, db *gorm.DB, driver Driver) error {
	switch driver {
	case DriverPostgres:
		return MigrateUp(ctx, db)
	case DriverSQLite:
		return AutoMigrate(db)
	default:
		return fmt.Errorf("driver tidak dikenal: %q", driver)
	}
}

func sqlDB(db *gorm.DB) (*sql.DB, error) {
	s, err := db.DB()
	if err != nil {
		return nil, fmt.Errorf("ambil *sql.DB: %w", err)
	}
	return s, nil
}

// MigrateUp menerapkan semua migrasi goose yang belum diterapkan (Postgres saja).
// Migrasi di-embed dari server/migrations; tabel pelacak goose adalah goose_db_version.
func MigrateUp(ctx context.Context, db *gorm.DB) error {
	s, err := sqlDB(db)
	if err != nil {
		return err
	}
	goose.SetDialect("postgres")
	goose.SetBaseFS(migrations.FS)
	if err := goose.UpContext(ctx, s, "."); err != nil {
		return fmt.Errorf("goose up: %w", err)
	}
	return nil
}

// MigrateDownTo memundurkan migrasi goose sampai ke versi target (Postgres saja).
// version 0 berarti memundurkan semuanya. HANYA untuk pemulihan/rollback
// yang direncanakan (lihat docs/database.md); jangan dipakai di server.
func MigrateDownTo(ctx context.Context, db *gorm.DB, version int64) error {
	s, err := sqlDB(db)
	if err != nil {
		return err
	}
	goose.SetDialect("postgres")
	goose.SetBaseFS(migrations.FS)
	if err := goose.DownToContext(ctx, s, ".", version); err != nil {
		return fmt.Errorf("goose down-to %d: %w", version, err)
	}
	return nil
}

// MigrationVersion mengembalikan versi migrasi goose terakhir yang diterapkan.
// Mengembalikan 0 bila belum ada migrasi yang diterapkan.
func MigrationVersion(ctx context.Context, db *gorm.DB) (int64, error) {
	s, err := sqlDB(db)
	if err != nil {
		return 0, err
	}
	goose.SetDialect("postgres")
	goose.SetBaseFS(migrations.FS)
	v, err := goose.GetDBVersionContext(ctx, s)
	if err != nil {
		if errors.Is(err, goose.ErrNoCurrentVersion) {
			return 0, nil
		}
		return 0, fmt.Errorf("goose version: %w", err)
	}
	return v, nil
}

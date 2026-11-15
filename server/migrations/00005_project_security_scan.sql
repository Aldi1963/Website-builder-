-- +goose Up
-- Laporan pemindaian keamanan terakhir per proyek (JSON mentah dari paket
-- securityscan), supaya hasil scan bertahan di riwayat proyek dan bisa
-- dibaca ulang tanpa memindai ulang. SQLite memakai AutoMigrate (kolom
-- ditambahkan otomatis dari model); migrasi ini hanya untuk Postgres.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS security_scan text DEFAULT '';

-- +goose Down
ALTER TABLE projects DROP COLUMN IF EXISTS security_scan;

# Database WebBuilder — SQLite (default) & Postgres (opt-in)

## Ringkasan

| | SQLite (default/live) | Postgres (opt-in) |
|---|---|---|
| Aktif bila | `DATABASE_URL` kosong | `DATABASE_URL=postgres://...` |
| Driver | `gorm.io/driver/sqlite` | `gorm.io/driver/postgres` (pgx) |
| Skema | GORM `AutoMigrate` saat start | Migrasi berversi **goose** (`server/migrations/`) saat start |
| File | `../data/webbuilder.db` | database di URL |

**Perilaku default tidak berubah.** Tanpa `DATABASE_URL`, server berjalan persis
seperti sebelumnya: SQLite + AutoMigrate. Postgres hanya aktif bila operator
secara eksplisit menyetel URL-nya.

## Kenapa goose (bukan golang-migrate)

Satu pilihan saja: **goose v3** (`github.com/pressly/goose/v3`).

- Migrasi berupa file SQL polos (`-- +goose Up` / `-- +goose Down`) yang bisa
  dibaca dan di-review tanpa tool tambahan — cocok untuk skema yang dibangkitkan
  dari AutoMigrate.
- Bisa di-embed ke binary (`embed.FS`) sehingga server dan `cmd/migrate`
  menjalankan migrasi yang sama tanpa bergantung pada file di disk saat deploy.
- API Go-nya kecil (`UpContext`, `DownToContext`, `GetDBVersionContext`) dan
  tidak butuh file CLI terpisah; golang-migrate unggul untuk banyak sumber
  migrasi (HTTP/S3/GitHub) yang tidak dibutuhkan di sini, dan memaksa pola
  `file://` + driver terpisah yang lebih berisiko salah pasang.
- Versi yang dipakai: goose v3.30.1 (ditarik `go get`, tercatat di
  `server/go.mod` / `server/go.sum`).

## File yang terlibat

- `server/internal/database/database.go` — `Open()` (pilih driver dari
  `DATABASE_URL`), `Models()` (daftar model, masing-masing tepat sekali —
  duplikasi `AgentRun`/`AgentToolCall` di `main.go` lama sudah dihapus),
  `AutoMigrate()`, `Migrate()` (SQLite → AutoMigrate, Postgres → goose Up),
  `MigrateUp` / `MigrateDownTo` / `MigrationVersion`.
- `server/migrations/00001_initial_schema.sql` — replika persis hasil GORM
  AutoMigrate atas `server/internal/database/models/models.go` (33 tabel).
  Dibangkitkan dari `pg_dump` skema referensi AutoMigrate, lalu diverifikasi
  dengan diff `pg_dump` (lihat "Verifikasi" di bawah). Sengaja **tanpa
  foreign key**, mengikuti AutoMigrate: model tidak mendeklarasikan FK.
  Nama kolom hasil penamaan GORM dipertahankan apa adanya, termasuk yang aneh:
  `projects.seoog_image` (dari `SEOOGImage`), `projects.s_eofavicon` (dari
  `SEOFavicon`), tabel `git_hub_configs` (dari `GitHubConfig`).
- `server/migrations/00002_queue_jobs.sql` — tabel `queue_jobs` untuk adapter
  queue berbasis DB (lihat `docs/queue.md`).
- `server/migrations/migrations.go` — embed `*.sql` ke binary.
- `server/cmd/migrate/main.go` — runner manual: `up`, `status`, `down-to N`.
- `server/main.go` — hanya blok buka DB + AutoMigrate yang diubah:
  `database.Open()` lalu `database.Migrate(ctx, db, driver)`.

## Menjalankan migrasi

### Otomatis (server)

Dengan `DATABASE_URL` postgres, server menjalankan `goose Up` saat start
sebelum menerima request. Bila migrasi gagal, server menolak start
(fail-closed) — jangan bypass dengan AutoMigrate, karena tabel akan ada tanpa
catatan versi dan goose berikutnya akan gagal.

### Manual (runner)

```bash
cd server
export DATABASE_URL="postgres://webbuilder:PASSWORD@127.0.0.1:5434/webbuilder?sslmode=disable"

go run ./cmd/migrate status   # versi migrasi sekarang
go run ./cmd/migrate up       # terapkan semua migrasi yang belum jalan
go run ./cmd/migrate down-to 1  # mundur ke versi 1 (lihat "Rollback")
```

Tanpa `DATABASE_URL` postgres, runner menolak berjalan (`migrate hanya untuk
Postgres`). Jalur SQLite tidak memakai tool ini.

### Menambah migrasi baru

1. Buat `server/migrations/00003_<nama>.sql` dengan blok `-- +goose Up` dan
   `-- +goose Down`. Nomor harus naik dan unik.
2. **Jangan pernah mengedit file migrasi yang sudah diterapkan di mana pun**
   (live/staging/dev orang lain) — buat file baru.
3. Uji terhadap Postgres kosong: `go run ./cmd/migrate up`, lalu
   `go run ./cmd/migrate down-to <versi-sebelumnya>` dan `up` lagi.
4. Bila migrasi mengubah model GORM, ubah juga `models.go` dan daftar
   `Models()` agar AutoMigrate (SQLite) dan migrasi (Postgres) tetap selaras.

## Migrasi data SQLite → Postgres (langkah-demi-langkah)

Asumsi: server **berhenti** dulu (jangan migrasi sambil server menulis),
Postgres target sudah dibuat beserta user-nya (lihat `server/cmd/pgsetup`),
dan `pg_dump`/`sqlite3` tersedia. Semua perintah di bawah memakai database
kosong di sisi Postgres — migrasi goose harus jalan di skema kosong.

```bash
# 0. Hentikan server WebBuilder (jangan ada tulisan baru selama migrasi).
#    Backup dulu kedua sisi:
cp ../data/webbuilder.db /tmp/webbuilder.db.bak
pg_dump "postgres://webbuilder:PASSWORD@HOST:5434/webbuilder?sslmode=disable" \
  --schema-only > /tmp/pg-sebelum.sql   # cadangan skema (opsional, bila DB tidak kosong)

# 1. Terapkan skema goose ke Postgres kosong.
cd server
export DATABASE_URL="postgres://webbuilder:PASSWORD@HOST:5434/webbuilder?sslmode=disable"
go run ./cmd/migrate up        # harus berakhir di versi 2
go run ./cmd/migrate status

# 2. Ekspor data dari SQLite ke SQL INSERT (tanpa DDL).
sqlite3 ../data/webbuilder.db .dump > /tmp/sqlite-dump.sql
#    Buang baris DDL dari dump (PRAGMA, BEGIN/CREATE TABLE/CREATE INDEX/COMMIT
#    untuk tabel sqlite_sequence), sisakan INSERT. Contoh penyaringan:
grep '^INSERT INTO' /tmp/sqlite-dump.sql > /tmp/sqlite-data.sql

# 3. Periksa hal-hal yang tidak kompatibel sebelum import:
#    - Boolean SQLite disimpan 0/1 -> Postgres menerima 0/1 untuk boolean. OK.
#    - Waktu disimpan sebagai string 'YYYY-MM-DD HH:MM:SS+00:00' -> Postgres
#      menerimanya sebagai timestamptz. OK.
#    - String berisi byte NUL atau escape SQLite ('') -> periksa baris yang gagal.
#    - Tabel platform_settings memakai PK text (key) — INSERT biasa. OK.
#    - Kolom id: INSERT menyertakan id eksplisit; sequence harus dimajukan
#      setelah import (langkah 5), kalau tidak insert berikutnya bentrok.

# 4. Import (dalam satu transaksi; bila satu baris gagal, semuanya batal).
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f /tmp/sqlite-data.sql

# 5. Majukan semua sequence ke MAX(id) agar insert berikutnya tidak bentrok PK.
psql "$DATABASE_URL" <<'SQL'
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables
           WHERE schemaname='public' AND tablename NOT LIKE 'goose_%'
  LOOP
    EXECUTE format(
      'SELECT setval(pg_get_serial_sequence(%L, %L), COALESCE(MAX(%I), 1)) FROM %I',
      r.tablename, 'id', 'id', r.tablename);
  END LOOP;
END $$;
SQL
#    Catatan: user_totps memakai PK user_id (bukan id) — majukan manual bila perlu:
#    SELECT setval('user_totps_user_id_seq', COALESCE(MAX(user_id),1)) FROM user_totps;

# 6. Verifikasi jumlah baris per tabel di kedua sisi, contoh:
sqlite3 ../data/webbuilder.db "SELECT 'users', COUNT(*) FROM users UNION ALL SELECT 'projects', COUNT(*) FROM projects;"
psql "$DATABASE_URL" -c "SELECT 'users', COUNT(*) FROM users UNION ALL SELECT 'projects', COUNT(*) FROM projects;"
#    Ulangi untuk semua tabel (33 + queue_jobs yang kosong). Selisih apa pun =
#    JANGAN lanjut.

# 7. Start server dengan DATABASE_URL yang sama, lalu uji login + buka satu
#    project + kirim satu chat. Simpan backup SQLite sampai masa observasi
#    selesai (minimal 1x24 jam); rollback = kembalikan DATABASE_URL kosong
#    dan start ulang (lihat "Rollback" — data yang masuk ke Postgres selama
#    masa observasi TIDAK ikut kembali ke SQLite).
```

## Rollback

Ada dua level rollback, jangan tertukar:

### A. Rollback skema (goose down)

Hanya memundurkan DDL, **data di tabel yang di-drop hilang**. Pakai hanya bila
migrasi yang baru diterapkan terbukti rusak dan datanya bisa dibuat ulang /
sudah di-backup.

```bash
export DATABASE_URL="postgres://..."
go run ./cmd/migrate down-to 1   # mundur dari versi 2 ke versi 1 (queue_jobs hilang)
go run ./cmd/migrate status
```

`down-to 0` memundurkan semuanya (semua 33 tabel hilang). Jangan jalankan
tanpa backup `pg_dump` penuh.

### B. Rollback deployment (kembali ke SQLite)

Ini rollback yang normal bila Postgres bermasalah di produksi:

1. Hentikan server.
2. Hapus / kosongkan `DATABASE_URL`, start ulang — server kembali ke
   `../data/webbuilder.db` + AutoMigrate.
3. Data yang sempat masuk ke Postgres **tidak** otomatis kembali ke SQLite.
   Bila masa Postgres singkat dan datanya penting, ulangi prosedur migrasi
   data di atas dengan arah terbalik (ekspor Postgres → import SQLite) atau
   pulihkan dari backup SQLite terakhir dan terima kehilangan data sejak
   migrasi.

## Verifikasi (yang sudah dilakukan trek ini)

- `go test ./internal/database/` — SQLite: open default, tolak URL tak
  dikenal, 33 model tanpa duplikat, AutoMigrate membuat ke-33 tabel.
- Postgres-live (instance scratch port 55433, database `wbtest_mig`,
  dihapus setelah uji): `TestMigrateUpPostgres` — goose Up ke versi 2,
  34 tabel (33 + `queue_jobs`), lalu insert GORM ke `users`/`projects`
  (termasuk kolom `seoog_image`/`s_eofavicon`) berhasil.
- Kesetaraan skema: `pg_dump --schema-only` dari database hasil AutoMigrate
  vs database hasil goose — **identik untuk ke-33 tabel** (tabel, sequence,
  default, PK, index). Satu-satunya selisih adalah tabel `queue_jobs`
  tambahan dari migrasi 00002, sesuai rencana.
- `go run ./cmd/migrate` end-to-end pada database scratch `wbtest_cli`:
  `status` → 0, `up` → 2, `down-to 1` → 1, `up` → 2, tanpa `DATABASE_URL`
  → menolak (exit 1).

## Batasan yang diketahui

- Migrasi berversi hanya untuk Postgres. SQLite tetap AutoMigrate (tanpa
  riwayat versi) — disengaja, demi perilaku default yang tidak berubah.
- Tidak ada foreign key (paritas dengan AutoMigrate). Bila suatu saat FK
  ditambahkan ke model, migrasi dan AutoMigrate harus diubah bersamaan.
- `MigrateDownTo` tidak dipanggil server — hanya runner manual.

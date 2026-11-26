#!/usr/bin/env bash
# TREK A item 11 — backup database WebBuilder.
#
# Isi backup: database saja (SQLite default ../data/webbuilder.db, atau
# Postgres bila DATABASE_URL postgres). Secret (.env, .jwt-secret, kunci)
# SENGAJA tidak ikut di-backup — jangan pernah memasukkan secret ke arsip.
#
# Pemakaian:
#   scripts/backup.sh [--out-dir DIR] [--db-path PATH] [--keep-days N]
#   DATABASE_URL=postgres://... scripts/backup.sh   # bila sudah Postgres
#
# Env yang dihormati:
#   BACKUP_DIR  (default: <repo>/backups)   DB_PATH (default: <repo>/data/webbuilder.db)
#   DATABASE_URL (bila diawali postgres:// atau postgresql:// -> pg_dump)
#   BACKUP_KEEP_DAYS (default 7; 0 = jangan hapus backup lama)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${BACKUP_DIR:-$REPO_ROOT/backups}"
DB_PATH="${DB_PATH:-$REPO_ROOT/data/webbuilder.db}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-7}"
STAMP="$(date +%Y%m%d-%H%M%S)"

while [ $# -gt 0 ]; do
  case "$1" in
    --out-dir)   OUT_DIR="$2"; shift 2 ;;
    --db-path)   DB_PATH="$2"; shift 2 ;;
    --keep-days) KEEP_DAYS="$2"; shift 2 ;;
    -h|--help)   sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "Argumen tidak dikenal: $1 (lihat --help)" >&2; exit 2 ;;
  esac
done

mkdir -p "$OUT_DIR"

is_postgres_url() {
  case "${DATABASE_URL:-}" in
    postgres://*|postgresql://*) return 0 ;;
    *) return 1 ;;
  esac
}

if is_postgres_url; then
  # --- Postgres (opt-in masa depan; server saat ini default SQLite) ---
  command -v pg_dump >/dev/null || { echo "pg_dump tidak ditemukan; install postgresql-client dulu." >&2; exit 1; }
  OUT="$OUT_DIR/webbuilder-pg-$STAMP.sql"
  echo "Backup Postgres -> $OUT"
  pg_dump "$DATABASE_URL" > "$OUT"
  echo "OK: $OUT ($(du -h "$OUT" | cut -f1))"
else
  # --- SQLite (default live: server/main.go memakai ../data/webbuilder.db) ---
  [ -f "$DB_PATH" ] || { echo "Database tidak ditemukan: $DB_PATH" >&2; exit 1; }
  OUT="$OUT_DIR/webbuilder-sqlite-$STAMP.db"
  echo "Backup SQLite ($DB_PATH) -> $OUT"
  if command -v sqlite3 >/dev/null; then
    # .backup = salinan konsisten walau server sedang berjalan.
    sqlite3 "$DB_PATH" ".backup '$OUT'"
  else
    echo "PERINGATAN: sqlite3 tidak ditemukan — fallback salin file mentah." >&2
    echo "Salinan mentah saat server sedang menulis BISA tidak konsisten; pasang sqlite3 bila memungkinkan." >&2
    cp -- "$DB_PATH" "$OUT"
  fi
  # Verifikasi hasil backup bisa dibuka dan konsisten.
  if command -v sqlite3 >/dev/null; then
    CHECK="$(sqlite3 "$OUT" "PRAGMA integrity_check;" 2>&1)"
    [ "$CHECK" = "ok" ] || { echo "integrity_check backup GAGAL: $CHECK" >&2; exit 1; }
  fi
  echo "OK: $OUT ($(du -h "$OUT" | cut -f1))"
fi

# Retensi: hapus backup lebih tua dari KEEP_DAYS hari (0 = matikan).
if [ "${KEEP_DAYS:-7}" -gt 0 ] 2>/dev/null; then
  find "$OUT_DIR" -maxdepth 1 \( -name 'webbuilder-*.db' -o -name 'webbuilder-*.sql' \) \
    -mtime +"$KEEP_DAYS" -print -delete
fi

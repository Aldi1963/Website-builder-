#!/usr/bin/env bash
# TREK A item 11 — restore database WebBuilder (pasangan scripts/backup.sh).
#
# ATURAN KEAMANAN — baca sebelum menjalankan:
#   1. Restore MENIMPA database aktif. Data yang masuk sesudah backup dibuat
#      akan HILANG. Restore hanya bila yakin (mis. rollback deploy / DB rusak).
#   2. HENTIKAN dulu server WebBuilder sebelum restore SQLite. Bila server
#      masih jalan, skrip ini menolak kecuali diberi --force — dan itu pun
#      tetap berisiko (server bisa menimpa hasil restore).
#   3. Skrip ini selalu membuat salinan pengaman database lama
#      (<db>.pre-restore-<stamp>) sebelum menimpa, supaya salah restore
#      masih bisa dibatalkan.
#
# Pemakaian:
#   scripts/restore.sh <file-backup> [--db-path PATH] [--force]
#   DATABASE_URL=postgres://... scripts/restore.sh <file-backup.sql>
#
# Deteksi jenis backup dari isi file, bukan dari nama:
#   - header "SQLite format 3" -> restore SQLite (ganti file db)
#   - teks dump Postgres (berisi "PostgreSQL database dump") -> psql
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_PATH="${DB_PATH:-$REPO_ROOT/data/webbuilder.db}"
FORCE=0
BACKUP_FILE="${1:-}"

usage() { sed -n '2,24p' "${BASH_SOURCE[0]}"; exit "${1:-2}"; }
[ -n "$BACKUP_FILE" ] || { echo "File backup wajib diisi." >&2; usage 2; }
shift || true
while [ $# -gt 0 ]; do
  case "$1" in
    --db-path) DB_PATH="$2"; shift 2 ;;
    --force)   FORCE=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "Argumen tidak dikenal: $1 (lihat --help)" >&2; exit 2 ;;
  esac
done

[ -f "$BACKUP_FILE" ] || { echo "File backup tidak ditemukan: $BACKUP_FILE" >&2; exit 1; }

# Tolak bila server masih jalan, kecuali --force (tetap berisiko).
# Deteksi sengaja SEMPIT: nama proses persis `webbuilder` (binary server)
# atau port 18082 sedang listen. JANGAN pakai `pgrep -f webbuilder` —
# pola itu juga cocok dengan proses `go build`/`go test`/compiler yang
# cmdline-nya menyebut path modul `webbuilder/...` (terbukti false positive
# saat verifikasi 15 Nov 2026).
SERVER_RUNNING=0
if command -v pgrep >/dev/null && pgrep -x webbuilder >/dev/null 2>&1; then
  SERVER_RUNNING=1
elif command -v ss >/dev/null && ss -ltn 2>/dev/null | grep -q ':18082\b'; then
  SERVER_RUNNING=1
fi
if [ "$SERVER_RUNNING" -eq 1 ]; then
  if [ "$FORCE" -eq 0 ]; then
    echo "Server WebBuilder tampaknya masih berjalan (proses webbuilder / port 18082)." >&2
    echo "Hentikan server dulu, lalu jalankan lagi — atau pakai --force bila sadar risikonya." >&2
    exit 1
  fi
  echo "PERINGATAN: server masih berjalan dan --force dipakai; hasil restore bisa tertimpa server." >&2
fi

is_postgres_url() {
  case "${DATABASE_URL:-}" in
    postgres://*|postgresql://*) return 0 ;;
    *) return 1 ;;
  esac
}

if head -c 16 "$BACKUP_FILE" | grep -q "SQLite format 3"; then
  # --- Restore SQLite ---
  command -v sqlite3 >/dev/null || { echo "sqlite3 tidak ditemukan; install dulu." >&2; exit 1; }
  echo "Verifikasi backup: integrity_check..."
  CHECK="$(sqlite3 "$BACKUP_FILE" "PRAGMA integrity_check;" 2>&1)"
  [ "$CHECK" = "ok" ] || { echo "Backup RUSAK / bukan SQLite valid: $CHECK" >&2; exit 1; }
  if [ -f "$DB_PATH" ]; then
    SAFETY="$DB_PATH.pre-restore-$(date +%Y%m%d-%H%M%S)"
    echo "Salinan pengaman DB lama -> $SAFETY"
    cp -- "$DB_PATH" "$SAFETY"
  fi
  mkdir -p "$(dirname "$DB_PATH")"
  echo "Restore SQLite: $BACKUP_FILE -> $DB_PATH"
  cp -- "$BACKUP_FILE" "$DB_PATH"
  CHECK2="$(sqlite3 "$DB_PATH" "PRAGMA integrity_check;" 2>&1)"
  [ "$CHECK2" = "ok" ] || { echo "integrity_check sesudah restore GAGAL: $CHECK2" >&2; exit 1; }
  echo "OK: database ter-restore dan lolos integrity_check. Jalankan ulang server."
elif grep -q "PostgreSQL database dump" "$BACKUP_FILE" 2>/dev/null; then
  # --- Restore Postgres (opt-in masa depan; server saat ini default SQLite) ---
  is_postgres_url || { echo "Backup ini dump Postgres, tapi DATABASE_URL postgres tidak diset." >&2; exit 1; }
  command -v psql >/dev/null || { echo "psql tidak ditemukan; install postgresql-client dulu." >&2; exit 1; }
  echo "PERINGATAN: restore Postgres menimpa isi database di DATABASE_URL." >&2
  if [ "$FORCE" -eq 0 ]; then
    read -r -p "Lanjut? ketik YA untuk konfirmasi: " ANS
    [ "$ANS" = "YA" ] || { echo "Dibatalkan."; exit 1; }
  fi
  echo "Restore Postgres: $BACKUP_FILE -> DATABASE_URL"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$BACKUP_FILE"
  echo "OK: restore Postgres selesai."
else
  echo "Jenis backup tidak dikenali (bukan SQLite, bukan dump Postgres): $BACKUP_FILE" >&2
  echo "Pakai file hasil scripts/backup.sh." >&2
  exit 1
fi

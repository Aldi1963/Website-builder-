# Backup & Restore

## Yang di-backup

Hanya **database**: SQLite default `data/webbuilder.db`, atau Postgres bila
`DATABASE_URL` postgres sudah dipakai (opt-in masa depan). Secret (`.env`,
`.jwt-secret`, kunci) **sengaja tidak ikut** di-backup — jangan pernah
memasukkan secret ke arsip backup.

File hasil backup disimpan di `backups/` (sudah di-`.gitignore`, jangan
di-commit) dengan nama:

- SQLite: `webbuilder-sqlite-YYYYMMDD-HHMMSS.db`
- Postgres: `webbuilder-pg-YYYYMMDD-HHMMSS.sql`

## Backup

```bash
scripts/backup.sh
scripts/backup.sh --out-dir /mnt/backup-external --keep-days 30
DATABASE_URL=postgres://... scripts/backup.sh   # bila sudah Postgres
```

Cara kerja SQLite: memakai `sqlite3 .backup` — salinan **konsisten** walau
server sedang berjalan. Bila `sqlite3` tidak terpasang, skrip fallback ke
salin file mentah dengan **peringatan** (salinan mentah saat server menulis
bisa tidak konsisten — pasang `sqlite3` bila memungkinkan). Setiap hasil
backup SQLite diverifikasi dengan `PRAGMA integrity_check` sebelum skrip
mengaku sukses. Retensi default: backup lebih tua dari **7 hari** dihapus
(`--keep-days 0` mematikan penghapusan).

## Restore

```bash
scripts/restore.sh backups/webbuilder-sqlite-20261115-030500.db
scripts/restore.sh backups/webbuilder-pg-20261115-030500.sql   # Postgres
```

Aturan restore (skrip menegakkannya):

1. **Hentikan server dulu.** Skrip menolak bila proses `webbuilder` masih
   jalan, kecuali diberi `--force` (tetap berisiko: server bisa menimpa
   hasil restore).
2. Skrip selalu membuat salinan pengaman database lama
   (`webbuilder.db.pre-restore-<stamp>`) sebelum menimpa — salah restore
   masih bisa dibatalkan dengan mengembalikan file itu.
3. Backup SQLite diverifikasi `integrity_check` **sebelum dan sesudah**
   penyalinan; restore Postgres memakai `psql -v ON_ERROR_STOP=1` dan
   meminta konfirmasi ketik `YA` (kecuali `--force`).
4. Jenis backup dideteksi dari **isi file** (header `SQLite format 3` /
   teks `PostgreSQL database dump`), bukan dari nama file.
5. Restore **membuang** data yang masuk sesudah backup dibuat. Pakai hanya
   untuk rollback deploy / DB rusak — dan umumkan ke tim sesudahnya.

Sesudah restore SQLite: jalankan ulang server, lalu cek login + satu
project terbuka normal.

## Jadwal yang disarankan

- **Harian, pukul 03:05 WIB** (di luar jam ramai), via cron di host yang
  menjalankan server — contoh:
  `5 3 * * * /home/hatch/workspace/website-builder/scripts/backup.sh >> /var/log/webbuilder-backup.log 2>&1`
- **Sebelum setiap deploy produksi** (langkah wajib di alur deploy, lihat
  `docs/deploy.md`).
- **Sebelum migrasi skema / perubahan besar** apa pun.
- Simpan minimal satu salinan backup **di luar host** (rsync/scp ke mesin
  lain) — backup yang tinggal di disk yang sama dengan database bukan
  perlindungan terhadap disk rusak.
- Uji restore **minimal sebulan sekali** ke database salinan (jangan ke
  database produksi): backup yang belum pernah dicoba di-restore belum
  terbukti bisa menyelamatkan apa pun.

## Batasan saat ini

- Skrip ini membackup database saja, bukan file project hasil generate di
  luar database (bila ada state file di luar DB, trek lain perlu
  menambahkan cakupannya).
- Variasi Postgres (`pg_dump`/`psql`) ditulis untuk saat opt-in Postgres
  aktif; selama server masih SQLite, jalur itu belum terpakai di produksi.

# Agent queue boundary

`server/internal/queue` mendefinisikan kontrak queue yang stabil untuk
pekerjaan agent, dengan dua adapter. Handler API dan pipeline chat SSE tidak
berubah oleh trek ini: belum ada handler yang memakai queue ini end-to-end
(penyambungan ke pembuatan `AgentRun` dan streaming event adalah langkah
berikut, di luar trek ini).

## Kontrak

```go
type Queue interface {
    Enqueue(context.Context, Job) error
    Run(context.Context, Handler)
    Close()
}

type Job struct {
    ID             string
    Kind           string
    Payload        []byte
    IdempotencyKey string // kosong = sama dengan ID; dipakai adapter durable
}

type Handler func(context.Context, Job) error
```

`Manager` (`manager.go`) membungkus `Queue` apa pun dengan pelacakan status
in-memory (`queued`/`running`/`success`/`failed`/`canceled`), dedupe per ID,
dan pembatalan job yang sedang berjalan. Manager tidak tahu-menahu soal
persistensi — itu urusan adapter.

## Adapter 1: InProcess (default)

`NewInProcess(size)` — channel in-memory. Dipakai saat ini dan tetap default:
tanpa setup apa pun, tanpa dependensi baru. Job hilang bila proses mati.
Cocok untuk development dan single-node.

## Adapter 2: DBQueue (durable, tanpa layanan baru)

`NewDB(db, opts...)` — adapter berbasis tabel `queue_jobs` di **database yang
sama** dengan aplikasi (SQLite maupun Postgres). Tidak butuh Redis, tidak
butuh proses worker terpisah: proses mana pun yang menjalankan `Run` bisa
jadi worker, termasuk beberapa proses sekaligus.

### Semantik

- **Idempotensi.** `idempotency_key` ber-UNIQUE constraint. Enqueue ganda
  dengan key sama mengembalikan `nil` tanpa membuat baris kedua — job yang
  sudah ada yang menang (ID boleh berbeda). Key default = `Job.ID` bila
  `Job.IdempotencyKey` kosong. Enqueue dengan ID yang sudah ada tapi key
  berbeda adalah kesalahan pemrograman dan mengembalikan error.
- **Status.** `pending` → `running` → `done`, atau `failed` setelah
  percobaan habis. Kolom: `attempts`, `max_attempts`, `run_after`,
  `leased_until`, `leased_by`, `last_error`, `created_at`, `updated_at`.
- **Retry + backoff.** Handler yang mengembalikan error dijadwalkan ulang
  (`status` kembali `pending`, `run_after` = sekarang + backoff eksponensial
  `base * 2^(attempts-1)`, dibatasi maksimum). Default: base 5 detik, maks
  5 menit, `max_attempts` 5. Setelah batas habis: `failed` + `last_error`.
- **Claim/lease.** Worker mengambil job lewat `UPDATE` atomik dengan syarat
  baris masih `pending` (atau `running` dengan lease kedaluwarsa). Dua worker
  yang berebut job yang sama: hanya satu yang mendapat `RowsAffected == 1`.
  Lease default 5 menit; job `running` yang leasenya kedaluwarsa (worker mati
  / crash) diambil alih worker lain. Jadi job tidak hilang dan tidak
  diproses dua kali dalam keadaan normal.
- **Opsi:** `WithDBLease`, `WithDBMaxAttempts`, `WithDBBackoff(base, max)`,
  `WithDBPollInterval` (jeda saat tidak ada job, default 1 detik),
  `WithDBWorkerID`.

### Menyiapkan tabel

- **Postgres:** migrasi goose `00002_queue_jobs.sql` (diterapkan otomatis
  saat server start dengan `DATABASE_URL` postgres, atau manual lewat
  `go run ./cmd/migrate up`). Lihat `docs/database.md`.
- **SQLite / dev / test:** `queue.Migrate(db)` (GORM AutoMigrate atas
  `JobRecord`).

### Contoh pemakaian

```go
q := queue.NewDB(db) // atau queue.NewInProcess(32) untuk default
m := queue.NewManager(q)
ctx := context.Background()
go m.Run(ctx, func(ctx context.Context, job queue.Job) error {
    // kerjakan job; kembalikan error untuk retry/backoff
    return nil
})
err := m.Enqueue(ctx, queue.Job{
    ID: "run-123", Kind: "agent",
    Payload: []byte(`{"projectId": 7}`),
    IdempotencyKey: "run-123", // opsional; kosong = ID
})
```

Catatan: snapshot `Manager` bersifat in-memory — bila proses mati, status
terakhir yang terlihat di `Manager.Get` hilang, tetapi job-nya tetap ada di
`queue_jobs` dan akan diproses/di-retry oleh worker berikutnya. Untuk status
job yang tahan restart, baca langsung tabel `queue_jobs`.

## Adapter 3: Redis/Asynq — LANGKAH BERIKUT (belum diimplementasikan)

Roadmap (`docs/roadmap.md` item 5) meminta Redis/Asynq sebagai adapter
opsional bila `REDIS_URL` diset. **Sengaja belum dikerjakan di trek ini**,
dengan alasan jujur:

1. Adapter DB di atas sudah memenuhi kebutuhan durability yang diminta
   (persistensi, retry, idempotensi, klaim) tanpa layanan baru — Redis
   akan menjadi dependensi operasional tambahan (server, password, failover)
   tanpa manfaat yang terukur untuk volume job saat ini.
2. Implementasi Asynq yang benar butuh server Redis untuk diuji (tidak ada
   di VM ini) dan keputusan desain yang belum diputuskan: apakah payload
   tetap di `queue_jobs` (Redis hanya sebagai pemicu) atau pindah penuh ke
   Redis, serta bagaimana idempotency key dan lease dipetakan ke semantik
   Asynq (yang tidak punya lease bawaan).
3. Kontrak `Queue` sudah stabil, jadi adapter Redis/Asynq nantinya cukup
   mengimplementasikan interface yang sama tanpa mengubah handler.

Langkah berikut yang disarankan: sediakan Redis di staging, implementasikan
`RedisQueue` (atau Asynq) di `server/internal/queue/redis.go` dengan test
yang sama polanya dengan `db_test.go` (idempotensi, klaim tunggal, retry,
lease), lalu aktifkan bila `REDIS_URL` diset — tanpa mengubah default.

## Test

- `queue_test.go`, `manager_test.go` — adapter InProcess + Manager (sudah ada,
  tetap lolos).
- `db_test.go` — adapter DB terhadap SQLite in-memory: idempotensi key,
  default key = ID, error ID-sama-key-beda, dua worker hanya mengirim sekali,
  retry lalu sukses (attempts = 3), max attempts → failed, lease kedaluwarsa
  diambil alih, enqueue setelah Close → `ErrClosed`.
- `TestDBQueuePostgres` (di `db_test.go`, skip bila `WB_TEST_POSTGRES_URL`
  tidak diset) — idempotensi + pengiriman terhadap Postgres sungguhan.

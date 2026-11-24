# Agent queue (wired end-to-end)

`server/internal/queue` mendefinisikan kontrak queue yang stabil untuk
pekerjaan agent, dengan dua adapter. Sejak trek `dbqueue-wiring`, queue ini
TERSAMBUNG ke handler agent: setiap chat agent membuat `AgentRun` lalu
meng-enqueue satu job durable; consumer mengeksekusi pipeline yang sama
dan event SSE mengalir kembali ke client lewat event bus in-process
(lihat "Wiring end-to-end" di bawah). Kontrak SSE ke frontend tidak berubah:
POST yang sama, event yang sama, urutan yang sama.

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

## Adapter 1: InProcess (fallback eksplisit, BUKAN default)

`NewInProcess(size)` — channel in-memory. Dipakai HANYA bila
`WEBBUILDER_QUEUE=inprocess` diset eksplisit: tanpa setup apa pun, tanpa
dependensi baru. Job hilang bila proses mati. Cocok untuk development dan
single-node.

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

## Wiring end-to-end (AgentRun -> queue -> SSE)

File: `server/internal/handler/agentqueue.go` (init + job handler),
`agentpipeline.go` (pipeline agent yang dieksekusi consumer),
`agentbus.go` (event bus SSE), `server/main.go` (start + shutdown),
`server/internal/config/config.go` (`WEBBUILDER_QUEUE`,
`WEBBUILDER_QUEUE_WORKERS`).

### Alur request

1. `POST /api/projects/:id/chat` (`postChat`) seperti biasa: validasi,
   intent, moderasi, greeting/discuss inline (tanpa queue, tanpa
   `AgentRun`), cek kuota. Lalu:
2. `createAgentRun` membuat baris `AgentRun` status **`queued`** (dulu
   `"running"` — status awal berubah; `updateAgentPhase("analyzing")` di
   awal pipeline mengubahnya menjadi `"running"`).
3. postChat meng-enqueue satu job durable (`Kind: "agent-run"`,
   `ID` + idempotency key = `"agent-run-<runID>"`, payload JSON berisi
   run/project/user + pesan + mode + konteks). Kirim ganda (retry client)
   tidak mengeksekusi ganda. Enqueue memakai `context.Background()` supaya
   job tersimpan walau client putus di tengah jalan.
4. postChat berlangganan topik run di event bus lalu me-relay event ke
   HTTP stream sampai topik ditutup (job selesai) atau client putus. Job
   tetap berjalan di queue bila client putus — status run di DB menjadi
   sumber kebenaran; user bisa memuat ulang dan melihat hasilnya.
5. Consumer (`Manager.Run`, sejumlah `WEBBUILDER_QUEUE_WORKERS` goroutine
   yang dijalankan `main.go`) mengambil job dan menjalankan
   `AgentJobHandler` -> `executeAgentPipeline` — pipeline yang sama persis
   dengan yang dulu jalan inline di postChat (gates, konteks, stream AI,
   apply file, migrasi, kontrak TS, SQL, acceptance + auto-fix). Setiap
   event SSE diterbitkan ke bus (`message`, `changes`, `result`, ...);
   baris data-only `[ERROR] ...` dari jalur error provider dipertahankan
   lewat event `Raw`.
6. Bila pipeline mencapai terminal state (`completed`/`failed`/`cancelled`/
   `waiting_for_confirmation`), job handler mengembalikan `nil` (job
   `done`, TIDAK retry) dan menutup topik bus — relay menulis `[DONE]`.

### Konfigurasi

| Env | Default | Arti |
| --- | --- | --- |
| `WEBBUILDER_QUEUE` | `db` | Backend: `db` (durable) atau `inprocess` (fallback eksplisit). Nilai lain -> server gagal-start (fail-fast di `config.Load`). |
| `WEBBUILDER_QUEUE_WORKERS` | `2` | Jumlah consumer paralel (1..8; di luar itu -> peringatan + default 2). Dua worker menjaga dua project berbeda tetap bisa berjalan bersamaan tanpa membanjiri mesin dengan build npm. |

### Bila init `db` gagal

Server **gagal-start dengan error jelas, TANPA fallback diam-diam** ke
in-memory. Alasannya: fallback diam-diam akan membuat job hilang saat
restart tanpa ada yang sadar — persis kegagalan yang dirancang untuk
dicegah. Dua kasus:

- SQLite dan tabel belum ada -> dibuat otomatis (`queue.Migrate`).
- Postgres dan tabel belum ada -> error: `tabel queue_jobs belum ada —
  terapkan migrasi goose 00002 dulu (go run ./cmd/migrate up)`.

`inprocess` hanya boleh dipilih eksplisit (untuk development); server
mencetak peringatan keras saat memakainya.

### Restart recovery

- Job `pending` (belum diambil) diambil consumer sesudah restart seperti
  biasa.
- Job `running` yang tertinggal saat proses mati diambil alih consumer
  lain sesudah lease kedaluwarsa (default 5 menit) — claim atomik
  memastikan hanya satu worker yang mengeksekusinya. Pipeline dieksekusi
  ulang dari awal (stream AI baru; `recordAIUsage` bisa tercatat ganda —
  diterima dan didokumentasikan); eksekusi ulang aman karena pipeline
  memeriksa baris `AgentRun` dulu: run yang sudah terminal tidak
  dieksekusi ulang.
- Bila `finish` queue gagal karena konteks mati saat shutdown, baris job
  tetap `running` dan direklamasi dengan cara yang sama sesudah restart.
- Bus SSE bersifat in-memory: bila proses mati, stream HTTP ikut mati.
  Client yang memuat ulang membaca status dari baris `AgentRun` di DB.

### Cancel

`cancelAgentRun` (HTTP) membatalkan stream lewat `agentCancels` DAN
`Manager.Cancel` untuk job-nya, lalu menandai run `cancelled` di DB.
`Manager.Cancel` saja tidak menghapus baris DB — celah itu ditutup
handler job: run yang sudah `cancelled` dilewati tanpa eksekusi
(`executeAgentPipeline` mengembalikan `nil` sebelum bekerja). Pipeline
juga membedakan batal-pengguna vs konteks-mati (shutdown): hanya bila
baris run sudah `cancelled` di DB, stream yang abort ditandai
`cancelled`; bila konteks mati tetapi run masih aktif, handler
mengembalikan error supaya queue me-retry sesudah restart.

### Shutdown graceful

`main.go`: sinyal SIGINT/SIGTERM membatalkan konteks consumer dulu
(consumer berhenti mengambil job baru; pipeline yang sedang berjalan
dibatalkan lewat konteksnya dan di-retry sesudah restart seperti di
atas), baru HTTP server dimatikan (timeout 30 detik).

### Memeriksa job macet

Status tahan restart hanya ada di tabel `queue_jobs` (dan baris
`AgentRun`) — snapshot in-memory `Manager` hilang saat restart.

```sql
-- Job yang macet / menunggu (SQLite: sqlite3 ../data/webbuilder.db)
SELECT id, kind, status, attempts, max_attempts, run_after,
       leased_until, leased_by, last_error, created_at
FROM queue_jobs
ORDER BY created_at DESC LIMIT 20;

-- Job gagal permanen (kehabisan percobaan)
SELECT id, attempts, last_error FROM queue_jobs WHERE status = 'failed';

-- Run agent yang masih menggantung (bandingkan dengan queue_jobs)
SELECT id, project_id, status, phase, error FROM agent_runs
WHERE status IN ('queued', 'running') ORDER BY id DESC LIMIT 20;
```

Perilaku yang perlu diwaspadai:

- Run `queued`/`running` lebih tua dari 10 menit DITANDAI `failed` oleh
  orphan recovery di `listAgentRuns` ("Proses berhenti karena tidak
  merespons") saat daftar run dimuat — jendela yang sama sudah berlaku
  untuk run `running` yang lama. Bila backlog antrean tumbuh sampai job
  menunggu > 10 menit, naikkan jendela itu (di luar scope wiring ini).
- Serialisasi per-proyek TIDAK diimplementasikan: dua run untuk project
  yang sama bisa berjalan bersamaan di dua worker (race tulis `p.Files`
  antar-run sudah ada sejak jalur inline — dicatat sebagai batasan).
- Retry mengeksekusi ulang pipeline dari awal, termasuk stream AI baru
  (token terhitung lagi).

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
- `agentqueue_test.go` — wiring end-to-end dengan AI stub
  (httptest OpenAI-compatible) + proyek yang lolos kontrak TS:
  - `TestAgentQueueEndToEnd` — enqueue -> consumer mengeksekusi -> run
    terminal (`failed`, karena acceptance gagal `vite: not found` tanpa
    dependensi vite) + job `done` (attempts 1) + event bus menerima
    `message` + `result`.
  - `TestAgentQueueRestartRecovery` — dua fase pada DB yang sama: job
    di-enqueue tanpa consumer tetap `pending` lalu selesai sesudah
    consumer jalan; job yang dibiarkan `running` dengan lease kedaluwarsa
    (simulasi worker mati sesudah claim) direbut consumer baru dan
    selesai (attempts >= 2).
  - `TestAgentQueueIdempotentEnqueue` — enqueue ganda dengan idempotency
    key sama -> tepat 1 baris job, di-claim sekali.
  - `TestInitAgentQueueBackends` — `inprocess` diterima, backend tak
    dikenal ditolak, `db` membuat tabel `queue_jobs` untuk SQLite.
- `agentbus_test.go` — event bus: replay log saat Subscribe, event live,
  Close menutup channel, Publish sesudah Close diabaikan, isolasi antar
  topik.

Yang TIDAK dibuktikan otomatis: uji restart PROSES sungguhan (butuh test
level binary — dua fase `Run` pada DB yang sama adalah pendekatan yang
dipakai) dan perilaku di bawah beban.

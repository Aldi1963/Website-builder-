package queue

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"gorm.io/gorm/logger"
)

// JobRecord adalah baris tabel queue_jobs: satu job agent yang persisten.
// Dipakai oleh DBQueue; dibuat oleh migrasi goose 00002 untuk Postgres,
// atau oleh Migrate (AutoMigrate) untuk SQLite/dev.
type JobRecord struct {
	ID             string     `gorm:"primaryKey;size:255"`
	Kind           string     `gorm:"size:100;not null"`
	Payload        []byte     // bytea di Postgres, blob di SQLite (tanpa tag type agar portable)
	IdempotencyKey string     `gorm:"size:255;uniqueIndex;not null"`
	Status         string     `gorm:"size:20;not null;default:'pending'"` // pending|running|done|failed
	Attempts       int        `gorm:"default:0"`
	MaxAttempts    int        `gorm:"default:5"`
	RunAfter       time.Time  // jangan diproses sebelum waktu ini (dipakai backoff)
	LeasedUntil    *time.Time // klaim kedaluwarsa: worker lain boleh mengambil alih
	LeasedBy       string     `gorm:"size:100"`
	LastError      string     `gorm:"type:text"`
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

// TableName mengunci nama tabel agar tidak bergantung pada penamaan GORM.
func (JobRecord) TableName() string { return "queue_jobs" }

// Migrate membuat/memperbarui tabel queue_jobs di DB yang diberikan.
// Untuk Postgres produksi, jalankan migrasi goose 00002 sebagai gantinya;
// fungsi ini untuk SQLite/dev dan test.
func Migrate(db *gorm.DB) error {
	return db.AutoMigrate(&JobRecord{})
}

// DBQueue adalah adapter Queue berbasis tabel queue_jobs di DB yang sama
// (tanpa layanan baru: tanpa Redis, tanpa proses tambahan).
//   - Idempotensi: enqueue ganda dengan idempotency key sama mengembalikan
//     nil tanpa membuat baris kedua (UNIQUE + ON CONFLICT DO NOTHING).
//   - Klaim/lease: worker mengambil job lewat UPDATE atomik dengan syarat
//     status masih pending (atau lease running sudah kedaluwarsa), sehingga
//     dua worker tidak pernah memproses job yang sama. Lease yang kedaluwarsa
//     membuat job "running" yang ditinggal worker mati bisa diambil alih.
//   - Retry: handler yang gagal dijadwalkan ulang dengan backoff eksponensial
//     sampai MaxAttempts, lalu berstatus failed dengan LastError terisi.
//
// DBQueue aman dipakai dari banyak proses sekaligus. Satu Run memproses
// satu job dalam satu waktu; jalankan beberapa Run (atau beberapa proses)
// untuk paralelisme.
type DBQueue struct {
	db           *gorm.DB
	lease        time.Duration
	maxAttempts  int
	backoffBase  time.Duration
	backoffMax   time.Duration
	pollInterval time.Duration
	workerID     string
	closed       chan struct{}
	once         sync.Once
}

// DBOption mengubah satu pengaturan DBQueue.
type DBOption func(*DBQueue)

// WithDBLease mengatur durasi lease klaim (default 5 menit).
func WithDBLease(d time.Duration) DBOption { return func(q *DBQueue) { q.lease = d } }

// WithDBMaxAttempts mengatur batas percobaan per job (default 5).
func WithDBMaxAttempts(n int) DBOption { return func(q *DBQueue) { q.maxAttempts = n } }

// WithDBBackoff mengatur backoff dasar dan maksimum retry (default 5 dtk / 5 mnt).
func WithDBBackoff(base, max time.Duration) DBOption {
	return func(q *DBQueue) { q.backoffBase = base; q.backoffMax = max }
}

// WithDBPollInterval mengatur jeda saat tidak ada job yang bisa diklaim (default 1 dtk).
func WithDBPollInterval(d time.Duration) DBOption { return func(q *DBQueue) { q.pollInterval = d } }

// WithDBWorkerID mengatur nama worker yang tercatat di leased_by (default: db-worker).
func WithDBWorkerID(id string) DBOption { return func(q *DBQueue) { q.workerID = id } }

// NewDB membuat adapter queue berbasis DB. db harus sudah berisi tabel
// queue_jobs (migrasi goose 00002 atau Migrate).
func NewDB(db *gorm.DB, opts ...DBOption) *DBQueue {
	q := &DBQueue{
		db:           db,
		lease:        5 * time.Minute,
		maxAttempts:  5,
		backoffBase:  5 * time.Second,
		backoffMax:   5 * time.Minute,
		pollInterval: time.Second,
		workerID:     "db-worker",
		closed:       make(chan struct{}),
	}
	for _, o := range opts {
		o(q)
	}
	if q.maxAttempts < 1 {
		q.maxAttempts = 1
	}
	if q.lease <= 0 {
		q.lease = 5 * time.Minute
	}
	if q.backoffBase <= 0 {
		q.backoffBase = 5 * time.Second
	}
	if q.backoffMax <= 0 {
		q.backoffMax = 5 * time.Minute
	}
	if q.pollInterval <= 0 {
		q.pollInterval = time.Second
	}
	if q.workerID == "" {
		q.workerID = "db-worker"
	}
	return q
}

// Enqueue menyimpan job. Idempotency key default adalah Job.ID bila
// Job.IdempotencyKey kosong. Enqueue kedua dengan key yang sama (job ID boleh
// berbeda) tidak membuat duplikat dan mengembalikan nil — job lama yang
// menang. Enqueue dengan ID yang sudah ada tapi key berbeda adalah kesalahan
// pemrograman dan mengembalikan error.
func (q *DBQueue) Enqueue(ctx context.Context, job Job) error {
	select {
	case <-q.closed:
		return ErrClosed
	default:
	}
	if job.ID == "" {
		return errors.New("job id is required")
	}
	key := job.IdempotencyKey
	if key == "" {
		key = job.ID
	}
	rec := JobRecord{
		ID:             job.ID,
		Kind:           job.Kind,
		Payload:        job.Payload,
		IdempotencyKey: key,
		Status:         "pending",
		MaxAttempts:    q.maxAttempts,
		RunAfter:       time.Now(),
	}
	err := q.db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "idempotency_key"}},
		DoNothing: true,
	}).Create(&rec).Error
	if err != nil {
		return fmt.Errorf("enqueue job %s: %w", job.ID, err)
	}
	return nil
}

// quiet mengembalikan sesi DB tanpa log error GORM. Dipakai untuk polling
// klaim: "record not found" saat tidak ada job adalah keadaan normal, bukan
// error, dan tidak boleh membanjiri log tiap detik.
func (q *DBQueue) quiet() *gorm.DB {
	return q.db.Session(&gorm.Session{Logger: logger.Default.LogMode(logger.Silent)})
}

// claim mengambil satu job yang siap diproses dan menguncinya untuk worker ini.
// Mengembalikan false bila tidak ada job yang bisa diklaim saat ini.
func (q *DBQueue) claim(ctx context.Context) (Job, bool) {
	now := time.Now()
	var cand JobRecord
	// Kandidat: pending dan sudah waktunya, ATAU running tapi leasenya
	// kedaluwarsa (worker sebelumnya mati/crash).
	err := q.quiet().WithContext(ctx).
		Where("(status = ? OR (status = ? AND leased_until < ?)) AND run_after <= ?",
			"pending", "running", now, now).
		Order("run_after ASC, id ASC").First(&cand).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return Job{}, false
		}
		return Job{}, false
	}
	// UPDATE atomik: hanya menang bila baris masih dalam keadaan yang sama
	// seperti saat dibaca (status pending, atau running dengan lease kedaluwarsa).
	// Dua worker yang berebut: hanya satu yang mendapat RowsAffected == 1.
	leaseUntil := now.Add(q.lease)
	res := q.db.WithContext(ctx).Model(&JobRecord{}).
		Where("id = ? AND ((status = ? AND (leased_until IS NULL OR leased_until < ?)) OR (status = ? AND leased_until < ?))",
			cand.ID, "pending", now, "running", now).
		Updates(map[string]any{
			"status":       "running",
			"leased_until": leaseUntil,
			"leased_by":    q.workerID,
			"attempts":     gorm.Expr("attempts + 1"),
		})
	if res.Error != nil || res.RowsAffected == 0 {
		return Job{}, false
	}
	var claimed JobRecord
	if err := q.quiet().WithContext(ctx).Where("id = ?", cand.ID).First(&claimed).Error; err != nil {
		return Job{}, false
	}
	return Job{ID: claimed.ID, Kind: claimed.Kind, Payload: claimed.Payload,
		IdempotencyKey: claimed.IdempotencyKey}, true
}

// finish mencatat hasil satu percobaan handler.
func (q *DBQueue) finish(ctx context.Context, job Job, handlerErr error) {
	now := time.Now()
	if handlerErr == nil {
		q.db.WithContext(ctx).Model(&JobRecord{}).Where("id = ?", job.ID).
			Updates(map[string]any{"status": "done", "leased_until": nil, "last_error": ""})
		return
	}
	var rec JobRecord
	if err := q.db.WithContext(ctx).Where("id = ?", job.ID).First(&rec).Error; err != nil {
		return
	}
	if rec.Attempts >= rec.MaxAttempts {
		q.db.WithContext(ctx).Model(&JobRecord{}).Where("id = ?", job.ID).
			Updates(map[string]any{"status": "failed", "leased_until": nil, "last_error": handlerErr.Error()})
		return
	}
	// Backoff eksponensial: base * 2^(attempts-1), dibatasi maksimum.
	backoff := q.backoffBase * time.Duration(1<<uint(rec.Attempts-1))
	if backoff > q.backoffMax {
		backoff = q.backoffMax
	}
	q.db.WithContext(ctx).Model(&JobRecord{}).Where("id = ?", job.ID).
		Updates(map[string]any{
			"status":       "pending",
			"run_after":    now.Add(backoff),
			"leased_until": nil,
			"last_error":   handlerErr.Error(),
		})
}

// Run mengambil job terus-menerus sampai ctx selesai atau Close dipanggil.
// Handler yang mengembalikan error memicu retry/backoff di finish.
func (q *DBQueue) Run(ctx context.Context, handler Handler) {
	for {
		select {
		case <-q.closed:
			return
		case <-ctx.Done():
			return
		default:
		}
		job, ok := q.claim(ctx)
		if !ok {
			select {
			case <-q.closed:
				return
			case <-ctx.Done():
				return
			case <-time.After(q.pollInterval):
			}
			continue
		}
		err := handler(ctx, job)
		q.finish(ctx, job, err)
	}
}

// Close menghentikan Run dan menolak Enqueue berikutnya.
func (q *DBQueue) Close() { q.once.Do(func() { close(q.closed) }) }

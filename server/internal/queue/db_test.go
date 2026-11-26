package queue

import (
	"context"
	"errors"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

// getTestPostgresDSN mengembalikan URL Postgres uji dari environment ("" = skip).
func getTestPostgresDSN(t *testing.T) string {
	t.Helper()
	return os.Getenv("WB_TEST_POSTGRES_URL")
}

func postgresDialector(dsn string) gorm.Dialector { return postgres.Open(dsn) }

// openTestDB membuka SQLite in-memory khusus satu test (satu koneksi agar
// cache=shared konsisten) dan membuat tabel queue_jobs.
func openTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	db, err := gorm.Open(sqlite.Open("file:"+t.Name()+"?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	sqlDB.SetMaxOpenConns(1)
	t.Cleanup(func() { sqlDB.Close() })
	if err := Migrate(db); err != nil {
		t.Fatal(err)
	}
	return db
}

func countJobs(t *testing.T, db *gorm.DB) int64 {
	t.Helper()
	var n int64
	if err := db.Model(&JobRecord{}).Count(&n).Error; err != nil {
		t.Fatal(err)
	}
	return n
}

func jobStatus(t *testing.T, db *gorm.DB, id string) (JobRecord, bool) {
	t.Helper()
	var rec JobRecord
	err := db.Where("id = ?", id).First(&rec).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return rec, false
	}
	if err != nil {
		t.Fatal(err)
	}
	return rec, true
}

func waitFor(t *testing.T, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("kondisi tidak tercapai dalam batas waktu")
}

func TestDBEnqueueIdempotent(t *testing.T) {
	db := openTestDB(t)
	q := NewDB(db, WithDBPollInterval(5*time.Millisecond))
	defer q.Close()
	ctx := context.Background()

	job := Job{ID: "job-1", Kind: "agent", Payload: []byte(`{"a":1}`), IdempotencyKey: "key-1"}
	if err := q.Enqueue(ctx, job); err != nil {
		t.Fatal(err)
	}
	// Enqueue kedua: ID berbeda, key sama -> bukan duplikat.
	if err := q.Enqueue(ctx, Job{ID: "job-1-dup", Kind: "agent", IdempotencyKey: "key-1"}); err != nil {
		t.Fatal(err)
	}
	// Enqueue ketiga: persis sama -> bukan duplikat.
	if err := q.Enqueue(ctx, job); err != nil {
		t.Fatal(err)
	}
	if n := countJobs(t, db); n != 1 {
		t.Fatalf("jumlah baris = %d, want 1", n)
	}
	rec, ok := jobStatus(t, db, "job-1")
	if !ok || rec.Status != "pending" || rec.IdempotencyKey != "key-1" {
		t.Fatalf("job tersimpan salah: %+v ok=%v", rec, ok)
	}
}

func TestDBEnqueueDefaultsKeyToID(t *testing.T) {
	db := openTestDB(t)
	q := NewDB(db)
	defer q.Close()
	ctx := context.Background()
	if err := q.Enqueue(ctx, Job{ID: "k1", Kind: "agent"}); err != nil {
		t.Fatal(err)
	}
	if err := q.Enqueue(ctx, Job{ID: "k1", Kind: "agent"}); err != nil {
		t.Fatal(err)
	}
	if n := countJobs(t, db); n != 1 {
		t.Fatalf("jumlah baris = %d, want 1", n)
	}
}

func TestDBEnqueueSameIDDifferentKeyErrors(t *testing.T) {
	db := openTestDB(t)
	q := NewDB(db)
	defer q.Close()
	ctx := context.Background()
	if err := q.Enqueue(ctx, Job{ID: "same", Kind: "agent", IdempotencyKey: "k-a"}); err != nil {
		t.Fatal(err)
	}
	if err := q.Enqueue(ctx, Job{ID: "same", Kind: "agent", IdempotencyKey: "k-b"}); err == nil {
		t.Fatal("ID sama dengan key berbeda harus error")
	}
}

func TestDBRunDeliversOnceWithTwoWorkers(t *testing.T) {
	db := openTestDB(t)
	q := NewDB(db, WithDBPollInterval(5*time.Millisecond))
	defer q.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var deliveries atomic.Int32
	handler := func(_ context.Context, _ Job) error {
		deliveries.Add(1)
		return nil
	}
	go q.Run(ctx, handler)
	go q.Run(ctx, handler)
	if err := q.Enqueue(ctx, Job{ID: "once", Kind: "agent"}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 2*time.Second, func() bool {
		rec, ok := jobStatus(t, db, "once")
		return ok && rec.Status == "done"
	})
	time.Sleep(100 * time.Millisecond) // beri waktu bila ada klaim ganda
	if d := deliveries.Load(); d != 1 {
		t.Fatalf("handler dipanggil %d kali, want 1", d)
	}
}

func TestDBRetryThenSuccess(t *testing.T) {
	db := openTestDB(t)
	q := NewDB(db,
		WithDBPollInterval(5*time.Millisecond),
		WithDBBackoff(5*time.Millisecond, 50*time.Millisecond),
		WithDBMaxAttempts(5),
	)
	defer q.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var calls atomic.Int32
	go q.Run(ctx, func(_ context.Context, _ Job) error {
		if calls.Add(1) < 3 {
			return errors.New("gagal sementara")
		}
		return nil
	})
	if err := q.Enqueue(ctx, Job{ID: "retry", Kind: "agent"}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 5*time.Second, func() bool {
		rec, ok := jobStatus(t, db, "retry")
		return ok && rec.Status == "done"
	})
	rec, _ := jobStatus(t, db, "retry")
	if rec.Attempts != 3 {
		t.Fatalf("attempts = %d, want 3", rec.Attempts)
	}
	if calls.Load() != 3 {
		t.Fatalf("handler dipanggil %d kali, want 3", calls.Load())
	}
}

func TestDBMaxAttemptsMarksFailed(t *testing.T) {
	db := openTestDB(t)
	q := NewDB(db,
		WithDBPollInterval(5*time.Millisecond),
		WithDBBackoff(5*time.Millisecond, 50*time.Millisecond),
		WithDBMaxAttempts(2),
	)
	defer q.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var calls atomic.Int32
	go q.Run(ctx, func(_ context.Context, _ Job) error {
		calls.Add(1)
		return errors.New("selalu gagal")
	})
	if err := q.Enqueue(ctx, Job{ID: "fail", Kind: "agent"}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 5*time.Second, func() bool {
		rec, ok := jobStatus(t, db, "fail")
		return ok && rec.Status == "failed"
	})
	rec, _ := jobStatus(t, db, "fail")
	if rec.Attempts != 2 {
		t.Fatalf("attempts = %d, want 2", rec.Attempts)
	}
	if rec.LastError != "selalu gagal" {
		t.Fatalf("last_error = %q", rec.LastError)
	}
	if calls.Load() != 2 {
		t.Fatalf("handler dipanggil %d kali, want 2", calls.Load())
	}
}

func TestDBLeaseExpiryReclaimsStuckJob(t *testing.T) {
	db := openTestDB(t)
	q := NewDB(db, WithDBPollInterval(5*time.Millisecond), WithDBLease(time.Minute))
	defer q.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Simulasikan worker yang mati: status running, lease sudah lewat.
	past := time.Now().Add(-time.Minute)
	if err := db.Create(&JobRecord{
		ID: "stuck", Kind: "agent", IdempotencyKey: "stuck",
		Status: "running", Attempts: 1, MaxAttempts: 5,
		RunAfter: time.Now(), LeasedUntil: &past, LeasedBy: "worker-mati",
	}).Error; err != nil {
		t.Fatal(err)
	}
	var done atomic.Bool
	go q.Run(ctx, func(_ context.Context, _ Job) error {
		done.Store(true)
		return nil
	})
	waitFor(t, 2*time.Second, func() bool { return done.Load() })
	rec, _ := jobStatus(t, db, "stuck")
	if rec.Status != "done" {
		t.Fatalf("status = %q, want done (job stuck harus diambil alih)", rec.Status)
	}
}

func TestDBEnqueueAfterClose(t *testing.T) {
	db := openTestDB(t)
	q := NewDB(db)
	q.Close()
	if err := q.Enqueue(context.Background(), Job{ID: "x"}); !errors.Is(err, ErrClosed) {
		t.Fatalf("err = %v, want ErrClosed", err)
	}
}

// TestDBQueuePostgres menjalankan ulang skenario idempotensi + klaim terhadap
// Postgres sungguhan. Skip bila WB_TEST_POSTGRES_URL tidak diset.
func TestDBQueuePostgres(t *testing.T) {
	dsn := getTestPostgresDSN(t)
	if dsn == "" {
		t.Skip("WB_TEST_POSTGRES_URL tidak diset — lewati uji Postgres-live")
	}
	db, err := gorm.Open(postgresDialector(dsn), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	defer sqlDB.Close()
	if _, err := sqlDB.Exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public;"); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(db); err != nil {
		t.Fatalf("Migrate queue_jobs: %v", err)
	}
	q := NewDB(db, WithDBPollInterval(10*time.Millisecond))
	defer q.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if err := q.Enqueue(ctx, Job{ID: "pg-1", Kind: "agent", IdempotencyKey: "pg-key"}); err != nil {
		t.Fatal(err)
	}
	if err := q.Enqueue(ctx, Job{ID: "pg-1-dup", Kind: "agent", IdempotencyKey: "pg-key"}); err != nil {
		t.Fatal(err)
	}
	if n := countJobs(t, db); n != 1 {
		t.Fatalf("jumlah baris = %d, want 1", n)
	}
	var mu sync.Mutex
	var got []string
	go q.Run(ctx, func(_ context.Context, job Job) error {
		mu.Lock()
		got = append(got, job.ID)
		mu.Unlock()
		return nil
	})
	waitFor(t, 5*time.Second, func() bool {
		rec, ok := jobStatus(t, db, "pg-1")
		return ok && rec.Status == "done"
	})
	mu.Lock()
	defer mu.Unlock()
	if len(got) != 1 || got[0] != "pg-1" {
		t.Fatalf("delivered = %v, want [pg-1]", got)
	}
}

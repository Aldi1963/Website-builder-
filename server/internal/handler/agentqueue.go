// Penyambungan DBQueue ke handler agent (end-to-end).
//
// Alur:
//  1. main.go memanggil InitAgentQueue sesudah database dibuka: backend
//     "db" (default) memakai tabel queue_jobs di DB yang sama — dibuat
//     otomatis untuk SQLite, wajib sudah ada (migrasi goose 00002) untuk
//     Postgres, kalau tidak server gagal-start dengan pesan jelas.
//     "inprocess" hanya fallback eksplisit (job hilang saat restart).
//  2. postChat membuat AgentRun (status "queued"), meng-enqueue satu job
//     durable (idempotency key = ID run, kirim ganda tidak mengeksekusi
//     ganda), lalu me-relay event SSE dari bus ke HTTP stream sampai topik
//     run ditutup. Kontrak SSE ke frontend tidak berubah.
//  3. Consumer (Manager.Run, sejumlah WEBBUILDER_QUEUE_WORKERS goroutine)
//     menjalankan AgentJobHandler: decode payload, eksekusi pipeline agent
//     yang sama (executeAgentPipeline), publish event ke bus.
//  4. Restart recovery: job pending/running yang tertinggal diambil alih
//     consumer sesudah restart lewat lease takeover adapter DBQueue
//     (lease default 5 menit); handler memeriksa baris AgentRun dulu —
//     run yang sudah terminal (mis. dibatalkan saat antre) tidak
//     dieksekusi ulang.
//
// Aturan pengembalian error job handler (menentukan retry queue):
//   - nil: pipeline mencapai terminal state (completed/failed/cancelled /
//     menunggu konfirmasi) — job selesai, JANGAN retry.
//   - error: pipeline abort sebelum terminal state (infra gagal, panic) —
//     queue me-retry dengan backoff. Pada upaya terakhir, run ditandai
//     gagal + event error terminal diterbitkan + topik bus ditutup supaya
//     stream SSE tidak menggantung.
package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"log/slog"
	"runtime/debug"
	"sync"

	"webbuilder/internal/config"
	"webbuilder/internal/database/models"
	"webbuilder/internal/queue"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// agentJobKind adalah Kind job queue untuk satu agent run.
const agentJobKind = "agent-run"

// agentJobID adalah ID + idempotency key job untuk satu agent run.
func agentJobID(runID uint) string {
	return fmt.Sprintf("agent-run-%d", runID)
}

// agentPipelineInput adalah payload job agent (JSON) — semua yang
// dibutuhkan pipeline, tanpa bergantung pada request HTTP yang sudah mati.
type agentPipelineInput struct {
	RunID         uint     `json:"runId"`
	ProjectID     uint     `json:"projectId"`
	UserID        uint     `json:"userId"`
	Message       string   `json:"message"`
	Mode          string   `json:"mode"`
	Image         string   `json:"image"`
	PreviewErrors []string `json:"previewErrors"`
	TerminalLines []string `json:"terminalLines"`
	Confirm       bool     `json:"confirm"`
	Intent        string   `json:"intent"`
	// ProviderID/Model adalah pilihan provider+model per prompt dari
	// postChat (0/kosong = pakai default). Pipeline me-resolve ulang
	// dari DB — bukan dari request HTTP yang sudah mati — supaya
	// pilihan itu yang benar-benar dipakai LLM.
	ProviderID uint   `json:"providerId"`
	Model      string `json:"model"`
}

var agentQueueMu sync.Mutex
var agentQueueMgr *queue.Manager
var agentQueueBus *agentEventBus

// agentQueue mengembalikan Manager + bus yang dipasang InitAgentQueue
// (nil bila belum diinisialisasi — postChat menolak dengan 500).
func agentQueue() (*queue.Manager, *agentEventBus) {
	agentQueueMu.Lock()
	defer agentQueueMu.Unlock()
	return agentQueueMgr, agentQueueBus
}

// InitAgentQueue membangun backend queue agent dari config dan memasangnya
// sebagai state package handler. Gagal init -> error (server gagal-start;
// TIDAK ada fallback diam-diam ke in-memory). Consumer TIDAK dijalankan di
// sini — main.go menjalankan Manager.Run sebanyak cfg.QueueWorkers.
func InitAgentQueue(db *gorm.DB, cfg config.Config) (*queue.Manager, error) {
	var q queue.Queue
	switch cfg.QueueBackend {
	case "db":
		if err := ensureAgentQueueTable(db); err != nil {
			return nil, err
		}
		q = queue.NewDB(db, queue.WithDBWorkerID("webbuilder"))
	case "inprocess":
		log.Println("[queue] PERINGATAN: WEBBUILDER_QUEUE=inprocess — job agent hilang bila proses mati; hanya untuk development")
		q = queue.NewInProcess(32)
	default:
		return nil, fmt.Errorf("queue backend tidak dikenal %q (harapkan \"db\" atau \"inprocess\")", cfg.QueueBackend)
	}
	mgr := queue.NewManager(q)
	bus := newAgentEventBus()
	agentQueueMu.Lock()
	agentQueueMgr = mgr
	agentQueueBus = bus
	agentQueueMu.Unlock()
	return mgr, nil
}

// ensureAgentQueueTable memastikan tabel queue_jobs ada sebelum consumer
// jalan. SQLite: dibuat otomatis (AutoMigrate). Postgres: tabel WAJIB
// sudah dibuat migrasi goose 00002 (diterapkan database.Migrate saat
// start); bila belum ada, gagal-start dengan pesan jelas — jangan diam-diam
// jalan tanpa tabel.
func ensureAgentQueueTable(db *gorm.DB) error {
	if db.Migrator().HasTable(&queue.JobRecord{}) {
		return nil
	}
	if db.Dialector.Name() == "sqlite" {
		if err := queue.Migrate(db); err != nil {
			return fmt.Errorf("queue: siapkan tabel queue_jobs (SQLite): %w", err)
		}
	} else {
		return fmt.Errorf("queue: tabel queue_jobs belum ada — terapkan migrasi goose 00002 dulu (go run ./cmd/migrate up)")
	}
	if !db.Migrator().HasTable(&queue.JobRecord{}) {
		return fmt.Errorf("queue: tabel queue_jobs tetap tidak ada setelah persiapan")
	}
	return nil
}

// AgentJobHandler adalah queue.Handler yang mengeksekusi satu agent run.
// Lihat aturan pengembalian error di komentar paket.
func AgentJobHandler(db *gorm.DB) queue.Handler {
	return func(ctx context.Context, job queue.Job) (err error) {
		var in agentPipelineInput
		_, bus := agentQueue()
		emit := func(ev agentBusEvent) {
			if bus != nil {
				bus.Publish(in.RunID, ev)
			}
		}
		// Panic di pipeline tidak boleh mematikan proses server: ubah jadi
		// error supaya queue me-retry; penanganan upaya-terakhir di bawah
		// berlaku juga untuk panic.
		defer func() {
			if r := recover(); r != nil {
				slog.Error("agent job: panic di pipeline", "jobId", job.ID, "panic", r, "stack", string(debug.Stack()))
				err = fmt.Errorf("agent pipeline panic: %v", r)
			}
			if in.RunID == 0 || bus == nil {
				return
			}
			if err == nil {
				// Terminal state tercapai -> tutup topik supaya relay SSE
				// mengakhiri stream dengan [DONE].
				bus.Close(in.RunID)
				return
			}
			if lastAttempt(db, job) {
				finishAgentRunIfActive(db, in.RunID, "failed", "Pipeline gagal setelah percobaan terakhir", err.Error())
				emit(newAgentBusEvent("error", gin.H{"message": "Pipeline gagal: " + err.Error()}))
				bus.Close(in.RunID)
			}
			// Bukan upaya terakhir: topik tetap dibuka supaya percobaan
			// berikut tetap mengalirkan event ke client yang sama.
		}()
		if jsonErr := json.Unmarshal(job.Payload, &in); jsonErr != nil {
			// Payload rusak tidak akan pernah sukses — buang tanpa retry.
			slog.Error("agent job: payload tidak valid, job dibuang tanpa retry", "jobId", job.ID, "error", jsonErr)
			return nil
		}
		if in.RunID == 0 || in.ProjectID == 0 {
			slog.Error("agent job: payload tidak lengkap, job dibuang tanpa retry", "jobId", job.ID, "runId", in.RunID, "projectId", in.ProjectID)
			return nil
		}
		if ctxErr := ctx.Err(); ctxErr != nil {
			// Konteks job mati sebelum eksekusi. Batal pengguna (run sudah
			// "cancelled" di DB) -> selesai tanpa retry; shutdown -> error
			// supaya job di-retry sesudah restart.
			var cur models.AgentRun
			if db.First(&cur, in.RunID).Error == nil && cur.Status == "cancelled" {
				return nil
			}
			return ctxErr
		}
		err = executeAgentPipeline(ctx, db, in, emit)
		return err
	}
}

// lastAttempt melaporkan apakah percobaan yang sedang berjalan ini adalah
// yang terakhir (attempts sudah termasuk percobaan ini, dinaikkan saat
// claim). Dipakai untuk menandai run gagal + menutup topik SSE supaya
// stream tidak menggantung setelah job kehabisan percobaan.
func lastAttempt(db *gorm.DB, job queue.Job) bool {
	var rec queue.JobRecord
	if err := db.Where("id = ?", job.ID).First(&rec).Error; err != nil {
		return false
	}
	return rec.Attempts >= rec.MaxAttempts
}

// agentQueueCancel membatalkan job agent yang sedang antre/berjalan di
// Manager (bila ada). Dipakai cancelAgentRun bersama cancelAgent (yang
// membatalkan stream pipeline lewat agentCancels). Job yang masih antre:
// Manager menandai snapshot batal; saat worker mengambilnya nanti,
// AgentJobHandler memeriksa baris AgentRun (sudah "cancelled") dan
// melewatinya tanpa eksekusi.
func agentQueueCancel(runID uint) bool {
	mgr, _ := agentQueue()
	if mgr == nil {
		return false
	}
	return mgr.Cancel(agentJobID(runID))
}

// writeAgentBusEvent menulis satu event bus ke HTTP stream SSE dengan
// format yang sama seperti sendAgentSSE (plus baris data-only untuk Raw).
func writeAgentBusEvent(c *gin.Context, ev agentBusEvent) {
	if ev.Raw != "" {
		fmt.Fprintf(c.Writer, "data: %s\n\n", ev.Raw)
	} else {
		fmt.Fprintf(c.Writer, "event: %s\ndata: %s\n\n", ev.Type, ev.Data)
	}
	c.Writer.Flush()
}

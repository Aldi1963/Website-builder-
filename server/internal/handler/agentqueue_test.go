// Tes wiring DBQueue -> handler agent (end-to-end, bukan unit adapter).
//
// Pipeline agent dieksekusi consumer queue dengan AI stub (httptest server
// OpenAI-compatible) dan proyek yang memenuhi kontrak TypeScript, supaya
// satu-satunya kegagalan adalah acceptance (package.json tanpa script
// build -> "Missing script: build") — run berakhir "failed" TETAPI tetap
// terminal, dan itu yang dibuktikan: enqueue -> consumer mengeksekusi ->
// run selesai + job "done" + event SSE mengalir lewat bus.
//
// Catatan: acceptance menjalankan `npm install` + `npm run build` nyata di
// server/internal/runtime/project-<id> (relatif terhadap CWD paket
// handler saat go test). Direktori itu dibersihkan tiap test.
package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"webbuilder/internal/config"
	"webbuilder/internal/database/models"
	"webbuilder/internal/queue"

	"gorm.io/gorm"
)

// openAgentTestDB membuka DB test (reuse openTestDB) + migrasi model yang
// dipakai pipeline agent + tabel queue_jobs.
func openAgentTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	db := openTestDB(t)
	if err := db.AutoMigrate(
		&models.Project{}, &models.ChatSession{}, &models.ChatMessage{},
		&models.ProjectVersion{}, &models.ProjectMigration{},
		&models.AgentRun{}, &models.AgentToolCall{}, &models.AgentContext{},
		&models.AIConfig{}, &models.BlockedWord{},
	); err != nil {
		t.Fatalf("migrate agent: %v", err)
	}
	if err := queue.Migrate(db); err != nil {
		t.Fatalf("migrate queue: %v", err)
	}
	return db
}

func makeAdminUser(t *testing.T, db *gorm.DB, email string) models.User {
	t.Helper()
	u := makeUser(t, db, email, "rahasia123")
	if err := db.Model(&u).Update("is_admin", true).Error; err != nil {
		t.Fatalf("jadikan admin: %v", err)
	}
	return u
}

// contractFiles adalah proyek minimal yang LOLOS validateProjectContract
// (14 file wajib, index.html kecil + module script, >=3 file .ts/.tsx di
// src/, tanpa .js/.jsx) supaya enforceProjectContract tidak memanggil AI.
// package.json SENGAJA tanpa dependensi vite/react: prepareRuntimeWorkspace
// menambahkan script "build": "vite build" tetapi TIDAK menambahkan dep
// vite/react bila package.json sudah ada, jadi acceptance gagal cepat
// dengan "vite: not found" (exit 127, TIDAK repairable -> repair tidak
// terpanggil, stub AI hanya dipanggil sekali untuk stream). Run berakhir
// "failed" yang tetap terminal — itu yang dibuktikan test ini.
func contractFiles() map[string]string {
	return map[string]string{
		"package.json":              "{\"name\":\"uji\",\"private\":true,\"version\":\"0.0.0\",\"type\":\"module\"}",
		"tsconfig.json":             "{\"compilerOptions\":{\"target\":\"ES2020\",\"module\":\"ESNext\",\"jsx\":\"react-jsx\",\"strict\":true}}",
		"vite.config.ts":            "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({ plugins: [react()] });\n",
		"index.html":                "<!doctype html>\n<html><head><meta charset=\"utf-8\"><title>Uji</title></head><body><div id=\"root\"></div><script type=\"module\" src=\"/src/main.tsx\"></script></body></html>",
		"src/main.tsx":              "import React from 'react';\nimport ReactDOM from 'react-dom/client';\nimport App from './App';\nReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);\n",
		"src/App.tsx":               "export default function App() { return <h1>Halo</h1>; }\n",
		"src/index.css":             "body { margin: 0; }\n",
		"src/vite-env.d.ts":         "/// <reference types=\"vite/client\" />\n",
		"src/components/Widget.tsx": "export default function Widget() { return <p>Widget</p>; }\n",
		".env.example":              "VITE_API_BASE_URL=http://localhost:18082\n",
		"README.md":                 "# Uji\n",
		"docs/plan.md":              "# Rencana\n",
		"docs/architecture.md":      "# Arsitektur\n",
		"docs/data-model.md":        "# Data\n",
		"docs/acceptance.md":        "# Acceptance\n",
	}
}

func makeContractProject(t *testing.T, db *gorm.DB, userID uint) models.Project {
	t.Helper()
	fj, _ := json.Marshal(contractFiles())
	p := models.Project{UserID: userID, Name: "Uji Queue", Slug: "uji-" + randHex(6), Files: string(fj)}
	if err := db.Create(&p).Error; err != nil {
		t.Fatalf("create project: %v", err)
	}
	// Runtime pipeline menulis workspace ke server/internal/runtime/project-<id>.
	t.Cleanup(func() { _ = os.RemoveAll(filepath.Join("..", "runtime", fmt.Sprintf("project-%d", p.ID))) })
	return p
}

// newStubAI mengembalikan server OpenAI-compatible: "stream":false -> JSON
// choices[0].message.content tanpa tool_calls; "stream":true -> SSE delta
// + [DONE]. Balasan TIDAK mengandung FILE/BLUEPRINT/MEMORY/SQL block,
// jadi pipeline tidak mengubah file dan langsung ke acceptance.
func newStubAI(t *testing.T) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	calls := &atomic.Int32{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		body, _ := io.ReadAll(r.Body)
		var req struct {
			Stream bool `json:"stream"`
		}
		_ = json.Unmarshal(body, &req)
		const reply = "Proyek sudah diperiksa. Tidak ada perubahan yang diperlukan."
		if req.Stream {
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"content\":%q}}]}\n\n", reply)
			fmt.Fprint(w, "data: [DONE]\n\n")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"choices":[{"message":{"role":"assistant","content":%q}}]}`, reply)
	}))
	t.Cleanup(srv.Close)
	return srv, calls
}

func setStubAIEnv(t *testing.T, srv *httptest.Server) {
	t.Helper()
	t.Setenv("AI_BASE_URL", srv.URL)
	t.Setenv("AI_API_KEY", "test-key")
	t.Setenv("AI_MODEL", "stub-model")
}

// startTestQueue memasang queue DB + 2 consumer; consumer dihentikan saat
// test selesai.
func startTestQueue(t *testing.T, db *gorm.DB) *queue.Manager {
	t.Helper()
	mgr, err := InitAgentQueue(db, config.Config{QueueBackend: "db", QueueWorkers: 2})
	if err != nil {
		t.Fatalf("InitAgentQueue: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	for i := 0; i < 2; i++ {
		go mgr.Run(ctx, AgentJobHandler(db))
	}
	return mgr
}

// enqueueTestJob membangun payload yang sama seperti postChat lalu
// meng-enqueue-nya (idempotency key = ID run).
func enqueueTestJob(t *testing.T, mgr *queue.Manager, run *models.AgentRun, projectID, userID uint, message string) {
	t.Helper()
	payload, _ := json.Marshal(agentPipelineInput{
		RunID: run.ID, ProjectID: projectID, UserID: userID,
		Message: message, Mode: "edit", Intent: "edit",
	})
	if err := mgr.Enqueue(context.Background(), queue.Job{ID: agentJobID(run.ID), Kind: agentJobKind, Payload: payload}); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
}

// waitForRunTerminal menunggu run mencapai terminal state (completed /
// failed / cancelled / waiting_for_confirmation) atau gagal bila timeout.
func waitForRunTerminal(t *testing.T, db *gorm.DB, runID uint, timeout time.Duration) models.AgentRun {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		var run models.AgentRun
		if err := db.First(&run, runID).Error; err == nil {
			switch run.Status {
			case "completed", "failed", "cancelled", "waiting_for_confirmation":
				return run
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatalf("run %d tidak terminal dalam %s", runID, timeout)
	return models.AgentRun{}
}

func jobRecord(t *testing.T, db *gorm.DB, runID uint) queue.JobRecord {
	t.Helper()
	var rec queue.JobRecord
	if err := db.Where("id = ?", agentJobID(runID)).First(&rec).Error; err != nil {
		t.Fatalf("job %s tidak ditemukan: %v", agentJobID(runID), err)
	}
	return rec
}

func hasEvent(events []agentBusEvent, typ string) bool {
	for _, ev := range events {
		if ev.Type == typ {
			return true
		}
	}
	return false
}

// (a) enqueue -> consumer mengeksekusi -> run selesai + job done + event
// SSE (message + result) mengalir lewat bus.
func TestAgentQueueEndToEnd(t *testing.T) {
	db := openAgentTestDB(t)
	srv, calls := newStubAI(t)
	setStubAIEnv(t, srv)
	user := makeAdminUser(t, db, "uji-queue@example.com")
	proj := makeContractProject(t, db, user.ID)
	mgr := startTestQueue(t, db)
	_, bus := agentQueue()
	if bus == nil {
		t.Fatal("bus harus terpasang sesudah InitAgentQueue")
	}

	run := createAgentRun(db, proj.ID, user.ID, "edit", "Perbaiki tampilan dashboard")
	if run == nil {
		t.Fatal("createAgentRun gagal")
	}
	if run.Status != "queued" {
		t.Fatalf("run baru harus berstatus queued, dapat %q", run.Status)
	}
	ch, unsub := bus.Subscribe(run.ID)
	defer unsub()
	var mu sync.Mutex
	var events []agentBusEvent
	collectDone := make(chan struct{})
	go func() {
		defer close(collectDone)
		for ev := range ch {
			mu.Lock()
			events = append(events, ev)
			mu.Unlock()
		}
	}()

	enqueueTestJob(t, mgr, run, proj.ID, user.ID, "Perbaiki tampilan dashboard")
	final := waitForRunTerminal(t, db, run.ID, 120*time.Second)
	t.Logf("run final: status=%q summary=%q error=%q", final.Status, final.Summary, final.Error)
	// Acceptance gagal (tanpa script build) -> run "failed", TETAP terminal.
	if final.Status != "failed" {
		t.Fatalf("harapkan run failed (acceptance tanpa build script), dapat %q: %s", final.Status, final.Error)
	}
	rec := jobRecord(t, db, run.ID)
	if rec.Status != "done" {
		t.Fatalf("harapkan job done, dapat %q (attempts=%d, last_error=%q)", rec.Status, rec.Attempts, rec.LastError)
	}
	if rec.Attempts != 1 {
		t.Fatalf("harapkan job di-claim sekali, attempts=%d", rec.Attempts)
	}
	// Topik bus ditutup sesudah job selesai -> kolektor berhenti.
	select {
	case <-collectDone:
	case <-time.After(10 * time.Second):
		t.Fatal("topik bus tidak ditutup sesudah job selesai")
	}
	mu.Lock()
	defer mu.Unlock()
	if !hasEvent(events, "message") {
		t.Fatalf("bus harus menerima event message, dapat: %+v", events)
	}
	if !hasEvent(events, "result") {
		t.Fatalf("bus harus menerima event result, dapat: %+v", events)
	}
	// Pipeline memanggil stub AI minimal sekali (stream). Jumlah pastinya
	// bergantung pada mode kegagalan acceptance (repair hanya jalan bila
	// diagnostik repairable) — bukan yang dibuktikan test ini.
	if got := calls.Load(); got < 1 {
		t.Fatalf("harapkan >= 1 panggilan AI stub, dapat %d", got)
	}
}

// (b) restart recovery, dua fase pada DB yang sama:
//   - fase 1: job di-enqueue TANPA consumer -> tetap pending; consumer baru
//     mengambilnya sampai selesai.
//   - fase 2: job dibiarkan "running" dengan lease kedaluwarsa (simulasi
//     worker mati sesudah claim) -> consumer baru merebutnya lewat lease
//     takeover dan menyelesaikannya (attempts >= 2).
func TestAgentQueueRestartRecovery(t *testing.T) {
	db := openAgentTestDB(t)
	srv, _ := newStubAI(t)
	setStubAIEnv(t, srv)
	user := makeAdminUser(t, db, "uji-restart@example.com")
	proj := makeContractProject(t, db, user.ID)

	mgr, err := InitAgentQueue(db, config.Config{QueueBackend: "db", QueueWorkers: 2})
	if err != nil {
		t.Fatalf("InitAgentQueue: %v", err)
	}

	// Fase 1: tanpa consumer.
	run1 := createAgentRun(db, proj.ID, user.ID, "edit", "Perbaiki tampilan dashboard")
	enqueueTestJob(t, mgr, run1, proj.ID, user.ID, "Perbaiki tampilan dashboard")
	time.Sleep(500 * time.Millisecond)
	if rec := jobRecord(t, db, run1.ID); rec.Status != "pending" {
		t.Fatalf("fase 1: tanpa consumer job harus tetap pending, dapat %q", rec.Status)
	}
	var r1 models.AgentRun
	if err := db.First(&r1, run1.ID).Error; err != nil || r1.Status != "queued" {
		t.Fatalf("fase 1: run harus tetap queued, dapat %+v / %v", r1, err)
	}
	ctx1, cancel1 := context.WithCancel(context.Background())
	go mgr.Run(ctx1, AgentJobHandler(db))
	go mgr.Run(ctx1, AgentJobHandler(db))
	final1 := waitForRunTerminal(t, db, run1.ID, 120*time.Second)
	if final1.Status != "failed" {
		t.Fatalf("fase 1: harapkan run failed, dapat %q", final1.Status)
	}
	if rec := jobRecord(t, db, run1.ID); rec.Status != "done" {
		t.Fatalf("fase 1: harapkan job done, dapat %q", rec.Status)
	}
	cancel1()
	time.Sleep(200 * time.Millisecond) // beri waktu consumer berhenti

	// Fase 2: worker mati sesudah claim (lease takeover).
	run2 := createAgentRun(db, proj.ID, user.ID, "edit", "Perbaiki tampilan dashboard lagi")
	enqueueTestJob(t, mgr, run2, proj.ID, user.ID, "Perbaiki tampilan dashboard lagi")
	if err := db.Model(&queue.JobRecord{}).Where("id = ?", agentJobID(run2.ID)).Updates(map[string]any{
		"status": "running", "leased_until": time.Now().Add(-time.Minute), "attempts": 1,
	}).Error; err != nil {
		t.Fatalf("simulasi worker mati: %v", err)
	}
	if err := db.Model(&models.AgentRun{}).Where("id = ?", run2.ID).Updates(map[string]any{
		"status": "running", "phase": "generating",
	}).Error; err != nil {
		t.Fatalf("simulasi run berjalan: %v", err)
	}
	ctx2, cancel2 := context.WithCancel(context.Background())
	defer cancel2()
	go mgr.Run(ctx2, AgentJobHandler(db))
	final2 := waitForRunTerminal(t, db, run2.ID, 120*time.Second)
	if final2.Status != "failed" {
		t.Fatalf("fase 2: harapkan run failed, dapat %q", final2.Status)
	}
	rec2 := jobRecord(t, db, run2.ID)
	if rec2.Status != "done" {
		t.Fatalf("fase 2: harapkan job done, dapat %q (attempts=%d)", rec2.Status, rec2.Attempts)
	}
	if rec2.Attempts < 2 {
		t.Fatalf("fase 2: harapkan attempts >= 2 (reclaim + eksekusi ulang), dapat %d", rec2.Attempts)
	}
}

// (c) enqueue ganda dengan idempotency key sama -> dieksekusi sekali.
func TestAgentQueueIdempotentEnqueue(t *testing.T) {
	db := openAgentTestDB(t)
	srv, calls := newStubAI(t)
	setStubAIEnv(t, srv)
	user := makeAdminUser(t, db, "uji-idem@example.com")
	proj := makeContractProject(t, db, user.ID)

	mgr, err := InitAgentQueue(db, config.Config{QueueBackend: "db", QueueWorkers: 2})
	if err != nil {
		t.Fatalf("InitAgentQueue: %v", err)
	}
	run := createAgentRun(db, proj.ID, user.ID, "edit", "Perbaiki tampilan dashboard")
	payload, _ := json.Marshal(agentPipelineInput{
		RunID: run.ID, ProjectID: proj.ID, UserID: user.ID,
		Message: "Perbaiki tampilan dashboard", Mode: "edit", Intent: "edit",
	})
	job := queue.Job{ID: agentJobID(run.ID), Kind: agentJobKind, Payload: payload}
	if err := mgr.Enqueue(context.Background(), job); err != nil {
		t.Fatalf("enqueue pertama: %v", err)
	}
	if err := mgr.Enqueue(context.Background(), job); err != nil {
		t.Fatalf("enqueue kedua (idempotency key sama) harus tetap nil: %v", err)
	}
	var count int64
	if err := db.Model(&queue.JobRecord{}).Count(&count).Error; err != nil || count != 1 {
		t.Fatalf("harapkan tepat 1 baris job, dapat %d (err=%v)", count, err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go mgr.Run(ctx, AgentJobHandler(db))
	final := waitForRunTerminal(t, db, run.ID, 120*time.Second)
	if final.Status != "failed" {
		t.Fatalf("harapkan run failed, dapat %q", final.Status)
	}
	if rec := jobRecord(t, db, run.ID); rec.Attempts != 1 {
		t.Fatalf("harapkan job di-claim sekali (attempts=1), dapat %d", rec.Attempts)
	}
	if got := calls.Load(); got < 1 {
		t.Fatalf("harapkan >= 1 panggilan AI stub (satu eksekusi), dapat %d", got)
	}
}

// InitAgentQueue: backend inprocess eksplisit jalan; backend tak dikenal
// ditolak; db membuat tabel queue_jobs untuk SQLite.
func TestInitAgentQueueBackends(t *testing.T) {
	db := openAgentTestDB(t)
	if _, err := InitAgentQueue(db, config.Config{QueueBackend: "inprocess", QueueWorkers: 1}); err != nil {
		t.Fatalf("inprocess harus diterima: %v", err)
	}
	if _, err := InitAgentQueue(db, config.Config{QueueBackend: "redis", QueueWorkers: 1}); err == nil {
		t.Fatal("backend tak dikenal harus ditolak")
	}
	mgr, err := InitAgentQueue(db, config.Config{QueueBackend: "db", QueueWorkers: 1})
	if err != nil {
		t.Fatalf("db harus diterima: %v", err)
	}
	if mgr == nil {
		t.Fatal("manager tidak boleh nil")
	}
	if !db.Migrator().HasTable(&queue.JobRecord{}) {
		t.Fatal("tabel queue_jobs harus ada sesudah InitAgentQueue db")
	}
}

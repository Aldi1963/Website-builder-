package handler

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"webbuilder/internal/browser"
	"webbuilder/internal/database/models"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

// TestBrowserToolEndToEndRealChrome adalah bukti end-to-end Fase 1 dengan
// Chrome + server MCP asli (bukan palsu), tanpa kunci AI apa pun: jalur
// `execute` yang dipakai pipeline dipanggil langsung (bypass LLM), lalu
// barisnya dicek di agent_tool_calls. Di-skip bila CHROME_FOR_TESTING_PATH
// kosong.
//
// DB SQLite file dipakai (bukan in-memory) supaya bukti bisa dicek dari
// luar sesudah test: set WB_BROWSER_E2E_DB ke path file .db, lalu query
// `sqlite3 <file> "SELECT tool,status FROM agent_tool_calls;"`.
func TestBrowserToolEndToEndRealChrome(t *testing.T) {
	if strings.TrimSpace(os.Getenv(browser.EnvChromePath)) == "" {
		t.Skip("CHROME_FOR_TESTING_PATH kosong — test E2E Chrome dilewati")
	}
	t.Setenv(browser.EnvEnableBrowserTools, "1")
	t.Setenv(browser.EnvEnableTenantExec, "1")

	dbPath := strings.TrimSpace(os.Getenv("WB_BROWSER_E2E_DB"))
	if dbPath == "" {
		dbPath = filepath.Join(t.TempDir(), "webbuilder-e2e.db")
	}
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		t.Fatal(err)
	}
	db, err := gorm.Open(sqlite.Open(dbPath), &gorm.Config{})
	if err != nil {
		t.Fatalf("buka sqlite file: %v", err)
	}
	sqlDB, _ := db.DB()
	t.Cleanup(func() { sqlDB.Close() })
	if err := db.AutoMigrate(&models.Project{}, &models.AgentRun{}, &models.AgentToolCall{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	p := models.Project{UserID: 1, Name: "E2E Browser", Slug: "e2e-browser", Framework: "react", Files: "{}"}
	if err := db.Create(&p).Error; err != nil {
		t.Fatalf("create project: %v", err)
	}
	run := models.AgentRun{ProjectID: p.ID, UserID: 1, Mode: "edit", Status: "running", Phase: "generating", Request: "cek console di Chrome"}
	if err := db.Create(&run).Error; err != nil {
		t.Fatalf("create run: %v", err)
	}

	ctx := context.Background()
	runDir := filepath.Join(t.TempDir(), "run-1")
	bc, err := browser.NewClientForRun(run.ID, runDir)
	if err != nil {
		t.Fatalf("NewClientForRun gagal (fail-closed tidak boleh terjadi di sini): %v", err)
	}
	defer bc.Close()
	if err := bc.Start(ctx); err != nil {
		t.Fatalf("Start browser gagal: %v", err)
	}

	// Persis closure `execute` di executeAgentPipeline.
	name := "browser_list_console_messages"
	input := map[string]interface{}{}
	rj, _ := json.Marshal(input)
	recordAgentTool(db, run.ID, name, "analyzing", "running", string(rj), "Agent meminta tool", "")
	result, toolErr := executeAgentToolWithBrowser(ctx, db, &p, bc, name, input)
	status, detail := "success", "Tool berhasil dijalankan"
	if toolErr != nil {
		status, detail = "failed", toolErr.Error()
	}
	recordAgentTool(db, run.ID, name, "analyzing", status, string(rj), detail, "")
	if toolErr != nil {
		t.Fatalf("panggilan browser_list_console_messages gagal: %v", toolErr)
	}
	t.Logf("hasil browser_list_console_messages: %+v", result)

	var calls []models.AgentToolCall
	if err := db.Where("run_id = ? AND tool = ?", run.ID, name).Order("id ASC").Find(&calls).Error; err != nil {
		t.Fatalf("query agent_tool_calls: %v", err)
	}
	if len(calls) != 2 || calls[1].Status != "success" {
		t.Fatalf("harus ada 2 baris agent_tool_calls dengan status akhir success, dapat %+v", calls)
	}
	t.Logf("bukti: db=%s run_id=%d tool=%s status=%s", dbPath, run.ID, name, calls[1].Status)
}

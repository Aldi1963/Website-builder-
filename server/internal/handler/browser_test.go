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
)

// Server MCP palsu (Python, stdio JSON-RPC minimal) untuk menguji wiring
// pipeline tanpa Chrome asli. Dipakai sebagai command browser.Client:
// "python3 <file>" — file ditulis ke TempDir tiap test.
const fakeMCPServerPython = `
import sys, json
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
    except Exception:
        continue
    if "id" not in req or req.get("id") is None:
        continue
    method = req.get("method", "")
    result = None
    if method == "initialize":
        result = {"protocolVersion": "2025-03-26", "capabilities": {}, "serverInfo": {"name": "fake-chrome-devtools", "version": "0.0.0"}}
    elif method == "ping":
        result = {}
    elif method == "tools/list":
        result = {"tools": [
            {"name": "list_console_messages", "description": "List console messages", "inputSchema": {"type": "object", "properties": {}}},
            {"name": "navigate_page", "description": "Navigate", "inputSchema": {"type": "object", "properties": {"url": {"type": "string"}}}},
            {"name": "take_heapsnapshot", "description": "Heap (bukan allowlist)", "inputSchema": {"type": "object", "properties": {}}},
        ]}
    elif method == "tools/call":
        name = (req.get("params") or {}).get("name", "")
        if name == "list_console_messages":
            result = {"content": [{"type": "text", "text": "[log] hello from fake page\n[error] example error"}]}
        else:
            result = {"content": [{"type": "text", "text": "unknown tool"}], "isError": True}
    else:
        sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": req["id"], "error": {"code": -32601, "message": "method not found"}}) + "\n")
        sys.stdout.flush()
        continue
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": req["id"], "result": result}) + "\n")
    sys.stdout.flush()
`

func fakeBrowserClient(t *testing.T) *browser.Client {
	t.Helper()
	script := filepath.Join(t.TempDir(), "fake_mcp.py")
	if err := os.WriteFile(script, []byte(fakeMCPServerPython), 0o644); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	ws := filepath.Join(dir, "workspace")
	prof := filepath.Join(dir, "chrome-profile")
	if err := os.MkdirAll(ws, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(prof, 0o755); err != nil {
		t.Fatal(err)
	}
	c := browser.NewClient(browser.Config{Command: "python3 " + script, WorkspaceDir: ws, ProfileDir: prof})
	t.Cleanup(func() { _ = c.Close() })
	return c
}

// TestBrowserToolRecordedInAgentToolCalls membuktikan kriteria selesai
// Fase 1 di jalur yang dipakai pipeline: panggilan
// browser_list_console_messages lewat executeAgentToolWithBrowser (closure
// `execute` di executeAgentPipeline) tercatat di agent_tool_calls.
func TestBrowserToolRecordedInAgentToolCalls(t *testing.T) {
	db := openTestDB(t)
	if err := db.AutoMigrate(&models.Project{}, &models.AgentRun{}, &models.AgentToolCall{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	p := models.Project{UserID: 1, Name: "Uji Browser", Slug: "uji-browser", Framework: "react", Files: "{}"}
	if err := db.Create(&p).Error; err != nil {
		t.Fatalf("create project: %v", err)
	}
	run := models.AgentRun{ProjectID: p.ID, UserID: 1, Mode: "edit", Status: "running", Phase: "generating", Request: "cek console"}
	if err := db.Create(&run).Error; err != nil {
		t.Fatalf("create run: %v", err)
	}

	ctx := context.Background()
	bc := fakeBrowserClient(t)
	if err := bc.Start(ctx); err != nil {
		t.Fatalf("Start browser palsu gagal: %v", err)
	}
	// Katalog dinamis Fase 1: hanya satu alat.
	tools, err := bc.ListTools(ctx)
	if err != nil {
		t.Fatalf("ListTools gagal: %v", err)
	}
	catalog := agentToolCatalog()
	catalog = append(catalog, browserToolCatalog(browser.SpecsFromTools(tools))...)
	found := false
	for _, s := range catalog {
		if s.Name == "browser_list_console_messages" {
			found = true
		}
		if s.Name == "browser_navigate_page" || s.Name == "browser_take_heapsnapshot" {
			t.Fatalf("katalog Fase 1 tidak boleh memuat %q", s.Name)
		}
	}
	if !found {
		t.Fatal("katalog harus memuat browser_list_console_messages")
	}

	// Persis seperti closure `execute` di executeAgentPipeline: catat
	// running → eksekusi → catat status akhir.
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
		t.Fatalf("panggilan browser gagal: %v", toolErr)
	}
	out, _ := result.(map[string]interface{})
	if out == nil || !strings.Contains(out["output"].(string), "hello from fake page") {
		t.Fatalf("hasil browser harus memuat pesan console, dapat %+v", result)
	}

	var calls []models.AgentToolCall
	if err := db.Where("run_id = ? AND tool = ?", run.ID, name).Order("id ASC").Find(&calls).Error; err != nil {
		t.Fatalf("query agent_tool_calls: %v", err)
	}
	if len(calls) != 2 {
		t.Fatalf("harus ada 2 baris agent_tool_calls (running + success), dapat %d", len(calls))
	}
	if calls[1].Status != "success" {
		t.Fatalf("baris akhir harus success, dapat %q (%q)", calls[1].Status, calls[1].Error)
	}
}

// TestBrowserToolUnavailableWithoutClient membuktikan fail-closed di
// jalur execute: flag mati / browser gagal start → panggilan browser
// ditolak dengan error jelas, bukan diam-diam; dan executeAgentTool
// langsung menolak nama browser_* (butuh klien per-run pipeline).
func TestBrowserToolUnavailableWithoutClient(t *testing.T) {
	db := openTestDB(t)
	if err := db.AutoMigrate(&models.Project{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	p := models.Project{UserID: 1, Name: "Uji", Slug: "uji", Files: "{}"}
	if err := db.Create(&p).Error; err != nil {
		t.Fatalf("create project: %v", err)
	}
	ctx := context.Background()
	if _, err := executeAgentToolWithBrowser(ctx, db, &p, nil, "browser_list_console_messages", nil); err == nil {
		t.Fatal("tanpa browser client, panggilan browser harus error")
	} else if !strings.Contains(err.Error(), "tidak tersedia") {
		t.Fatalf("error harus jelas menyebut tidak tersedia, dapat: %v", err)
	}
	if _, err := executeAgentTool(db, &p, "browser_list_console_messages", nil); err == nil {
		t.Fatal("executeAgentTool langsung harus menolak nama browser_*")
	}
}

// TestServerPortFollowsPORTEnv membuktikan perbaikan terkait Fase 1:
// target proxy /api di vite.config mengikuti PORT env, bukan hardcode.
func TestServerPortFollowsPORTEnv(t *testing.T) {
	t.Setenv("PORT", "18099")
	if got := serverPort(); got != "18099" {
		t.Fatalf("serverPort harus mengikuti PORT env, dapat %q", got)
	}
	t.Setenv("PORT", "")
	if got := serverPort(); got != "18082" {
		t.Fatalf("PORT kosong harus default 18082, dapat %q", got)
	}
}

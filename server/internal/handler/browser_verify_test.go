package handler

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"webbuilder/internal/database/models"

	"gorm.io/gorm"
)

// Test loop verifikasi Fase 2 (runBrowserVerificationLoop) lewat server
// MCP palsu — tanpa Chrome dan tanpa kunci AI. Port memilih kasus di
// server palsu: 18091 = halaman baik, 18092 = halaman rusak.

func setupVerifyLoopTest(t *testing.T) (*gorm.DB, *models.Project, *models.AgentRun, context.Context) {
	t.Helper()
	db := openTestDB(t)
	if err := db.AutoMigrate(&models.Project{}, &models.AgentRun{}, &models.AgentToolCall{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	p := models.Project{UserID: 1, Name: "Uji Verifikasi", Slug: "uji-verifikasi", Framework: "react", Files: "{}"}
	if err := db.Create(&p).Error; err != nil {
		t.Fatalf("create project: %v", err)
	}
	run := models.AgentRun{ProjectID: p.ID, UserID: 1, Mode: "edit", Status: "running", Phase: "generating", Request: "verifikasi preview"}
	if err := db.Create(&run).Error; err != nil {
		t.Fatalf("create run: %v", err)
	}
	return db, &p, &run, context.Background()
}

func TestBrowserVerificationLoopHappy(t *testing.T) {
	db, _, run, ctx := setupVerifyLoopTest(t)
	bc := fakeBrowserClient(t)
	if err := bc.Start(ctx); err != nil {
		t.Fatalf("Start browser palsu gagal: %v", err)
	}
	runDir := filepath.Join(t.TempDir(), fmt.Sprintf("run-%d", run.ID))
	if err := os.MkdirAll(runDir, 0o755); err != nil {
		t.Fatal(err)
	}
	events := []string{}
	send := func(event string, payload any) { events = append(events, event) }
	repair := func(diag string) ([]string, error) {
		t.Fatal("halaman baik tidak boleh memicu perbaikan")
		return nil, nil
	}
	reaccept := func() (map[string]interface{}, int, error) {
		t.Fatal("halaman baik tidak boleh memicu acceptance ulang")
		return nil, 0, nil
	}
	outcome, repaired, _, accErr := runBrowserVerificationLoop(ctx, db, run.ID, runDir, bc, 18091, repair, reaccept, send)
	if accErr != nil {
		t.Fatalf("loop halaman baik tidak boleh mengembalikan error acceptance: %v", accErr)
	}
	if len(repaired) != 0 {
		t.Fatalf("halaman baik tidak boleh ada file diperbaiki, dapat %+v", repaired)
	}
	if !outcome.Attempted || !outcome.Passed || outcome.Rounds != 1 {
		t.Fatalf("halaman baik harus lolos di putaran 1, dapat %+v", outcome)
	}
	if outcome.ScreenshotPath != filepath.Join(runDir, "screenshot-1.png") {
		t.Fatalf("screenshot harus di runtime/<run-id>/screenshot-1.png, dapat %q", outcome.ScreenshotPath)
	}
	if data, err := os.ReadFile(outcome.ScreenshotPath); err != nil || len(data) < 8 || string(data[:8]) != "\x89PNG\r\n\x1a\n" {
		t.Fatalf("screenshot-1.png harus file PNG, err=%v", err)
	}
	var calls []models.AgentToolCall
	db.Where("run_id = ? AND tool = ?", run.ID, "browser_verify").Order("id ASC").Find(&calls)
	if len(calls) != 1 || calls[0].Status != "success" {
		t.Fatalf("harus 1 baris browser_verify success, dapat %+v", calls)
	}
	if !strings.Contains(calls[0].Output, "0 console error") {
		t.Fatalf("catatan verifikasi harus menyebut 0 console error, dapat %q", calls[0].Output)
	}
	found := false
	for _, e := range events {
		if e == "browser_verify" {
			found = true
		}
	}
	if !found {
		t.Fatal("event SSE browser_verify harus dikirim")
	}
}

func TestBrowserVerificationLoopErrorReportsAndCapsRounds(t *testing.T) {
	db, _, run, ctx := setupVerifyLoopTest(t)
	bc := fakeBrowserClient(t)
	if err := bc.Start(ctx); err != nil {
		t.Fatalf("Start browser palsu gagal: %v", err)
	}
	runDir := filepath.Join(t.TempDir(), fmt.Sprintf("run-%d", run.ID))
	if err := os.MkdirAll(runDir, 0o755); err != nil {
		t.Fatal(err)
	}
	repairCalls := 0
	repair := func(diag string) ([]string, error) {
		repairCalls++
		if !strings.Contains(diag, "ERR-PALSU: undefined is not a function di render") {
			t.Fatalf("diagnostik perbaikan harus memuat isi console error asli, dapat:\n%s", diag)
		}
		if !strings.Contains(diag, "tidak-ada-palsu.json [404]") {
			t.Fatalf("diagnostik perbaikan harus memuat request gagal, dapat:\n%s", diag)
		}
		return []string{"src/App.tsx"}, nil
	}
	reacceptCalls := 0
	reaccept := func() (map[string]interface{}, int, error) {
		reacceptCalls++
		return map[string]interface{}{"port": float64(18092)}, 18092, nil
	}
	send := func(event string, payload any) {}
	outcome, repaired, _, accErr := runBrowserVerificationLoop(ctx, db, run.ID, runDir, bc, 18092, repair, reaccept, send)
	if accErr != nil {
		t.Fatalf("loop tidak boleh mengembalikan error acceptance: %v", accErr)
	}
	if outcome.Passed {
		t.Fatal("halaman rusak harus TIDAK lolos")
	}
	// Batas 2 putaran ditegakkan di KODE: perbaikan hanya boleh
	// dipanggil sekali (sesudah putaran 1), lalu putaran 2 gagal dan
	// loop berhenti — tidak ada putaran ke-3.
	if outcome.Rounds != MaxBrowserVerifyRounds {
		t.Fatalf("loop harus berhenti tepat di putaran %d, dapat %d", MaxBrowserVerifyRounds, outcome.Rounds)
	}
	if repairCalls != 1 {
		t.Fatalf("perbaikan harus dipanggil tepat 1x, dapat %d", repairCalls)
	}
	if reacceptCalls != 1 {
		t.Fatalf("acceptance ulang harus dipanggil tepat 1x, dapat %d", reacceptCalls)
	}
	if len(repaired) != 1 || repaired[0] != "src/App.tsx" {
		t.Fatalf("file perbaikan harus diteruskan ke caller, dapat %+v", repaired)
	}
	for _, n := range []string{"screenshot-1.png", "screenshot-2.png"} {
		if _, err := os.Stat(filepath.Join(runDir, n)); err != nil {
			t.Fatalf("screenshot tiap putaran harus tersimpan (%s): %v", n, err)
		}
	}
	var calls []models.AgentToolCall
	db.Where("run_id = ? AND tool = ?", run.ID, "browser_verify").Order("id ASC").Find(&calls)
	if len(calls) != 2 {
		t.Fatalf("harus 2 baris browser_verify (satu per putaran), dapat %d", len(calls))
	}
	joined := calls[0].Output + "\n" + calls[1].Output
	if !strings.Contains(joined, "ERR-PALSU: undefined is not a function di render") {
		t.Fatalf("agent_tool_calls harus mencatat isi console error yang benar, dapat:\n%s", joined)
	}
	if !strings.Contains(joined, "tidak-ada-palsu.json [404]") {
		t.Fatalf("agent_tool_calls harus mencatat request gagal, dapat:\n%s", joined)
	}
	if !strings.Contains(joined, "screenshot-2.png") {
		t.Fatalf("agent_tool_calls harus mencatat path screenshot putaran 2, dapat:\n%s", joined)
	}
	var fixes []models.AgentToolCall
	db.Where("run_id = ? AND tool = ?", run.ID, "auto_fix").Order("id ASC").Find(&fixes)
	if len(fixes) != 2 || fixes[1].Status != "success" {
		t.Fatalf("auto_fix verifikasi harus tercatat running+success, dapat %+v", fixes)
	}
}

func TestBrowserVerificationLoopRepairUnavailable(t *testing.T) {
	db, _, run, ctx := setupVerifyLoopTest(t)
	bc := fakeBrowserClient(t)
	if err := bc.Start(ctx); err != nil {
		t.Fatalf("Start browser palsu gagal: %v", err)
	}
	runDir := filepath.Join(t.TempDir(), fmt.Sprintf("run-%d", run.ID))
	if err := os.MkdirAll(runDir, 0o755); err != nil {
		t.Fatal(err)
	}
	send := func(event string, payload any) {}
	// repair nil = tanpa provider AI: loop berhenti sesudah putaran 1
	// dan melaporkan temuan, bukan mengulang tanpa perbaikan.
	outcome, _, _, _ := runBrowserVerificationLoop(ctx, db, run.ID, runDir, bc, 18092, nil,
		func() (map[string]interface{}, int, error) {
			t.Fatal("tanpa perbaikan tidak boleh ada acceptance ulang")
			return nil, 0, nil
		}, send)
	if outcome.Passed || outcome.Rounds != 1 {
		t.Fatalf("tanpa perbaikan loop harus berhenti di putaran 1 dengan gagal, dapat %+v", outcome)
	}
	if len(outcome.ConsoleErrors) == 0 || !strings.Contains(outcome.ConsoleErrors[0], "ERR-PALSU") {
		t.Fatalf("temuan harus tetap dilaporkan, dapat %+v", outcome.ConsoleErrors)
	}
}

func TestAcceptancePort(t *testing.T) {
	if p, ok := acceptancePort(map[string]interface{}{"port": float64(18091)}); !ok || p != 18091 {
		t.Fatalf("port 18091 harus terbaca, dapat %d ok=%v", p, ok)
	}
	if _, ok := acceptancePort(map[string]interface{}{}); ok {
		t.Fatal("acceptance tanpa port harus tidak ok")
	}
	if _, ok := acceptancePort(nil); ok {
		t.Fatal("acceptance nil harus tidak ok")
	}
	if _, ok := acceptancePort(map[string]interface{}{"port": float64(0)}); ok {
		t.Fatal("port 0 harus tidak ok")
	}
}

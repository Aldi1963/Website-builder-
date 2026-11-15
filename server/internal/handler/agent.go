package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"webbuilder/internal/database/models"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

var agentCancels = struct {
	sync.Mutex
	items map[uint]func()
}{items: map[uint]func(){}}

func registerAgentCancel(runID uint, cancel func()) {
	if runID == 0 {
		return
	}
	agentCancels.Lock()
	agentCancels.items[runID] = cancel
	agentCancels.Unlock()
}
func unregisterAgentCancel(runID uint) {
	agentCancels.Lock()
	delete(agentCancels.items, runID)
	agentCancels.Unlock()
}
func cancelAgent(runID uint) bool {
	agentCancels.Lock()
	cancel, ok := agentCancels.items[runID]
	agentCancels.Unlock()
	if ok {
		cancel()
	}
	return ok
}

// AgentToolSpec mendefinisikan tool internal yang dapat dipanggil agent.
type AgentToolSpec struct {
	Name        string                 `json:"name"`
	Description string                 `json:"description"`
	InputSchema map[string]interface{} `json:"inputSchema"`
}

// Setiap tool WAJIB membawa `properties` lengkap. Tanpa itu model tidak tahu
// nama argumen dan mengirim tool_calls dengan arguments "{}" — inilah penyebab
// file tidak pernah tertulis walau tool-nya "berhasil dipanggil".
var agentToolSpecs = []AgentToolSpec{
	{Name: "inspect_project", Description: "Membaca ringkasan project, file, schema, dan diagnostics terbaru.", InputSchema: map[string]interface{}{"type": "object", "properties": map[string]interface{}{}}},
	{Name: "list_files", Description: "Mendaftar file project yang tersedia.", InputSchema: map[string]interface{}{"type": "object", "properties": map[string]interface{}{}}},
	{Name: "read_file", Description: "Membaca satu file project secara bounded.", InputSchema: map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"path": map[string]interface{}{"type": "string", "description": "Path relatif file, mis. src/App.tsx"},
		},
		"required": []string{"path"},
	}},
	{Name: "search_files", Description: "Mencari teks di file project.", InputSchema: map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"query": map[string]interface{}{"type": "string", "description": "Teks yang dicari"},
		},
		"required": []string{"query"},
	}},
	{Name: "write_file", Description: "Menulis satu file project (buat baru atau timpa) dengan konten lengkap.", InputSchema: map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"path":    map[string]interface{}{"type": "string", "description": "Path relatif file, mis. src/App.tsx"},
			"content": map[string]interface{}{"type": "string", "description": "Isi file lengkap"},
		},
		"required": []string{"path", "content"},
	}},
	{Name: "apply_patch", Description: "Mengganti satu blok teks unik pada file project.", InputSchema: map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"path": map[string]interface{}{"type": "string", "description": "Path relatif file"},
			"old":  map[string]interface{}{"type": "string", "description": "Blok teks lama yang unik"},
			"new":  map[string]interface{}{"type": "string", "description": "Teks pengganti"},
		},
		"required": []string{"path", "old", "new"},
	}},
	{Name: "run_build", Description: "Menjalankan npm run build pada workspace project secara bounded.", InputSchema: map[string]interface{}{"type": "object", "properties": map[string]interface{}{}}},
}

func agentToolCatalog() []AgentToolSpec { return agentToolSpecs }

// argString mengambil argumen pertama yang ada dan tidak kosong dari beberapa
// alias nama. Model berbeda memakai nama kunci berbeda (path/file/filename),
// jadi menerima alias jauh lebih tahan lama daripada satu nama kaku.
func argString(input map[string]interface{}, keys ...string) string {
	for _, k := range keys {
		v, ok := input[k]
		if !ok {
			continue
		}
		if s, ok := v.(string); ok && strings.TrimSpace(s) != "" {
			return s
		}
	}
	return ""
}

// normalizeAgentPath menormalkan path dari model: buang spasi, ubah backslash
// menjadi slash, buang leading "/" dan "./", lalu Clean. Path dengan ".." di
// tengah (mis. src/../x) tetap diterima; yang ditolak hanya yang keluar root.
func normalizeAgentPath(raw string) (string, error) {
	p := strings.TrimSpace(raw)
	if p == "" {
		return "", fmt.Errorf("path tidak valid: kosong")
	}
	p = strings.ReplaceAll(p, "\\", "/")
	p = strings.TrimPrefix(p, "/")
	p = strings.TrimPrefix(p, "./")
	p = path.Clean(p)
	if p == "." || p == ".." || strings.HasPrefix(p, "../") || strings.ContainsRune(p, '\x00') {
		return "", fmt.Errorf("path tidak valid: %s", raw)
	}
	return p, nil
}

func validateAgentPath(raw string) error {
	_, err := normalizeAgentPath(raw)
	return err
}

func executeAgentTool(db *gorm.DB, p *models.Project, name string, input map[string]interface{}) (interface{}, error) {
	var files map[string]string
	if err := json.Unmarshal([]byte(p.Files), &files); err != nil {
		return nil, err
	}
	if files == nil {
		files = map[string]string{}
	}
	switch name {
	case "list_files":
		paths := make([]string, 0, len(files))
		for path := range files {
			paths = append(paths, path)
		}
		return map[string]interface{}{"files": paths, "count": len(paths)}, nil
	case "read_file":
		path, perr := normalizeAgentPath(argString(input, "path", "file", "filename"))
		if perr != nil {
			return nil, perr
		}
		content, ok := files[path]
		if !ok {
			return nil, fmt.Errorf("file tidak ditemukan: %s", path)
		}
		if len(content) > 12000 {
			content = content[:12000] + "...(dipotong)"
		}
		return map[string]interface{}{"path": path, "content": content}, nil
	case "search_files":
		query, _ := input["query"].(string)
		if query == "" {
			return nil, fmt.Errorf("query kosong")
		}
		out := []map[string]interface{}{}
		q := strings.ToLower(query)
		for path, content := range files {
			if strings.Contains(strings.ToLower(path), q) || strings.Contains(strings.ToLower(content), q) {
				out = append(out, map[string]interface{}{"path": path, "match": true})
			}
		}
		return map[string]interface{}{"query": query, "matches": out}, nil
	case "write_file":
		raw := argString(input, "path", "file", "filename", "name")
		content := argString(input, "content", "text", "code", "body")
		path, perr := normalizeAgentPath(raw)
		if perr != nil {
			return nil, perr
		}
		if len(content) > 200000 {
			return nil, fmt.Errorf("content terlalu besar")
		}
		files[path] = content
		encoded, _ := json.Marshal(files)
		if err := db.Model(p).Update("files", string(encoded)).Error; err != nil {
			return nil, err
		}
		return map[string]interface{}{"path": path, "written": true, "bytes": len(content)}, nil
	case "apply_patch":
		old := argString(input, "old", "old_string", "oldString", "find", "search")
		replacement := argString(input, "new", "new_string", "newString", "replace", "replacement")
		path, perr := normalizeAgentPath(argString(input, "path", "file", "filename"))
		if perr != nil {
			return nil, perr
		}
		content, ok := files[path]
		if !ok {
			return nil, fmt.Errorf("file tidak ditemukan: %s", path)
		}
		if old == "" || !strings.Contains(content, old) {
			return nil, fmt.Errorf("blok patch tidak ditemukan")
		}
		if strings.Count(content, old) != 1 {
			return nil, fmt.Errorf("blok patch tidak unik")
		}
		files[path] = strings.Replace(content, old, replacement, 1)
		encoded, _ := json.Marshal(files)
		if err := db.Model(p).Update("files", string(encoded)).Error; err != nil {
			return nil, err
		}
		return map[string]interface{}{"path": path, "patched": true}, nil
	case "run_build":
		// Jangan pakai path absolut mesin lain: hitung dari CWD proses server.
		dir, aerr := filepath.Abs(projectRuntimeRoot(p.ID))
		if aerr != nil {
			return nil, aerr
		}
		if _, serr := os.Stat(dir); serr != nil {
			return map[string]interface{}{"output": "workspace runtime belum ada: " + dir, "success": false}, serr
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		cmd := exec.CommandContext(ctx, "npm", "run", "build")
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "CI=1", "npm_config_legacy_peer_deps=true")
		out, err := cmd.CombinedOutput()
		if len(out) > 12000 {
			out = out[len(out)-12000:]
		}
		return map[string]interface{}{"output": string(out), "success": err == nil, "dir": dir}, err
	case "inspect_project":
		paths := make([]string, 0, len(files))
		for path := range files {
			paths = append(paths, path)
		}
		var tables []string
		if sqlDB, err := getAppSQLDB(); err == nil {
			_ = ensureSchema(fmt.Sprint(p.ID))
			rows, err := sqlDB.Query("SELECT table_name FROM information_schema.tables WHERE table_schema=$1 ORDER BY table_name", appSchema(fmt.Sprint(p.ID)))
			if err == nil {
				defer rows.Close()
				for rows.Next() {
					var t string
					if rows.Scan(&t) == nil {
						tables = append(tables, t)
					}
				}
			}
		}
		return map[string]interface{}{"projectId": p.ID, "name": p.Name, "framework": p.Framework, "fileCount": len(paths), "files": paths, "tables": tables, "blueprint": p.Blueprint, "memory": p.Memory}, nil
	default:
		return nil, fmt.Errorf("tool tidak dikenal: %s", name)
	}
}

// createAgentRun membuat baris AgentRun dalam status "queued": run belum
// dieksekusi — eksekusi dilakukan consumer queue sesudah postChat
// meng-enqueue job. Pipeline yang mengambil job memanggil
// updateAgentPhase("analyzing") yang mengubah status menjadi "running".
func createAgentRun(db *gorm.DB, projectID, userID uint, mode, request string) *models.AgentRun {
	run := &models.AgentRun{ProjectID: projectID, UserID: userID, Mode: mode, Status: "queued", Phase: "queued", Request: request, StartedAt: time.Now()}
	if err := db.Create(run).Error; err != nil {
		return nil
	}
	return run
}

func updateAgentPhase(db *gorm.DB, runID uint, phase string) {
	if runID == 0 {
		return
	}
	var run models.AgentRun
	if db.First(&run, runID).Error != nil {
		return
	}
	if run.Status == "completed" || run.Status == "failed" || run.Status == "cancelled" {
		return
	}
	db.Model(&run).Updates(map[string]interface{}{"phase": phase, "status": "running"})
}

func updateAgentOutput(db *gorm.DB, runID uint, phase, output string) {
	if runID == 0 {
		return
	}
	if len(output) > 12000 {
		output = output[len(output)-12000:]
	}
	db.Model(&models.AgentRun{}).Where("id = ?", runID).Updates(map[string]interface{}{"phase": phase, "current_output": output})
}

func classifyAgentError(err string) string {
	e := strings.ToLower(err)
	switch {
	case strings.Contains(e, "quota"):
		return "quota"
	case strings.Contains(e, "unauthorized") || strings.Contains(e, "401"):
		return "provider_auth"
	case strings.Contains(e, "timeout"):
		return "timeout"
	case strings.Contains(e, "build"):
		return "build"
	case strings.Contains(e, "database") || strings.Contains(e, "sql"):
		return "database"
	case strings.Contains(e, "runtime") || strings.Contains(e, "port"):
		return "runtime"
	case strings.Contains(e, "cancel"):
		return "cancelled"
	default:
		return "provider_or_pipeline"
	}
}
func finishAgentRun(db *gorm.DB, runID uint, status, summary, failure string) {
	if runID == 0 {
		return
	}
	now := time.Now()
	updates := map[string]interface{}{"status": status, "phase": status, "summary": summary, "error": failure, "finished_at": now}
	if failure != "" {
		updates["error_code"] = classifyAgentError(failure)
	}
	db.Model(&models.AgentRun{}).Where("id = ?", runID).Updates(updates)
}

// finishAgentRunIfActive sama seperti finishAgentRun, tetapi hanya
// menyelesaikan bila run BELUM mencapai status terminal. Dipakai pipeline
// queue: tanpa guard ini, pipeline yang dibatalkan (atau gagal lewat
// orphan recovery) bisa menimpa "cancelled"/"failed" menjadi "completed".
// status terminal: completed, failed, cancelled.
func finishAgentRunIfActive(db *gorm.DB, runID uint, status, summary, failure string) {
	if runID == 0 {
		return
	}
	var run models.AgentRun
	if err := db.First(&run, runID).Error; err != nil {
		return
	}
	if run.Status == "completed" || run.Status == "failed" || run.Status == "cancelled" {
		return
	}
	finishAgentRun(db, runID, status, summary, failure)
}

func recordAgentTool(db *gorm.DB, runID uint, tool, phase, status, input, output, failure string) {
	if runID == 0 {
		return
	}
	// Inputs/outputs are diagnostics, never secrets. Keep records bounded.
	if len(input) > 4000 {
		input = input[:4000]
	}
	if len(output) > 8000 {
		output = output[:8000]
	}
	if len(failure) > 2000 {
		failure = failure[:2000]
	}
	db.Create(&models.AgentToolCall{RunID: runID, Tool: tool, Phase: phase, Status: status, Input: input, Output: output, Error: failure})
}

func listAgentRuns(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, _, ok := requireProject(db, c, "viewer")
		if !ok {
			return
		}
		var runs []models.AgentRun
		db.Where("project_id = ?", p.ID).Order("id DESC").Limit(30).Find(&runs)
		// Recover orphaned runs left by a dropped provider stream or process restart.
		// A live run is normally bounded by the provider timeout; anything older
		// than 10 minutes without a terminal state must not lock the composer forever.
		staleBefore := time.Now().Add(-10 * time.Minute)
		for i := range runs {
			if (runs[i].Status == "running" || runs[i].Status == "queued") && runs[i].StartedAt.Before(staleBefore) {
				now := time.Now()
				db.Model(&runs[i]).Updates(map[string]interface{}{
					"status":      "failed",
					"phase":       "failed",
					"summary":     "Proses berhenti karena tidak merespons",
					"error":       "agent run timeout/orphan recovery",
					"finished_at": now,
				})
				runs[i].Status = "failed"
				runs[i].Phase = "failed"
				runs[i].Summary = "Proses berhenti karena tidak merespons"
				runs[i].Error = "agent run timeout/orphan recovery"
				runs[i].FinishedAt = &now
			}
		}
		c.JSON(http.StatusOK, gin.H{"runs": runs})
	}
}

func updateAgentRun(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, role, ok := requireProject(db, c, "editor")
		if !ok || role == "viewer" {
			return
		}
		var req struct {
			Phase  string `json:"phase"`
			Status string `json:"status"`
			Error  string `json:"error"`
		}
		if c.ShouldBindJSON(&req) != nil || strings.TrimSpace(req.Phase) == "" {
			c.JSON(400, gin.H{"message": "Phase wajib diisi"})
			return
		}
		var run models.AgentRun
		if err := db.Where("id = ? AND project_id = ?", c.Param("runId"), p.ID).First(&run).Error; err != nil {
			c.JSON(404, gin.H{"message": "Run tidak ditemukan"})
			return
		}
		status := strings.TrimSpace(req.Status)
		if status == "" {
			status = "running"
		}
		allowed := map[string]bool{"running": true, "completed": true, "failed": true, "cancelled": true}
		if !allowed[status] || (run.Status == "completed" || run.Status == "failed" || run.Status == "cancelled") {
			c.JSON(409, gin.H{"message": "Transisi AgentRun tidak valid"})
			return
		}
		updates := map[string]interface{}{"phase": req.Phase, "status": status, "error": req.Error}
		if status == "completed" || status == "failed" {
			now := time.Now()
			updates["finished_at"] = now
		}
		db.Model(&run).Updates(updates)
		db.First(&run, run.ID)
		c.JSON(http.StatusOK, gin.H{"success": true, "run": run})
	}
}

func getAgentRun(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, _, ok := requireProject(db, c, "viewer")
		if !ok {
			return
		}
		var run models.AgentRun
		if err := db.Where("id = ? AND project_id = ?", c.Param("runId"), p.ID).First(&run).Error; err != nil {
			c.JSON(404, gin.H{"message": "Run tidak ditemukan"})
			return
		}
		var calls []models.AgentToolCall
		db.Where("run_id = ?", run.ID).Order("id ASC").Find(&calls)
		c.JSON(http.StatusOK, gin.H{"run": run, "tools": calls})
	}
}

func saveAgentPlan(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, role, ok := requireProject(db, c, "editor")
		if !ok || role == "viewer" {
			return
		}
		var req struct {
			Plan string `json:"plan"`
		}
		if c.ShouldBindJSON(&req) != nil || strings.TrimSpace(req.Plan) == "" {
			c.JSON(400, gin.H{"message": "Plan wajib diisi"})
			return
		}
		var payload interface{}
		if json.Unmarshal([]byte(req.Plan), &payload) != nil {
			payload = map[string]string{"text": req.Plan}
		}
		b, _ := json.Marshal(payload)
		db.Model(&p).Update("blueprint", string(b))
		c.JSON(200, gin.H{"success": true, "blueprint": string(b)})
	}
}

func cancelAgentRun(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, role, ok := requireProject(db, c, "editor")
		if !ok || role == "viewer" {
			return
		}
		var run models.AgentRun
		if err := db.Where("id = ? AND project_id = ?", c.Param("runId"), p.ID).First(&run).Error; err != nil {
			c.JSON(404, gin.H{"message": "Run tidak ditemukan"})
			return
		}
		if run.Status == "completed" || run.Status == "failed" || run.Status == "cancelled" {
			c.JSON(200, gin.H{"success": true, "status": run.Status})
			return
		}
		cancelAgent(run.ID)
		// Job yang masih antre di queue: batalkan juga di Manager. Manager
		// hanya menandai snapshot batal (tidak menghapus baris DB) — celah
		// itu ditutup handler job: run yang sudah "cancelled" di DB
		// dilewati tanpa eksekusi (lihat executeAgentPipeline).
		agentQueueCancel(run.ID)
		now := time.Now()
		db.Model(&run).Updates(map[string]interface{}{"status": "cancelled", "phase": "cancelled", "summary": "Proses dihentikan pengguna", "error": "cancelled by user", "finished_at": now})
		recordAgentTool(db, run.ID, "agent_cancel", run.Phase, "cancelled", "user request", "Proses dihentikan", "")
		c.JSON(200, gin.H{"success": true, "status": "cancelled"})
	}
}

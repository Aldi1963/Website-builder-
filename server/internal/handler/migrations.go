package handler

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"webbuilder/internal/database/models"
)

func migrationStatements(sqlText string) []string {
	var out []string
	var b strings.Builder
	var quote rune
	for _, r := range sqlText {
		if quote != 0 {
			b.WriteRune(r)
			if r == quote {
				quote = 0
			}
			continue
		}
		if r == '\'' || r == '"' || r == '`' {
			quote = r
			b.WriteRune(r)
			continue
		}
		if r == ';' {
			if s := strings.TrimSpace(b.String()); s != "" {
				out = append(out, s)
			}
			b.Reset()
			continue
		}
		b.WriteRune(r)
	}
	if s := strings.TrimSpace(b.String()); s != "" {
		out = append(out, s)
	}
	return out
}

func migrationAllowed(sqlText string, rollback bool) bool {
	upper := strings.ToUpper(strings.TrimSpace(sqlText))
	if upper == "" {
		return false
	}
	allowed := []string{"CREATE TABLE", "ALTER TABLE", "CREATE INDEX", "CREATE UNIQUE INDEX", "DROP TABLE", "DROP INDEX"}
	if rollback {
		allowed = []string{"DROP TABLE", "DROP INDEX", "ALTER TABLE"}
	}
	for _, prefix := range allowed {
		if strings.HasPrefix(upper, prefix) {
			return true
		}
	}
	return false
}

func runMigrationSQL(ctx context.Context, pid string, sqlText string, rollback bool) ([]string, error) {
	if err := ensureSchema(pid); err != nil {
		return nil, err
	}
	sqldb, err := getAppSQLDB()
	if err != nil {
		return nil, err
	}
	tx, err := sqldb.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, fmt.Sprintf("SET LOCAL search_path TO %s", appSchema(pid))); err != nil {
		return nil, err
	}
	statements := migrationStatements(sqlText)
	if len(statements) == 0 {
		return nil, fmt.Errorf("migration SQL kosong")
	}
	for _, stmt := range statements {
		if !migrationAllowed(stmt, rollback) {
			return nil, fmt.Errorf("statement tidak diizinkan: %s", stmt)
		}
		if _, err = tx.ExecContext(ctx, stmt); err != nil {
			return nil, err
		}
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return statements, nil
}

func listMigrations(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		if _, _, ok := requireProject(db, c, "viewer"); !ok {
			return
		}
		var rows []models.ProjectMigration
		db.Where("project_id = ?", c.Param("id")).Order("id DESC").Find(&rows)
		c.JSON(200, gin.H{"migrations": rows})
	}
}

func applyMigration(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, _, ok := requireProject(db, c, "editor")
		if !ok {
			return
		}
		var req struct {
			Name    string `json:"name"`
			UpSQL   string `json:"upSql" binding:"required"`
			DownSQL string `json:"downSql"`
		}
		if err := c.ShouldBindJSON(&req); err != nil || strings.TrimSpace(req.UpSQL) == "" {
			c.JSON(400, gin.H{"error": "upSql wajib"})
			return
		}
		// Idempotency: retries from the AI pipeline must not apply the same
		// migration twice. The stable name is scoped to the project.
		var existing models.ProjectMigration
		if err := db.Where("project_id = ? AND name = ? AND status = ?", p.ID, req.Name, "applied").First(&existing).Error; err == nil {
			c.JSON(200, gin.H{"status": "applied", "idempotent": true, "steps": migrationStatements(existing.UpSQL), "migration": existing})
			return
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
		defer cancel()
		steps, err := runMigrationSQL(ctx, fmt.Sprint(p.ID), req.UpSQL, false)
		status := "applied"
		if err != nil {
			status = "failed"
		}
		row := models.ProjectMigration{ProjectID: p.ID, Name: req.Name, UpSQL: req.UpSQL, DownSQL: req.DownSQL, Status: status, Error: errorString(err)}
		if err == nil {
			now := time.Now()
			row.AppliedAt = &now
		}
		db.Create(&row)
		if err != nil {
			c.JSON(200, gin.H{"status": "failed", "error": err.Error(), "migration": row})
			return
		}
		c.JSON(200, gin.H{"status": "applied", "steps": steps, "migration": row})
	}
}

func rollbackMigration(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, _, ok := requireProject(db, c, "editor")
		if !ok {
			return
		}
		var row models.ProjectMigration
		if err := db.Where("id = ? AND project_id = ?", c.Param("mid"), p.ID).First(&row).Error; err != nil {
			c.JSON(404, gin.H{"error": "migration tidak ditemukan"})
			return
		}
		if row.Status != "applied" || strings.TrimSpace(row.DownSQL) == "" {
			c.JSON(409, gin.H{"error": "migration tidak punya downSql atau belum applied"})
			return
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
		defer cancel()
		steps, err := runMigrationSQL(ctx, fmt.Sprint(p.ID), row.DownSQL, true)
		if err != nil {
			c.JSON(200, gin.H{"status": "failed", "error": err.Error()})
			return
		}
		now := time.Now()
		db.Model(&row).Updates(map[string]interface{}{"status": "rolled_back", "rolled_back_at": now})
		c.JSON(200, gin.H{"status": "rolled_back", "steps": steps})
	}
}

package handler

import (
	"database/sql"
	"fmt"
	"log"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"github.com/gin-gonic/gin"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

var tableNameRe = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*$`)

func validTableName(n string) bool { return tableNameRe.MatchString(n) && len(n) <= 50 }

// Satu schema PostgreSQL per proyek: app_<id>
func appSchema(pid string) string { return "app_" + pid }

var (
	pgOnce sync.Once
	pgDB   *gorm.DB
	pgErr  error
)

// Koneksi ke PostgreSQL khusus app database (port 5434)
func getAppPG() (*gorm.DB, error) {
	pgOnce.Do(func() {
		pass, _ := os.ReadFile("../.pg-password")
		dsn := fmt.Sprintf("host=127.0.0.1 port=5434 user=webbuilder password=%s dbname=webbuilder sslmode=disable",
			strings.TrimSpace(string(pass)))
		pgDB, pgErr = gorm.Open(postgres.Open(dsn), &gorm.Config{})
		if pgErr != nil {
			log.Println("app PG connect gagal:", pgErr)
		}
	})
	return pgDB, pgErr
}

func getAppSQLDB() (*sql.DB, error) {
	db, err := getAppPG()
	if err != nil {
		return nil, err
	}
	return db.DB()
}

// Pastikan schema proyek ada
func ensureSchema(pid string) error {
	if !validTableName(appSchema(pid)) {
		return fmt.Errorf("project id tidak valid")
	}
	sqldb, err := getAppSQLDB()
	if err != nil {
		return err
	}
	_, err = sqldb.Exec(fmt.Sprintf("CREATE SCHEMA IF NOT EXISTS %s", appSchema(pid)))
	return err
}

func pgErrResp(c *gin.Context, err error) bool {
	if err != nil {
		c.JSON(503, gin.H{"message": "Database belum siap: " + err.Error()})
		return true
	}
	return false
}

// List tables for a project (PostgreSQL)
func listAppTables(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, _, ok := requireProject(db, c, "viewer")
		if !ok {
			return
		}
		pid := c.Param("id")
		if pgErrResp(c, ensureSchema(pid)) {
			return
		}
		// Setiap project full-stack selalu memiliki fondasi auth/policy,
		// walaupun user belum pernah membuka halaman login. Database builder
		// harus menampilkan model aplikasi lengkap, bukan hanya tabel bisnis.
		if _, err := ensureProjectAuthTables(pid); pgErrResp(c, err) {
			return
		}
		// Sinkronkan entity yang dipakai service sebelum membaca daftar tabel.
		autoCreateMissingTables(p) //nolint:errcheck
		// Auto-create di atas juga menangani tabel domain dari cloudDb calls.
		sqldb, err := getAppSQLDB()
		if pgErrResp(c, err) {
			return
		}
		rows, err := sqldb.Query(
			"SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename",
			appSchema(pid))
		if err != nil {
			c.JSON(500, gin.H{"message": "Gagal"})
			return
		}
		defer rows.Close()
		tables := []string{}
		for rows.Next() {
			var n string
			rows.Scan(&n)
			tables = append(tables, n)
		}
		c.JSON(200, gin.H{"tables": tables, "engine": "postgresql"})
	}
}

func pgColType(t string) string {
	switch strings.ToUpper(t) {
	case "INTEGER", "INT", "BIGINT":
		return "INTEGER"
	case "REAL", "FLOAT", "NUMERIC", "DECIMAL":
		return "NUMERIC"
	case "BOOLEAN", "BOOL":
		return "BOOLEAN"
	case "TIMESTAMP", "DATETIME":
		return "TIMESTAMP"
	default:
		return "TEXT"
	}
}

// Inspect table schema and a bounded sample of rows for the Data dashboard.
func inspectAppTable(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		if _, _, ok := requireProject(db, c, "viewer"); !ok {
			return
		}
		pid, table := c.Param("id"), c.Param("name")
		if !validTableName(table) || pgErrResp(c, ensureSchema(pid)) {
			return
		}
		sqldb, err := getAppSQLDB()
		if pgErrResp(c, err) {
			return
		}
		colsRows, err := sqldb.Query("SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position", appSchema(pid), table)
		if err != nil {
			c.JSON(404, gin.H{"message": "Tabel tidak ditemukan"})
			return
		}
		defer colsRows.Close()
		columns := []gin.H{}
		for colsRows.Next() {
			var n, t, nullable string
			if colsRows.Scan(&n, &t, &nullable) == nil {
				columns = append(columns, gin.H{"name": n, "type": t, "nullable": nullable == "YES"})
			}
		}
		if len(columns) == 0 {
			c.JSON(404, gin.H{"message": "Tabel tidak ditemukan"})
			return
		}
		// Return rows as JSON-safe maps without exposing arbitrary SQL execution.
		q := fmt.Sprintf("SELECT * FROM %s.%s LIMIT 100", appSchema(pid), table)
		dataRows, err := sqldb.Query(q)
		if err != nil {
			c.JSON(500, gin.H{"message": "Gagal membaca data"})
			return
		}
		defer dataRows.Close()
		names, _ := dataRows.Columns()
		rows := []map[string]any{}
		for dataRows.Next() {
			vals := make([]any, len(names))
			ptrs := make([]any, len(names))
			for i := range vals {
				ptrs[i] = &vals[i]
			}
			if dataRows.Scan(ptrs...) == nil {
				m := map[string]any{}
				for i, n := range names {
					if b, ok := vals[i].([]byte); ok {
						m[n] = string(b)
					} else {
						m[n] = vals[i]
					}
				}
				rows = append(rows, m)
			}
		}
		c.JSON(200, gin.H{"table": table, "columns": columns, "rows": rows, "rowCount": len(rows), "truncated": len(rows) == 100})
	}
}

// List and update table policies for the Data dashboard.
func listAppPolicies(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		if _, _, ok := requireProject(db, c, "viewer"); !ok {
			return
		}
		pid := c.Param("id")
		if pgErrResp(c, ensureSchema(pid)) {
			return
		}
		sqldb, err := getAppSQLDB()
		if pgErrResp(c, err) {
			return
		}
		rows, err := sqldb.Query(fmt.Sprintf("SELECT id,table_name,role,operation,enabled FROM %s.app_policies ORDER BY table_name,role,operation", appSchema(pid)))
		if err != nil {
			c.JSON(500, gin.H{"message": "Gagal membaca policy"})
			return
		}
		defer rows.Close()
		out := []gin.H{}
		for rows.Next() {
			var id int
			var table, role, op string
			var enabled bool
			if rows.Scan(&id, &table, &role, &op, &enabled) == nil {
				out = append(out, gin.H{"id": id, "table": table, "role": role, "operation": op, "enabled": enabled})
			}
		}
		c.JSON(200, gin.H{"policies": out})
	}
}

func upsertAppPolicy(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		if _, _, ok := requireProject(db, c, "editor"); !ok {
			return
		}
		pid := c.Param("id")
		if pgErrResp(c, ensureSchema(pid)) {
			return
		}
		var req struct {
			Table     string `json:"table"`
			Role      string `json:"role"`
			Operation string `json:"operation"`
			Enabled   bool   `json:"enabled"`
		}
		if c.ShouldBindJSON(&req) != nil || !validTableName(req.Table) || !map[string]bool{"owner": true, "admin": true, "member": true, "viewer": true}[req.Role] || !map[string]bool{"select": true, "insert": true, "update": true, "delete": true, "query": true}[req.Operation] {
			c.JSON(400, gin.H{"message": "Policy tidak valid"})
			return
		}
		sqldb, err := getAppSQLDB()
		if pgErrResp(c, err) {
			return
		}
		_, err = sqldb.Exec(fmt.Sprintf("INSERT INTO %s.app_policies(table_name,role,operation,enabled) VALUES($1,$2,$3,$4) ON CONFLICT(table_name,role,operation) DO UPDATE SET enabled=EXCLUDED.enabled", appSchema(pid)), req.Table, req.Role, req.Operation, req.Enabled)
		if err != nil {
			c.JSON(500, gin.H{"message": "Gagal menyimpan policy"})
			return
		}
		c.JSON(200, gin.H{"ok": true})
	}
}

func tableExists(sqldb *sql.DB, schema, table string) bool {
	var exists bool
	_ = sqldb.QueryRow("SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2)", schema, table).Scan(&exists)
	return exists
}

func rowID(c *gin.Context) (int64, bool) {
	id, err := strconv.ParseInt(c.Param("rowId"), 10, 64)
	return id, err == nil && id > 0
}

func insertAppRow(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		if _, _, ok := requireProject(db, c, "editor"); !ok { return }
		pid, table := c.Param("id"), c.Param("name")
		if !validTableName(table) || pgErrResp(c, ensureSchema(pid)) { return }
		var payload map[string]any
		if c.ShouldBindJSON(&payload) != nil || len(payload) == 0 { c.JSON(400, gin.H{"message":"Data row tidak valid"}); return }
		sqldb, err := getAppSQLDB(); if pgErrResp(c, err) { return }
		if !tableExists(sqldb, appSchema(pid), table) { c.JSON(404, gin.H{"message":"Tabel tidak ditemukan"}); return }
		keys := []string{}; vals := []any{}; marks := []string{}
		for k, v := range payload { if validTableName(k) && k != "id" { keys=append(keys,k); vals=append(vals,v); marks=append(marks,"$"+strconv.Itoa(len(vals))) } }
		if len(keys)==0 { c.JSON(400, gin.H{"message":"Tidak ada kolom yang bisa diisi"}); return }
		q := fmt.Sprintf("INSERT INTO %s.%s (%s) VALUES (%s) RETURNING id", appSchema(pid), table, strings.Join(keys,","), strings.Join(marks,","))
		var id int64; if err := sqldb.QueryRow(q, vals...).Scan(&id); err != nil { c.JSON(400, gin.H{"message":"Gagal menambah row: "+err.Error()}); return }
		c.JSON(201, gin.H{"ok":true,"id":id})
	}
}

func updateAppRow(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		if _, _, ok := requireProject(db, c, "editor"); !ok { return }
		pid, table := c.Param("id"), c.Param("name"); id, valid := rowID(c)
		if !valid || !validTableName(table) || pgErrResp(c, ensureSchema(pid)) { return }
		var payload map[string]any
		if c.ShouldBindJSON(&payload) != nil || len(payload) == 0 { c.JSON(400, gin.H{"message":"Data row tidak valid"}); return }
		sqldb, err := getAppSQLDB(); if pgErrResp(c, err) { return }
		if !tableExists(sqldb, appSchema(pid), table) { c.JSON(404, gin.H{"message":"Tabel tidak ditemukan"}); return }
		sets := []string{}; vals := []any{}
		for k, v := range payload { if validTableName(k) && k != "id" { vals=append(vals,v); sets=append(sets,fmt.Sprintf("%s=$%d",k,len(vals))) } }
		if len(sets)==0 { c.JSON(400, gin.H{"message":"Tidak ada kolom yang bisa diubah"}); return }
		vals=append(vals,id)
		res, err := sqldb.Exec(fmt.Sprintf("UPDATE %s.%s SET %s WHERE id=$%d",appSchema(pid),table,strings.Join(sets,","),len(vals)), vals...)
		if err != nil { c.JSON(400, gin.H{"message":"Gagal mengubah row: "+err.Error()}); return }
		n,_:=res.RowsAffected(); if n==0 { c.JSON(404,gin.H{"message":"Row tidak ditemukan"}); return }; c.JSON(200,gin.H{"ok":true,"updated":id})
	}
}

func deleteAppRow(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		if _, _, ok := requireProject(db, c, "editor"); !ok { return }
		pid, table := c.Param("id"), c.Param("name"); id, valid := rowID(c)
		if !valid || !validTableName(table) || pgErrResp(c, ensureSchema(pid)) { return }
		sqldb, err := getAppSQLDB(); if pgErrResp(c, err) { return }
		if !tableExists(sqldb, appSchema(pid), table) { c.JSON(404, gin.H{"message":"Tabel tidak ditemukan"}); return }
		res, err := sqldb.Exec(fmt.Sprintf("DELETE FROM %s.%s WHERE id=$1", appSchema(pid), table), id); if err != nil { c.JSON(400, gin.H{"message":"Gagal menghapus row"}); return }
		n, _ := res.RowsAffected(); if n == 0 { c.JSON(404, gin.H{"message":"Row tidak ditemukan"}); return }; c.JSON(200, gin.H{"ok":true,"deleted":id})
	}
}

// Create table (PostgreSQL)
func createAppTable(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		if _, _, ok := requireProject(db, c, "editor"); !ok {
			return
		}
		pid := c.Param("id")
		if pgErrResp(c, ensureSchema(pid)) {
			return
		}
		var req struct {
			Name    string `json:"name" binding:"required"`
			Columns []struct {
				Name string `json:"name"`
				Type string `json:"type"`
			} `json:"columns"`
		}
		if err := c.ShouldBindJSON(&req); err != nil || !validTableName(req.Name) {
			c.JSON(400, gin.H{"message": "Nama tabel tidak valid"})
			return
		}
		cols := []string{"id SERIAL PRIMARY KEY", "created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP"}
		for _, col := range req.Columns {
			if !validTableName(col.Name) {
				continue
			}
			cols = append(cols, fmt.Sprintf("%s %s", col.Name, pgColType(col.Type)))
		}
		sqldb, err := getAppSQLDB()
		if pgErrResp(c, err) {
			return
		}
		q := fmt.Sprintf("CREATE TABLE IF NOT EXISTS %s.%s (%s)", appSchema(pid), req.Name, strings.Join(cols, ", "))
		if _, err := sqldb.Exec(q); err != nil {
			c.JSON(500, gin.H{"message": "Gagal buat tabel: " + err.Error()})
			return
		}
		c.JSON(200, gin.H{"message": "Tabel dibuat (PostgreSQL)"})
	}
}

// Add column
func addTableColumn(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		if _, _, ok := requireProject(db, c, "editor"); !ok {
			return
		}
		pid, table := c.Param("id"), c.Param("name")
		if !validTableName(table) || pgErrResp(c, ensureSchema(pid)) {
			c.JSON(400, gin.H{"message": "Nama tidak valid"})
			return
		}
		var req struct {
			Name string `json:"name" binding:"required"`
			Type string `json:"type"`
		}
		if err := c.ShouldBindJSON(&req); err != nil || !validTableName(req.Name) {
			c.JSON(400, gin.H{"message": "Nama kolom tidak valid"})
			return
		}
		sqldb, err := getAppSQLDB()
		if pgErrResp(c, err) {
			return
		}
		q := fmt.Sprintf("ALTER TABLE %s.%s ADD COLUMN %s %s", appSchema(pid), table, req.Name, pgColType(req.Type))
		if _, err := sqldb.Exec(q); err != nil {
			c.JSON(500, gin.H{"message": "Gagal: " + err.Error()})
			return
		}
		c.JSON(200, gin.H{"message": "Kolom ditambah"})
	}
}

// Drop table
func dropAppTable(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		if _, _, ok := requireProject(db, c, "editor"); !ok {
			return
		}
		pid, table := c.Param("id"), c.Param("name")
		if !validTableName(table) {
			c.JSON(400, gin.H{"message": "Nama tidak valid"})
			return
		}
		sqldb, err := getAppSQLDB()
		if pgErrResp(c, err) {
			return
		}
		q := fmt.Sprintf("DROP TABLE IF EXISTS %s.%s", appSchema(pid), table)
		sqldb.Exec(q)
		c.JSON(200, gin.H{"message": "Tabel dihapus"})
	}
}

// Drop seluruh schema proyek (dipakai saat hapus proyek)
func dropAppSchema(pid string) {
	sqldb, err := getAppSQLDB()
	if err != nil {
		return
	}
	if validTableName(appSchema(pid)) {
		sqldb.Exec(fmt.Sprintf("DROP SCHEMA IF EXISTS %s CASCADE", appSchema(pid)))
	}
}

// AI SQL block: create tables from AI (PostgreSQL, schema per proyek)
func splitSQLStatements(text string) []string {
	var out []string
	start := 0
	quote := byte(0)
	escaped := false
	for i := 0; i < len(text); i++ {
		c := text[i]
		if quote != 0 {
			if escaped {
				escaped = false
				continue
			}
			if c == '\\' {
				escaped = true
				continue
			}
			if c == quote {
				if i+1 < len(text) && text[i+1] == quote {
					i++
					continue
				}
				quote = 0
			}
			continue
		}
		if c == '\'' || c == '"' {
			quote = c
			continue
		}
		if c == ';' {
			if s := strings.TrimSpace(text[start:i]); s != "" {
				out = append(out, s)
			}
			start = i + 1
		}
	}
	if s := strings.TrimSpace(text[start:]); s != "" {
		out = append(out, s)
	}
	return out
}

// execAISQL hanya menerima DDL CREATE TABLE dan mengembalikan error yang dapat diaudit.
func execAISQL(db *gorm.DB, pid, sqlText string) error {
	if err := ensureSchema(pid); err != nil {
		return err
	}
	sqldb, err := getAppSQLDB()
	if err != nil {
		return err
	}
	for _, stmt := range splitSQLStatements(sqlText) {
		upper := strings.ToUpper(strings.TrimSpace(stmt))
		if !strings.HasPrefix(upper, "CREATE TABLE") {
			return fmt.Errorf("SQL tidak diizinkan: hanya CREATE TABLE")
		}
		parts := strings.Fields(stmt)
		if len(parts) < 3 {
			return fmt.Errorf("nama tabel tidak valid")
		}
		tn := strings.Trim(parts[2], `"'`)
		if !validTableName(tn) {
			return fmt.Errorf("nama tabel tidak valid")
		}
		newStmt := strings.Replace(stmt, parts[2], appSchema(pid)+"."+tn, 1)
		newStmt = strings.ReplaceAll(newStmt, "AUTOINCREMENT", "")
		newStmt = regexp.MustCompile(`(?i)\bINTEGER PRIMARY KEY\b`).ReplaceAllString(newStmt, "SERIAL PRIMARY KEY")
		newStmt = regexp.MustCompile(`(?i)\bDATETIME\b`).ReplaceAllString(newStmt, "TIMESTAMP")
		if _, err := sqldb.Exec(newStmt); err != nil {
			return fmt.Errorf("create table %s: %w", tn, err)
		}
	}
	return nil
}

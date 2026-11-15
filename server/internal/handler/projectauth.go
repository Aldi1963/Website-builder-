package handler

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"
)

func projectAuthIDs(pid string) (uint, error) {
	id, err := strconv.ParseUint(pid, 10, 64)
	if err != nil || id == 0 {
		return 0, fmt.Errorf("invalid project id")
	}
	return uint(id), nil
}

func ensureProjectAuthTables(pid string) (*sql.DB, error) {
	if _, err := projectAuthIDs(pid); err != nil {
		return nil, err
	}
	if err := ensureSchema(pid); err != nil {
		return nil, err
	}
	db, err := getAppSQLDB()
	if err != nil {
		return nil, err
	}
	schema := appSchema(pid)
	_, err = db.Exec(fmt.Sprintf(`
CREATE TABLE IF NOT EXISTS %s.app_users (
 id SERIAL PRIMARY KEY,
 name TEXT NOT NULL,
 email TEXT NOT NULL UNIQUE,
 password_hash TEXT NOT NULL,
 role TEXT NOT NULL DEFAULT 'member',
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS %s.app_sessions (
 id SERIAL PRIMARY KEY,
 user_id INTEGER NOT NULL REFERENCES %s.app_users(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL UNIQUE,
 expires_at TIMESTAMP NOT NULL,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS app_sessions_token_idx ON %s.app_sessions(token_hash);
CREATE TABLE IF NOT EXISTS %s.app_policies (
 id SERIAL PRIMARY KEY,
 table_name TEXT NOT NULL,
 role TEXT NOT NULL,
 operation TEXT NOT NULL,
 enabled BOOLEAN NOT NULL DEFAULT TRUE,
 UNIQUE(table_name, role, operation)
);
`, schema, schema, schema, schema, schema))
	return db, err
}

func projectAuthToken(c *gin.Context) string {
	// Auth endpoints accept the legacy Authorization fallback for compatibility.
	// Database API middleware below accepts ONLY X-Project-Session.
	if session := strings.TrimSpace(c.GetHeader("X-Project-Session")); session != "" {
		return session
	}
	t := c.GetHeader("Authorization")
	if strings.HasPrefix(t, "Bearer ") {
		return strings.TrimSpace(strings.TrimPrefix(t, "Bearer "))
	}
	return ""
}

// projectAppSessionMiddleware protects generated-app database calls. A builder
// JWT must never grant access to an app database; only the project's own,
// hashed session token is accepted.
func projectAppSessionMiddleware(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		pid, ok := projectAuthProject(db, c)
		if !ok {
			return
		}
		token := strings.TrimSpace(c.GetHeader("X-Project-Session"))
		if token == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "project session wajib", "code": "APP_SESSION_REQUIRED"})
			return
		}
		appdb, err := ensureProjectAuthTables(pid)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "app database belum siap"})
			return
		}
		schema := appSchema(pid)
		var userID int64
		var role string
		var expires time.Time
		err = appdb.QueryRow(fmt.Sprintf("SELECT u.id,u.role,s.expires_at FROM %s.app_sessions s JOIN %s.app_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>NOW()", schema, schema), tokenHash(token)).Scan(&userID, &role, &expires)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "project session tidak valid atau kadaluarsa", "code": "APP_SESSION_INVALID"})
			return
		}
		c.Set("appUserID", uint(userID))
		c.Set("appRole", role)
		c.Set("appProjectID", pid)
		c.Next()
	}
}

func appSessionContext(c *gin.Context) (uint, string, bool) {
	uid, uidOK := c.Get("appUserID")
	role, roleOK := c.Get("appRole")
	u, ok := uid.(uint)
	r, rok := role.(string)
	return u, r, uidOK && roleOK && ok && rok && u > 0 && r != ""
}

func requireAppRole(c *gin.Context, allowed ...string) bool {
	_, role, ok := appSessionContext(c)
	if !ok {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "project session wajib", "code": "APP_SESSION_REQUIRED"})
		return false
	}
	for _, candidate := range allowed {
		if role == candidate {
			return true
		}
	}
	c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "policy menolak akses", "code": "APP_POLICY_DENIED"})
	return false
}

// Explicit table policies override the safe role defaults.
func checkTablePolicy(c *gin.Context, table, operation string) bool {
	_, role, ok := appSessionContext(c)
	if !ok {
		return false
	}
	pid := c.Param("id")
	sqldb, err := ensureProjectAuthTables(pid)
	if err != nil {
		c.AbortWithStatusJSON(503, gin.H{"error": "policy database belum siap"})
		return false
	}
	var enabled bool
	err = sqldb.QueryRow(fmt.Sprintf("SELECT enabled FROM %s.app_policies WHERE table_name=$1 AND role=$2 AND operation=$3", appSchema(pid)), table, role, operation).Scan(&enabled)
	if err == nil {
		if !enabled {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "policy menolak operasi " + operation, "code": "APP_POLICY_DENIED"})
			return false
		}
		return true
	}
	return requireAppOperation(c, operation)
}

// Default project RLS policy. Owners/admins have full access; members can
// read/create; viewers are read-only. This is deny-by-default.
func requireAppOperation(c *gin.Context, operation string) bool {
	_, role, ok := appSessionContext(c)
	if !ok {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "project session wajib", "code": "APP_SESSION_REQUIRED"})
		return false
	}
	allowed := role == "owner" || role == "admin"
	if role == "member" && (operation == "select" || operation == "insert") {
		allowed = true
	}
	if role == "viewer" && operation == "select" {
		allowed = true
	}
	if !allowed {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "policy menolak operasi " + operation, "code": "APP_POLICY_DENIED", "operation": operation, "role": role})
		return false
	}
	return true
}

// Keep this reference explicit so future policy handlers can use the expiry
// value without exposing it in the request context.
var _ = time.Time{}

func tokenHash(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}

func projectAuthProject(db *gorm.DB, c *gin.Context) (string, bool) {
	pid := c.Param("id")
	id, err := projectAuthIDs(pid)
	if err != nil {
		c.JSON(400, gin.H{"error": "project tidak valid"})
		return "", false
	}
	var count int64
	db.Table("projects").Where("id = ?", id).Count(&count)
	if count == 0 {
		c.JSON(404, gin.H{"error": "project tidak ditemukan"})
		return "", false
	}
	return pid, true
}

func projectAuthRegister(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		pid, ok := projectAuthProject(db, c)
		if !ok {
			return
		}
		appdb, err := ensureProjectAuthTables(pid)
		if err != nil {
			c.JSON(503, gin.H{"error": err.Error()})
			return
		}
		var req struct {
			Name     string `json:"name" binding:"required"`
			Email    string `json:"email" binding:"required,email"`
			Password string `json:"password" binding:"required,min=8"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(400, gin.H{"error": "name, email, dan password minimal 8 karakter wajib"})
			return
		}
		hash, _ := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
		schema := appSchema(pid)
		var uid int64
		err = appdb.QueryRow(fmt.Sprintf("INSERT INTO %s.app_users (name,email,password_hash) VALUES ($1,$2,$3) RETURNING id", schema), strings.TrimSpace(req.Name), strings.ToLower(strings.TrimSpace(req.Email)), string(hash)).Scan(&uid)
		if err != nil {
			if strings.Contains(strings.ToLower(err.Error()), "unique") {
				c.JSON(409, gin.H{"error": "email sudah terdaftar"})
			} else {
				c.JSON(500, gin.H{"error": "gagal membuat user"})
			}
			return
		}
		token := randHex(32)
		expires := time.Now().Add(30 * 24 * time.Hour)
		_, err = appdb.Exec(fmt.Sprintf("INSERT INTO %s.app_sessions (user_id,token_hash,expires_at) VALUES ($1,$2,$3)", schema), uid, tokenHash(token), expires)
		if err != nil {
			c.JSON(500, gin.H{"error": "gagal membuat session"})
			return
		}
		c.JSON(201, gin.H{"user": gin.H{"id": uid, "name": req.Name, "email": strings.ToLower(strings.TrimSpace(req.Email)), "role": "member"}, "token": token, "expiresAt": expires})
	}
}

func projectAuthLogin(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		pid, ok := projectAuthProject(db, c)
		if !ok {
			return
		}
		appdb, err := ensureProjectAuthTables(pid)
		if err != nil {
			c.JSON(503, gin.H{"error": err.Error()})
			return
		}
		var req struct {
			Email    string `json:"email" binding:"required,email"`
			Password string `json:"password" binding:"required"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(400, gin.H{"error": "email dan password wajib"})
			return
		}
		schema := appSchema(pid)
		var id int64
		var name, email, hash, role string
		err = appdb.QueryRow(fmt.Sprintf("SELECT id,name,email,password_hash,role FROM %s.app_users WHERE email=$1", schema), strings.ToLower(strings.TrimSpace(req.Email))).Scan(&id, &name, &email, &hash, &role)
		if err != nil || bcrypt.CompareHashAndPassword([]byte(hash), []byte(req.Password)) != nil {
			c.JSON(401, gin.H{"error": "email atau password salah"})
			return
		}
		token := randHex(32)
		expires := time.Now().Add(30 * 24 * time.Hour)
		if _, err = appdb.Exec(fmt.Sprintf("INSERT INTO %s.app_sessions (user_id,token_hash,expires_at) VALUES ($1,$2,$3)", schema), id, tokenHash(token), expires); err != nil {
			c.JSON(500, gin.H{"error": "gagal membuat session"})
			return
		}
		c.JSON(200, gin.H{"user": gin.H{"id": id, "name": name, "email": email, "role": role}, "token": token, "expiresAt": expires})
	}
}

func projectAuthMe(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		pid, ok := projectAuthProject(db, c)
		if !ok {
			return
		}
		token := projectAuthToken(c)
		if token == "" {
			c.JSON(401, gin.H{"error": "session wajib"})
			return
		}
		appdb, err := ensureProjectAuthTables(pid)
		if err != nil {
			c.JSON(503, gin.H{"error": err.Error()})
			return
		}
		schema := appSchema(pid)
		var id int64
		var name, email, role string
		var expires time.Time
		err = appdb.QueryRow(fmt.Sprintf("SELECT u.id,u.name,u.email,u.role,s.expires_at FROM %s.app_sessions s JOIN %s.app_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>NOW()", schema, schema), tokenHash(token)).Scan(&id, &name, &email, &role, &expires)
		if err != nil {
			c.JSON(401, gin.H{"error": "session tidak valid atau kadaluarsa"})
			return
		}
		c.JSON(200, gin.H{"user": gin.H{"id": id, "name": name, "email": email, "role": role}, "expiresAt": expires})
	}
}

func projectAuthLogout(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		pid, ok := projectAuthProject(db, c)
		if !ok {
			return
		}
		token := projectAuthToken(c)
		if token != "" {
			if appdb, err := ensureProjectAuthTables(pid); err == nil {
				_, _ = appdb.Exec(fmt.Sprintf("DELETE FROM %s.app_sessions WHERE token_hash=$1", appSchema(pid)), tokenHash(token))
			}
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

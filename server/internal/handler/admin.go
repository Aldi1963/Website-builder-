package handler

import (
	"fmt"
	"runtime"
	"strings"
	"time"

	"webbuilder/internal/database/models"

	"github.com/gin-gonic/gin"
	"github.com/pquerna/otp/totp"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"
)

func audit(db *gorm.DB, uid uint, action, detail, ip string) {
	db.Create(&models.AuditLog{UserID: uid, Action: action, Detail: detail, IP: ip})
}

// ── Admin: statistik ──

func adminStats(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var users, projects, deployments, aiUsage int64
		db.Model(&models.User{}).Count(&users)
		db.Model(&models.Project{}).Count(&projects)
		db.Model(&models.Deployment{}).Count(&deployments)
		db.Model(&models.AIUsage{}).Count(&aiUsage)
		var m runtime.MemStats
		runtime.ReadMemStats(&m)
		c.JSON(200, gin.H{
			"users": users, "projects": projects, "deployments": deployments, "aiCalls": aiUsage,
			"memMB": m.Alloc / 1024 / 1024, "goroutines": runtime.NumGoroutine(),
		})
	}
}

// ── Admin: users ──

func adminListUsers(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var us []models.User
		q := db.Order("id DESC").Limit(100)
		if s := c.Query("q"); s != "" {
			q = q.Where("email LIKE ? OR name LIKE ?", "%"+s+"%", "%"+s+"%")
		}
		q.Find(&us)
		out := []gin.H{}
		for _, u := range us {
			var pc int64
			db.Model(&models.Project{}).Where("user_id = ?", u.ID).Count(&pc)
			out = append(out, gin.H{
				"id": u.ID, "name": u.Name, "email": u.Email, "avatar": u.Avatar,
				"isAdmin": u.IsAdmin, "suspended": u.Suspended,
				"projects": pc, "createdAt": u.CreatedAt,
			})
		}
		c.JSON(200, gin.H{"users": out})
	}
}

func adminUpdateUser(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			IsAdmin   *bool   `json:"isAdmin"`
			Suspended *bool   `json:"suspended"`
			Password  *string `json:"password"`
		}
		c.ShouldBindJSON(&req)
		var u models.User
		if err := db.First(&u, c.Param("id")).Error; err != nil {
			c.JSON(404, gin.H{"message": "User tidak ada"})
			return
		}
		if u.ID == c.GetUint("userID") && req.IsAdmin != nil && !*req.IsAdmin {
			c.JSON(400, gin.H{"message": "Tidak bisa cabut admin sendiri"})
			return
		}
		updates := map[string]interface{}{}
		if req.IsAdmin != nil {
			updates["is_admin"] = *req.IsAdmin
		}
		if req.Suspended != nil {
			updates["suspended"] = *req.Suspended
		}
		if req.Password != nil && *req.Password != "" {
			h, _ := bcrypt.GenerateFromPassword([]byte(*req.Password), 10)
			updates["password"] = string(h)
		}
		if len(updates) > 0 {
			db.Model(&u).Updates(updates)
			audit(db, c.GetUint("userID"), "admin.update_user", u.Email, c.ClientIP())
		}
		c.JSON(200, gin.H{"message": "Tersimpan"})
	}
}

// ── Admin: audit log ──

func adminAuditLog(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var logs []models.AuditLog
		db.Order("id DESC").Limit(200).Find(&logs)
		c.JSON(200, gin.H{"logs": logs})
	}
}

// ── Admin: templates ──

func adminListTemplates(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var ts []models.Template
		db.Order("id").Find(&ts)
		c.JSON(200, gin.H{"templates": ts})
	}
}

func adminSaveTemplate(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			ID          *uint  `json:"id"`
			Name        string `json:"name"`
			Description string `json:"description"`
			Category    string `json:"category"`
			Framework   string `json:"framework"`
			Files       string `json:"files"`
		}
		if err := c.ShouldBindJSON(&req); err != nil || req.Name == "" {
			c.JSON(400, gin.H{"message": "Nama wajib"})
			return
		}
		if req.ID != nil {
			db.Model(&models.Template{}).Where("id = ?", *req.ID).Updates(map[string]interface{}{
				"name": req.Name, "description": req.Description, "category": req.Category,
				"framework": req.Framework, "files": req.Files,
			})
		} else {
			db.Create(&models.Template{
				Name: req.Name, Description: req.Description, Category: req.Category,
				Framework: req.Framework, Files: req.Files,
			})
		}
		audit(db, c.GetUint("userID"), "admin.save_template", req.Name, c.ClientIP())
		c.JSON(200, gin.H{"message": "Tersimpan"})
	}
}

func adminDeleteTemplate(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		db.Delete(&models.Template{}, c.Param("id"))
		audit(db, c.GetUint("userID"), "admin.delete_template", c.Param("id"), c.ClientIP())
		c.JSON(200, gin.H{"message": "Dihapus"})
	}
}

// ── Admin: platform settings ──

func adminGetSettings(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var ss []models.PlatformSetting
		db.Find(&ss)
		out := map[string]string{}
		for _, s := range ss {
			// jangan expose secret
			if (s.Key == "smtp_password" || strings.HasSuffix(s.Key, "_client_secret")) && s.Value != "" {
				out[s.Key] = "****"
				continue
			}
			out[s.Key] = s.Value
		}
		c.JSON(200, gin.H{"settings": out})
	}
}

func adminSaveSettings(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req map[string]string
		c.ShouldBindJSON(&req)
		for k, v := range req {
			if len(k) > 100 {
				continue
			}
			// skip masked password
			if (k == "smtp_password" || strings.HasSuffix(k, "_client_secret")) && (v == "****" || v == "") {
				continue
			}
			// enkripsi secrets
			if strings.HasSuffix(k, "_client_secret") && v != "" {
				if enc, err := keyEnc.Encrypt(v); err == nil {
					v = enc
				}
			}
			var s models.PlatformSetting
			db.Where("key = ?", k).FirstOrCreate(&s, models.PlatformSetting{Key: k})
			db.Model(&s).Update("value", v)
		}
		audit(db, c.GetUint("userID"), "admin.save_settings", "platform", c.ClientIP())
		c.JSON(200, gin.H{"message": "Tersimpan"})
	}
}

func getSetting(db *gorm.DB, key string) string {
	var s models.PlatformSetting
	if err := db.Where("key = ?", key).First(&s).Error; err != nil {
		return ""
	}
	return s.Value
}

// ── Admin: moderasi ──

func adminListBlocked(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var ws []models.BlockedWord
		db.Order("word").Find(&ws)
		c.JSON(200, gin.H{"words": ws})
	}
}

func adminAddBlocked(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Word string `json:"word" binding:"required"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(400, gin.H{"message": "Kata wajib"})
			return
		}
		db.FirstOrCreate(&models.BlockedWord{}, models.BlockedWord{Word: req.Word})
		c.JSON(200, gin.H{"message": "Ditambah"})
	}
}

func adminDeleteBlocked(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		db.Delete(&models.BlockedWord{}, c.Param("id"))
		c.JSON(200, gin.H{"message": "Dihapus"})
	}
}

func containsBlocked(db *gorm.DB, text string) string {
	var ws []models.BlockedWord
	db.Find(&ws)
	lower := ""
	for _, w := range ws {
		if w.Word == "" {
			continue
		}
		if lower == "" {
			lower = stringToLower(text)
		}
		if contains(lower, stringToLower(w.Word)) {
			return w.Word
		}
	}
	return ""
}

func stringToLower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + 32
		}
	}
	return string(b)
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

// ── Notifikasi ──

func notify(db *gorm.DB, uid uint, title, body string) {
	db.Create(&models.Notification{UserID: uid, Title: title, Body: body})
}

func listNotifications(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var ns []models.Notification
		db.Where("user_id = ?", c.GetUint("userID")).Order("id DESC").Limit(50).Find(&ns)
		var unread int64
		db.Model(&models.Notification{}).Where("user_id = ? AND read = ?", c.GetUint("userID"), false).Count(&unread)
		c.JSON(200, gin.H{"notifications": ns, "unread": unread})
	}
}

func readNotifications(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		db.Model(&models.Notification{}).Where("user_id = ?", c.GetUint("userID")).Update("read", true)
		c.JSON(200, gin.H{"message": "OK"})
	}
}

// ── Kolaborasi ──

func listMembers(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var ms []models.ProjectMember
		db.Where("project_id = ?", c.Param("id")).Find(&ms)
		out := []gin.H{}
		for _, m := range ms {
			var u models.User
			db.Select("id", "name", "email").First(&u, m.UserID)
			out = append(out, gin.H{"id": m.ID, "userId": u.ID, "name": u.Name, "email": u.Email, "role": m.Role})
		}
		c.JSON(200, gin.H{"members": out})
	}
}

func addMember(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := c.GetUint("userID")
		var p models.Project
		if err := db.Where("id = ? AND user_id = ?", c.Param("id"), uid).First(&p).Error; err != nil {
			c.JSON(404, gin.H{"message": "Hanya pemilik"})
			return
		}
		var req struct {
			Email string `json:"email" binding:"required"`
			Role  string `json:"role"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(400, gin.H{"message": "Email wajib"})
			return
		}
		var u models.User
		if err := db.Where("email = ?", req.Email).First(&u).Error; err != nil {
			c.JSON(404, gin.H{"message": "User tidak ditemukan"})
			return
		}
		if u.ID == uid {
			c.JSON(400, gin.H{"message": "Itu akunmu sendiri"})
			return
		}
		role := req.Role
		if role != "editor" {
			role = "viewer"
		}
		var m models.ProjectMember
		db.Where("project_id = ? AND user_id = ?", p.ID, u.ID).FirstOrCreate(&m,
			models.ProjectMember{ProjectID: p.ID, UserID: u.ID, Role: role})
		db.Model(&m).Update("role", role)
		notify(db, u.ID, "Diundang ke proyek", p.Name+" ("+role+")")
		c.JSON(200, gin.H{"message": "Ditambah"})
	}
}

func removeMember(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := c.GetUint("userID")
		var p models.Project
		if err := db.Where("id = ? AND user_id = ?", c.Param("id"), uid).First(&p).Error; err != nil {
			c.JSON(404, gin.H{"message": "Hanya pemilik"})
			return
		}
		db.Where("id = ? AND project_id = ?", c.Param("mid"), p.ID).Delete(&models.ProjectMember{})
		c.JSON(200, gin.H{"message": "Dihapus"})
	}
}

// canAccess: pemilik atau member
func canAccessProject(db *gorm.DB, pid string, uid uint) (*models.Project, string) {
	var p models.Project
	if err := db.Where("id = ? AND user_id = ?", pid, uid).First(&p).Error; err == nil {
		return &p, "owner"
	}
	var m models.ProjectMember
	if err := db.Where("project_id = ? AND user_id = ?", pid, uid).First(&m).Error; err == nil {
		db.Where("id = ?", pid).First(&p)
		return &p, m.Role
	}
	return nil, ""
}

// ── API key pribadi ──

func listAPIKeys(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var ks []models.UserAPIKey
		db.Where("user_id = ?", c.GetUint("userID")).Order("id DESC").Find(&ks)
		out := []gin.H{}
		for _, k := range ks {
			out = append(out, gin.H{"id": k.ID, "name": k.Name, "prefix": k.Prefix, "lastUsed": k.LastUsed, "createdAt": k.CreatedAt})
		}
		c.JSON(200, gin.H{"keys": out})
	}
}

func createAPIKey(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Name string `json:"name" binding:"required"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(400, gin.H{"message": "Nama wajib"})
			return
		}
		raw := "wb_" + randHex(24)
		h := sha256Hex(raw)
		db.Create(&models.UserAPIKey{
			UserID: c.GetUint("userID"), Name: req.Name,
			KeyHash: h, Prefix: raw[:10],
		})
		// tampilkan sekali saja
		c.JSON(200, gin.H{"key": raw, "message": "Simpan key ini, hanya tampil sekali"})
	}
}

func deleteAPIKey(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		db.Where("id = ? AND user_id = ?", c.Param("id"), c.GetUint("userID")).Delete(&models.UserAPIKey{})
		c.JSON(200, gin.H{"message": "Dihapus"})
	}
}

// ── Webhook proyek ──

func listWebhooks(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		if _, role := canAccessProject(db, c.Param("id"), c.GetUint("userID")); role == "" {
			c.JSON(404, gin.H{"message": "Tidak ada"})
			return
		}
		var ws []models.ProjectWebhook
		db.Where("project_id = ?", c.Param("id")).Find(&ws)
		out := []gin.H{}
		for _, w := range ws {
			out = append(out, gin.H{"id": w.ID, "url": w.URL, "events": w.Events, "createdAt": w.CreatedAt})
		}
		c.JSON(200, gin.H{"webhooks": out})
	}
}

func addWebhook(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, role := canAccessProject(db, c.Param("id"), c.GetUint("userID"))
		if role == "" || role == "viewer" {
			c.JSON(403, gin.H{"message": "Tidak diizinkan"})
			return
		}
		var req struct {
			URL    string `json:"url" binding:"required"`
			Events string `json:"events"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(400, gin.H{"message": "URL wajib"})
			return
		}
		ev := req.Events
		if ev == "" {
			ev = "deploy"
		}
		db.Create(&models.ProjectWebhook{ProjectID: p.ID, URL: req.URL, Events: ev, Secret: randHex(16)})
		c.JSON(200, gin.H{"message": "Ditambah"})
	}
}

func deleteWebhook(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, role := canAccessProject(db, c.Param("id"), c.GetUint("userID"))
		if role == "" || role == "viewer" {
			c.JSON(403, gin.H{"message": "Tidak diizinkan"})
			return
		}
		db.Where("id = ? AND project_id = ?", c.Param("wid"), p.ID).Delete(&models.ProjectWebhook{})
		c.JSON(200, gin.H{"message": "Dihapus"})
	}
}

func fireWebhook(db *gorm.DB, projectID uint, event string, payload map[string]interface{}) {
	var ws []models.ProjectWebhook
	db.Where("project_id = ?", projectID).Find(&ws)
	for _, w := range ws {
		if !contains(","+w.Events+",", ","+event+",") && w.Events != "*" {
			continue
		}
		go func(url, secret string) {
			body, _ := jsonMarshal(map[string]interface{}{"event": event, "data": payload})
			req, _ := httpNewRequest("POST", url, body)
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-Webhook-Secret", secret)
			httpClient().Do(req)
		}(w.URL, w.Secret)
	}
}

// ── Visitor stats ──

func projectStats(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		if _, role := canAccessProject(db, c.Param("id"), c.GetUint("userID")); role == "" {
			c.JSON(404, gin.H{"message": "Tidak ada"})
			return
		}
		var vs []models.VisitStat
		db.Where("project_id = ?", c.Param("id")).Order("date DESC").Limit(30).Find(&vs)
		total := 0
		for _, v := range vs {
			total += v.Count
		}
		c.JSON(200, gin.H{"visits": vs, "total": total})
	}
}

func trackVisit(db *gorm.DB, projectID uint) {
	today := time.Now().Format("2006-01-02")
	var v models.VisitStat
	if err := db.Where("project_id = ? AND date = ?", projectID, today).First(&v).Error; err != nil {
		db.Create(&models.VisitStat{ProjectID: projectID, Date: today, Count: 1})
	} else {
		db.Model(&v).Update("count", v.Count+1)
	}
}

var _ = time.Now

func adminOnly(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		if !isAdmin(db, c.GetUint("userID")) {
			c.JSON(403, gin.H{"message": "Khusus admin"})
			c.Abort()
			return
		}
		c.Next()
	}
}

// ── 2FA TOTP ──

func verifyTOTP(secret, code string) bool {
	return totp.Validate(code, secret)
}

func totpSetup(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := c.GetUint("userID")
		var u models.User
		db.First(&u, uid)
		key, err := totp.Generate(totp.GenerateOpts{Issuer: "WebBuilder", AccountName: u.Email})
		if err != nil {
			c.JSON(500, gin.H{"message": "Gagal"})
			return
		}
		var t models.UserTOTP
		db.Where("user_id = ?", uid).FirstOrCreate(&t, models.UserTOTP{UserID: uid})
		db.Model(&t).Updates(map[string]interface{}{"secret": key.Secret(), "enabled": false})
		// QR sebagai URL otpauth (frontend render QR)
		c.JSON(200, gin.H{"qr": key.URL(), "secret": key.Secret()})
	}
}

func totpVerify(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := c.GetUint("userID")
		var req struct {
			Code string `json:"code" binding:"required"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(400, gin.H{"message": "Kode wajib"})
			return
		}
		var t models.UserTOTP
		if err := db.Where("user_id = ?", uid).First(&t).Error; err != nil || t.Secret == "" {
			c.JSON(400, gin.H{"message": "Belum setup"})
			return
		}
		if !verifyTOTP(t.Secret, req.Code) {
			c.JSON(401, gin.H{"message": "Kode salah"})
			return
		}
		db.Model(&t).Update("enabled", true)
		audit(db, uid, "2fa.enable", "2FA diaktifkan", c.ClientIP())
		c.JSON(200, gin.H{"message": "2FA aktif"})
	}
}

func totpDisable(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := c.GetUint("userID")
		var req struct {
			Password string `json:"password" binding:"required"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(400, gin.H{"message": "Password wajib"})
			return
		}
		var u models.User
		db.First(&u, uid)
		if err := bcrypt.CompareHashAndPassword([]byte(u.Password), []byte(req.Password)); err != nil {
			c.JSON(401, gin.H{"message": "Password salah"})
			return
		}
		db.Where("user_id = ?", uid).Delete(&models.UserTOTP{})
		audit(db, uid, "2fa.disable", "2FA dimatikan", c.ClientIP())
		c.JSON(200, gin.H{"message": "2FA dimatikan"})
	}
}

func totpStatus(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var t models.UserTOTP
		enabled := false
		if err := db.Where("user_id = ?", c.GetUint("userID")).First(&t).Error; err == nil {
			enabled = t.Enabled
		}
		c.JSON(200, gin.H{"enabled": enabled})
	}
}

// ── SMTP mail ──

func sendMail(db *gorm.DB, to, subject, body string) error {
	host := getSetting(db, "smtp_host")
	if host == "" {
		return fmt.Errorf("SMTP belum dikonfigurasi")
	}
	port := getSetting(db, "smtp_port")
	if port == "" {
		port = "587"
	}
	user := getSetting(db, "smtp_user")
	pass := getSetting(db, "smtp_password")
	from := getSetting(db, "smtp_from")
	if from == "" {
		from = user
	}
	msg := []byte("To: " + to + "\r\nSubject: " + subject + "\r\n\r\n" + body + "\r\n")
	auth := smtpPlainAuth("", user, pass, host)
	return smtpSend(host+":"+port, auth, from, []string{to}, msg)
}

func siteBaseURL(db *gorm.DB) string {
	if v := getSetting(db, "site_url"); v != "" {
		return v
	}
	return "https://build.clipku.my.id"
}

// requireProject: minRole = "viewer" | "editor" | "owner"
func requireProject(db *gorm.DB, c *gin.Context, minRole string) (*models.Project, string, bool) {
	p, role := canAccessProject(db, c.Param("id"), c.GetUint("userID"))
	if role == "" {
		c.JSON(404, gin.H{"message": "Proyek tidak ada"})
		return nil, "", false
	}
	levels := map[string]int{"viewer": 1, "editor": 2, "owner": 3}
	if levels[role] < levels[minRole] {
		c.JSON(403, gin.H{"message": "Tidak diizinkan"})
		return nil, "", false
	}
	return p, role, true
}

// ── Komentar file ──

func listComments(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		if _, _, ok := requireProject(db, c, "viewer"); !ok {
			return
		}
		var cs []models.FileComment
		db.Where("project_id = ?", c.Param("id")).Order("id ASC").Find(&cs)
		c.JSON(200, gin.H{"comments": cs})
	}
}

func addComment(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, _, ok := requireProject(db, c, "editor")
		if !ok {
			return
		}
		var req struct {
			FilePath string `json:"filePath" binding:"required"`
			Line     int    `json:"line"`
			Body     string `json:"body" binding:"required"`
		}
		if err := c.ShouldBindJSON(&req); err != nil || len(req.Body) > 2000 {
			c.JSON(400, gin.H{"message": "Komentar tidak valid"})
			return
		}
		var u models.User
		db.Select("name").First(&u, c.GetUint("userID"))
		cm := models.FileComment{
			ProjectID: p.ID, FilePath: req.FilePath, Line: req.Line,
			UserID: c.GetUint("userID"), UserName: u.Name, Body: req.Body,
		}
		db.Create(&cm)
		// notifikasi pemilik bila komentator bukan pemilik
		if p.UserID != cm.UserID {
			notify(db, p.UserID, "Komentar baru", u.Name+" mengomentari "+req.FilePath+" di "+p.Name)
		}
		c.JSON(200, gin.H{"comment": cm})
	}
}

func resolveComment(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, _, ok := requireProject(db, c, "editor")
		if !ok {
			return
		}
		var cm models.FileComment
		if err := db.Where("id = ? AND project_id = ?", c.Param("cid"), p.ID).First(&cm).Error; err != nil {
			c.JSON(404, gin.H{"message": "Tidak ada"})
			return
		}
		db.Model(&cm).Update("resolved", !cm.Resolved)
		c.JSON(200, gin.H{"comment": cm})
	}
}

func deleteComment(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, _, ok := requireProject(db, c, "editor")
		if !ok {
			return
		}
		uid := c.GetUint("userID")
		var cm models.FileComment
		if err := db.Where("id = ? AND project_id = ?", c.Param("cid"), p.ID).First(&cm).Error; err != nil {
			c.JSON(404, gin.H{"message": "Tidak ada"})
			return
		}
		// hanya penulis atau pemilik proyek
		if cm.UserID != uid && p.UserID != uid {
			c.JSON(403, gin.H{"message": "Tidak diizinkan"})
			return
		}
		db.Delete(&cm)
		c.JSON(200, gin.H{"message": "Dihapus"})
	}
}

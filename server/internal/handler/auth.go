package handler

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"webbuilder/internal/database/models"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"
)

// ── Rate limiter + brute-force lockout ──

type attemptInfo struct {
	count       int
	lockedUntil time.Time
}

var (
	loginAttempts = map[string]*attemptInfo{}
	attemptMu     sync.Mutex
)

func loginKey(c *gin.Context, email string) string {
	return c.ClientIP() + "|" + strings.ToLower(strings.TrimSpace(email))
}

func checkLoginAllowed(c *gin.Context, email string) bool {
	attemptMu.Lock()
	defer attemptMu.Unlock()
	a := loginAttempts[loginKey(c, email)]
	if a == nil {
		return true
	}
	if time.Now().Before(a.lockedUntil) {
		return false
	}
	return true
}

func recordLoginFail(c *gin.Context, email string) {
	attemptMu.Lock()
	defer attemptMu.Unlock()
	k := loginKey(c, email)
	a := loginAttempts[k]
	if a == nil {
		a = &attemptInfo{}
		loginAttempts[k] = a
	}
	a.count++
	if a.count >= 5 {
		a.lockedUntil = time.Now().Add(15 * time.Minute)
		a.count = 0
	}
}

func recordLoginSuccess(c *gin.Context, email string) {
	attemptMu.Lock()
	defer attemptMu.Unlock()
	delete(loginAttempts, loginKey(c, email))
}

var keyEnc *AIKeyEncryptor

func RegisterRoutes(r *gin.Engine, db *gorm.DB) {
	enc, err := loadAIKeyEncryptor()
	if err != nil {
		log.Fatal("gagal init enkripsi API key:", err)
	}
	keyEnc = enc
	r.Use(RequestContext())
	RegisterObservability(r, db)
	r.Use(maintenanceMiddleware(db))
	r.Use(customDomainMiddleware(db))
	api := r.Group("/api")
	api.POST("/auth/register", handleRegister(db))
	api.POST("/auth/login", handleLogin(db))
	api.GET("/auth/oauth/:provider", oauthStart(db))
	api.GET("/auth/oauth/:provider/callback", oauthCallback(db))
	api.GET("/auth/oauth/status", oauthStatus(db))
	api.POST("/billing/webhook", billingWebhook(db))
	api.POST("/auth/forgot-password", forgotPassword(db))
	api.POST("/auth/reset-password", resetPassword(db))
	api.GET("/health", requestIDHealth)
	api.GET("/public-settings", publicSettings(db))
	// Form backend publik (tanpa auth, proteksi token)
	r.POST("/f/:token", submitFormPublic(db))
	// App file storage publik (tanpa auth, untuk dipakai aplikasi generated)
	r.GET("/app-files/:projectID/:name", serveAppFile(db))

	// App Cloud DB API (Dipanggil oleh web generated via window.cloudDb)
	appDB := api.Group("/app-api/:id/db")
	appDB.Use(projectAppSessionMiddleware(db))
	appDB.POST("/select", AppAPISelect(db))
	appDB.POST("/insert", AppAPIInsert(db))
	appDB.POST("/update", AppAPIUpdate(db))
	appDB.POST("/delete", AppAPIDelete(db))
	appDB.POST("/query", AppAPIQuery(db))
	// Auth bawaan untuk aplikasi generated, terisolasi per project.
	api.POST("/app-api/:id/auth/register", projectAuthRegister(db))
	api.POST("/app-api/:id/auth/login", projectAuthLogin(db))
	api.GET("/app-api/:id/auth/me", projectAuthMe(db))
	api.POST("/app-api/:id/auth/logout", projectAuthLogout(db))

	auth := api.Group("")
	auth.Use(authMiddleware(db))
	auth.GET("/me", func(c *gin.Context) {
		var u models.User
		db.First(&u, c.GetUint("userID"))
		c.JSON(200, gin.H{"user": u})
	})
	// Projects
	auth.GET("/projects", listProjects(db))
	auth.POST("/projects", createProject(db))
	auth.GET("/projects/:id", getProject(db))
	auth.PUT("/projects/:id", updateProject(db))
	auth.DELETE("/projects/:id", deleteProject(db))
	// Chat
	auth.GET("/projects/:id/chat", getChat(db))
	auth.POST("/projects/:id/chat", postChat(db))
	// Provider AI untuk pemilih per prompt di composer (tanpa key)
	auth.GET("/ai-providers", listAIProviders(db))
	// Durable AI agent runs and plan state
	auth.GET("/projects/:id/agent/runs", listAgentRuns(db))
	auth.GET("/projects/:id/agent/runs/:runId", getAgentRun(db))
	auth.PUT("/projects/:id/agent/runs/:runId", updateAgentRun(db))
	auth.POST("/projects/:id/agent/runs/:runId/cancel", cancelAgentRun(db))
	auth.PUT("/projects/:id/agent/plan", saveAgentPlan(db))
	// AI proposal accept/reject
	auth.GET("/projects/:id/proposal", getProposal(db))
	auth.POST("/projects/:id/proposal/apply", applyProposal(db))
	auth.POST("/projects/:id/proposal/reject", rejectProposal(db))
	// Versions
	auth.GET("/projects/:id/versions", listVersions(db))
	auth.GET("/projects/:id/versions/:vid/files", getVersionFiles(db))
	auth.POST("/projects/:id/versions/checkpoint", saveCheckpoint(db))
	auth.POST("/projects/:id/versions/:vid/restore", restoreVersion(db))
	// Env
	auth.GET("/projects/:id/env", listEnv(db))
	auth.POST("/projects/:id/env", saveEnv(db))
	// Project settings
	auth.GET("/projects/:id/settings", getProjectSettings(db))
	auth.GET("/projects/:id/blueprint", getProjectBlueprint(db))
	auth.PUT("/projects/:id/blueprint", saveProjectBlueprint(db))
	auth.PUT("/projects/:id/settings", updateProjectSettings(db))
	auth.POST("/projects/:id/share", createShareLink(db))
	auth.DELETE("/projects/:id/share", deleteShareLink(db))
	// AI image generation
	auth.POST("/ai/image", handleGenerateImage(db))
	// GitHub sync
	auth.GET("/github", getGitHubConfig(db))
	auth.PUT("/github", setGitHubConfig(db))
	auth.POST("/projects/:id/github/push", githubPush(db))
	auth.POST("/projects/:id/github/pull", githubPull(db))
	// Publish
	auth.POST("/projects/:id/publish", publishProject(db))
	auth.GET("/projects/:id/security-scan", getSecurityScan(db))
	auth.POST("/projects/:id/security-scan", runSecurityScan(db))
	auth.POST("/deployments/:id/rollback", rollbackDeployment(db))
	// Platform
	auth.GET("/templates", listTemplates(db))
	auth.POST("/templates", publishTemplate(db))
	auth.DELETE("/templates/:id", deleteTemplate(db))
	auth.POST("/templates/:id/use", useTemplate(db))
	auth.GET("/deployments", listDeployments(db))
	auth.GET("/domains", listDomains(db))
	auth.POST("/domains", addDomain(db))
	auth.DELETE("/domains/:id", deleteDomain(db))
	auth.POST("/domains/:id/verify", verifyDomain(db))
	auth.GET("/domains/:id/dns", domainDNSGuide(db))
	auth.POST("/domains/:id/ssl", requestDomainSSL(db))
	auth.GET("/usage", getUsage(db))
	auth.GET("/billing", getBilling(db))
	auth.PUT("/me", updateProfile(db))
	auth.PUT("/me/password", changePassword(db))
	auth.GET("/admin/ai-config", getAIConfig(db))
	auth.PUT("/admin/ai-config", setAIConfig(db))
	auth.POST("/admin/ai-config/test", testAIConfig(db))
	auth.GET("/admin/ai-models", listAIModels(db))
	// Provider AI per prompt (admin kelola; lihat aiproviders.go)
	auth.GET("/admin/ai-providers", listAdminAIProviders(db))
	auth.POST("/admin/ai-providers", createAIProvider(db))
	auth.PUT("/admin/ai-providers/:id", updateAIProvider(db))
	auth.DELETE("/admin/ai-providers/:id", deleteAIProvider(db))
	auth.POST("/admin/ai-providers/:id/fetch-models", fetchAIProviderModels(db))
	auth.POST("/admin/ai-providers/:id/test", testAIProvider(db))
	// Admin panel
	admin := auth.Group("/admin")
	admin.Use(adminOnly(db))
	admin.GET("/stats", adminStats(db))
	admin.GET("/users", adminListUsers(db))
	admin.PUT("/users/:id", adminUpdateUser(db))
	admin.POST("/users/:id/plan", adminUpdateUserPlan(db))
	admin.POST("/users/:id/impersonate", impersonateUser(db))
	admin.POST("/broadcast", adminBroadcastNotification(db))
	admin.POST("/maintenance", adminToggleMaintenance(db))
	admin.GET("/export/users", adminExportUsersCSV(db))
	admin.GET("/export/revenue", adminExportRevenueCSV(db))
	admin.GET("/revenue", adminRevenue(db))
	admin.GET("/audit", adminAuditLog(db))
	admin.GET("/templates", adminListTemplates(db))
	admin.POST("/templates", adminSaveTemplate(db))
	admin.DELETE("/templates/:id", adminDeleteTemplate(db))
	admin.GET("/settings", adminGetSettings(db))
	admin.PUT("/settings", adminSaveSettings(db))
	admin.GET("/blocked", adminListBlocked(db))
	admin.POST("/blocked", adminAddBlocked(db))
	admin.DELETE("/blocked/:id", adminDeleteBlocked(db))
	admin.GET("/ai-usage", adminAIUsage(db))
	admin.PUT("/templates/:id", adminToggleFeatured(db))
	// Notifikasi
	auth.GET("/notifications", listNotifications(db))
	auth.POST("/notifications/read", readNotifications(db))
	// Kolaborasi
	auth.GET("/projects/:id/members", listMembers(db))
	auth.POST("/projects/:id/members", addMember(db))
	auth.DELETE("/projects/:id/members/:mid", removeMember(db))
	// API key pribadi
	auth.GET("/api-keys", listAPIKeys(db))
	auth.POST("/api-keys", createAPIKey(db))
	auth.DELETE("/api-keys/:id", deleteAPIKey(db))
	// Webhook
	auth.GET("/projects/:id/webhooks", listWebhooks(db))
	auth.POST("/projects/:id/webhooks", addWebhook(db))
	auth.DELETE("/projects/:id/webhooks/:wid", deleteWebhook(db))
	// Visitor stats
	auth.GET("/projects/:id/stats", projectStats(db))
	// Komentar file
	auth.GET("/projects/:id/comments", listComments(db))
	auth.POST("/projects/:id/comments", addComment(db))
	// Form backend
	auth.GET("/projects/:id/forms", listFormSubmissions(db))
	auth.DELETE("/projects/:id/forms/:sid", deleteFormSubmission(db))
	auth.GET("/projects/:id/form-settings", getFormSettings(db))
	auth.PUT("/projects/:id/form-settings", updateFormSettings(db))
	// App file storage untuk aplikasi generated (owner/editor)
	auth.POST("/projects/:id/app/files", uploadAppFile(db))
	auth.GET("/projects/:id/app/files", listAppFiles(db))
	auth.DELETE("/projects/:id/app/files/:name", deleteAppFile(db))
	// App cron jobs (owner/editor kelola, viewer boleh lihat)
	auth.GET("/projects/:id/app/cron", listAppCronJobs(db))
	auth.POST("/projects/:id/app/cron", createAppCronJob(db))
	auth.PUT("/projects/:id/app/cron/:jobId", updateAppCronJob(db))
	auth.DELETE("/projects/:id/app/cron/:jobId", deleteAppCronJob(db))
	// SEO per project (terpisah dari /settings)
	auth.GET("/projects/:id/seo", getProjectSEO(db))
	auth.PUT("/projects/:id/seo", updateProjectSEO(db))
	// Preview per deployment
	auth.GET("/projects/:id/deployments", listProjectDeployments(db))
	auth.GET("/projects/:id/deployments/:depId/preview/*filepath", previewDeploymentFile(db))
	auth.GET("/projects/:id/deployments/:depId/files", deploymentFiles(db))
	auth.POST("/projects/:id/comments/:cid/resolve", resolveComment(db))
	auth.DELETE("/projects/:id/comments/:cid", deleteComment(db))
	// Billing
	auth.POST("/billing/checkout", checkoutPlan(db))
	auth.GET("/billing/status/:orderId", paymentStatus(db))
	// 2FA
	auth.GET("/me/2fa", totpStatus(db))
	auth.POST("/me/2fa/setup", totpSetup(db))
	auth.POST("/me/2fa/verify", totpVerify(db))
	auth.POST("/me/2fa/disable", totpDisable(db))
	auth.POST("/ai/enhance", enhancePrompt(db))
	auth.POST("/upload", uploadFile(db))
	// Health & docs
	auth.GET("/projects/:id/health", projectHealth(db))
	auth.GET("/projects/:id/api-docs", projectApiDocs(db))
	auth.GET("/projects/:id/smoke-test", projectSmokeTest(db))
	// Project runtime: install dependencies and run a bounded production build.
	auth.GET("/projects/:id/runtime/info", runtimeInfo(db))
	auth.GET("/projects/:id/runtime/matrix", runtimeFrameworkMatrix(db))
	auth.POST("/projects/:id/runtime/install", runtimeInstall(db))
	auth.POST("/projects/:id/runtime/build", runtimeBuild(db))
	auth.POST("/projects/:id/runtime/pipeline", runtimePipeline(db))
	auth.POST("/projects/:id/runtime/verify", runtimeVerify(db))
	auth.POST("/projects/:id/runtime/db-verify", runtimeDBVerify(db))
	auth.POST("/projects/:id/runtime/dev/start", runtimeDevStart(db))
	auth.POST("/projects/:id/runtime/dev/stop", runtimeDevStop(db))
	auth.POST("/projects/:id/runtime/dev/sync", runtimeDevSync(db))
	auth.GET("/projects/:id/runtime/dev/status", runtimeDevStatus(db))
	auth.GET("/projects/:id/runtime/dev/logs", runtimeDevLogs(db))
	auth.GET("/projects/:id/runtime/dev/log-stream", runtimeDevLogStream(db))
	auth.POST("/projects/:id/runtime/screenshot", runtimeCaptureScreenshot(db))
	auth.GET("/projects/:id/runtime/screenshots/:name", runtimeScreenshotFile(db))
	auth.GET("/projects/:id/runtime/screenshots/verification/:runId/:name", runtimeVerificationScreenshotFile(db))
	auth.Any("/projects/:id/runtime/preview/*filepath", runtimeDevPreview(db))
	// AI-generated database migrations with explicit up/down SQL and rollback.
	auth.GET("/projects/:id/migrations", listMigrations(db))
	auth.POST("/projects/:id/migrations", applyMigration(db))
	auth.POST("/projects/:id/migrations/:mid/rollback", rollbackMigration(db))
	auth.GET("/projects/:id/export", exportProjectZip(db))
	// DB tables
	auth.GET("/projects/:id/tables", listAppTables(db))
	auth.GET("/projects/:id/policies", listAppPolicies(db))
	auth.POST("/projects/:id/policies", upsertAppPolicy(db))
	auth.GET("/projects/:id/tables/:name", inspectAppTable(db))
	auth.POST("/projects/:id/tables/:name/rows", insertAppRow(db))
	auth.PATCH("/projects/:id/tables/:name/rows/:rowId", updateAppRow(db))
	auth.DELETE("/projects/:id/tables/:name/rows/:rowId", deleteAppRow(db))
	auth.POST("/projects/:id/tables", createAppTable(db))
	auth.POST("/projects/:id/tables/:name/columns", addTableColumn(db))
	auth.DELETE("/projects/:id/tables/:name", dropAppTable(db))
	// Import
	auth.POST("/projects/import-github", importGithubRepo(db))
	// File tree operations
	auth.GET("/projects/:id/files", getProjectFiles(db))
	auth.POST("/projects/:id/files", createFile(db))
	auth.DELETE("/projects/:id/files", deleteFile(db))
	auth.POST("/projects/:id/files/rename", renameFile(db))
}

// ── Auth ──

func jwtSecret() []byte { return []byte(os.Getenv("JWT_SECRET")) }

func makeToken(uid uint) string {
	t := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{"uid": uid, "exp": time.Now().Add(30 * 24 * time.Hour).Unix()})
	s, _ := t.SignedString(jwtSecret())
	return s
}

func authMiddleware(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		h := c.GetHeader("Authorization")
		tok := strings.TrimPrefix(h, "Bearer ")
		// Runtime preview is rendered inside an iframe, which cannot attach
		// the builder Authorization header. Accept the same JWT as a query
		// token only for authenticated routes; the token is still validated below.
		if tok == "" {
			tok = c.Query("token")
		}
		// Preview grants are short-lived and only valid for the preview proxy.
		if strings.HasPrefix(tok, "pv_") && strings.Contains(c.Request.URL.Path, "/runtime/preview/") {
			grant, ok := getRuntimePreviewGrant(tok)
			if !ok {
				c.JSON(401, gin.H{"message": "Preview token tidak valid atau kedaluwarsa"})
				c.Abort()
				return
			}
			c.Set("userID", grant.UserID)
			c.Next()
			return
		}
		// API key pribadi (wb_...)
		if strings.HasPrefix(tok, "wb_") {
			var k models.UserAPIKey
			if err := db.Where("key_hash = ?", sha256Hex(tok)).First(&k).Error; err == nil {
				db.Model(&k).Update("last_used", time.Now())
				c.Set("userID", k.UserID)
				c.Next()
				return
			}
			c.JSON(401, gin.H{"message": "API key tidak valid"})
			c.Abort()
			return
		}
		t, err := jwt.Parse(tok, func(t *jwt.Token) (interface{}, error) { return jwtSecret(), nil })
		if err != nil || !t.Valid {
			c.JSON(401, gin.H{"message": "Sesi berakhir, login lagi"})
			c.Abort()
			return
		}
		claims, ok := t.Claims.(jwt.MapClaims)
		if !ok {
			c.JSON(401, gin.H{"message": "Token tidak valid"})
			c.Abort()
			return
		}
		rawUID, ok := claims["uid"].(float64)
		if !ok || rawUID <= 0 || rawUID != float64(uint(rawUID)) {
			c.JSON(401, gin.H{"message": "Token tidak valid"})
			c.Abort()
			return
		}
		c.Set("userID", uint(rawUID))
		c.Next()
	}
}

func handleRegister(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Name     string `json:"name" binding:"required"`
			Email    string `json:"email" binding:"required,email"`
			Password string `json:"password" binding:"required,min=6"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(400, gin.H{"message": "Data tidak valid"})
			return
		}
		var n int64
		db.Model(&models.User{}).Where("email = ?", req.Email).Count(&n)
		if n > 0 {
			c.JSON(409, gin.H{"message": "Email sudah terdaftar"})
			return
		}
		hash, _ := bcrypt.GenerateFromPassword([]byte(req.Password), 12)
		u := models.User{Name: req.Name, Email: req.Email, Password: string(hash), ReferralCode: "WB" + randHex(6)}
		db.Create(&u)
		c.JSON(201, gin.H{"token": makeToken(u.ID), "user": u})
	}
}

func handleLogin(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Email    string `json:"email" binding:"required,email"`
			Password string `json:"password" binding:"required"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(400, gin.H{"message": "Data tidak valid"})
			return
		}
		if !checkLoginAllowed(c, req.Email) {
			c.JSON(429, gin.H{"message": "Terlalu banyak percobaan. Coba lagi 15 menit."})
			return
		}
		var u models.User
		if err := db.Where("email = ?", req.Email).First(&u).Error; err != nil {
			recordLoginFail(c, req.Email)
			c.JSON(401, gin.H{"message": "Email/password salah"})
			return
		}
		if err := bcrypt.CompareHashAndPassword([]byte(u.Password), []byte(req.Password)); err != nil {
			recordLoginFail(c, req.Email)
			c.JSON(401, gin.H{"message": "Email/password salah"})
			return
		}
		if u.Suspended {
			c.JSON(403, gin.H{"message": "Akun ditangguhkan. Hubungi admin."})
			return
		}
		// 2FA check
		var totp models.UserTOTP
		if err := db.Where("user_id = ? AND enabled = ?", u.ID, true).First(&totp).Error; err == nil {
			if reqOTP := c.GetHeader("X-OTP"); reqOTP == "" {
				c.JSON(402, gin.H{"message": "OTP diperlukan", "needOTP": true})
				return
			} else if !verifyTOTP(totp.Secret, reqOTP) {
				c.JSON(401, gin.H{"message": "OTP salah"})
				return
			}
		}
		recordLoginSuccess(c, req.Email)
		audit(db, u.ID, "login", "login sukses", c.ClientIP())
		c.JSON(200, gin.H{"token": makeToken(u.ID), "user": u})
	}
}

// ── Google OAuth ──

func googleOAuthURL() gin.HandlerFunc {
	return func(c *gin.Context) {
		id := strings.TrimSpace(os.Getenv("GOOGLE_CLIENT_ID"))
		if id == "" {
			c.JSON(500, gin.H{"message": "Google OAuth belum dikonfigurasi admin"})
			return
		}
		base := strings.TrimRight(os.Getenv("PUBLIC_URL"), "/")
		if base == "" {
			base = "https://build.clipku.my.id"
		}
		u := "https://accounts.google.com/o/oauth2/v2/auth?client_id=" + id +
			"&redirect_uri=" + base + "/api/auth/google/callback" +
			"&response_type=code&scope=openid%20email%20profile"
		c.JSON(200, gin.H{"url": u})
	}
}

func googleOAuthCallback(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		code := c.Query("code")
		if code == "" {
			c.Redirect(302, "/login?oauth=error")
			return
		}
		// Exchange code for token (simplified)
		c.Redirect(302, "/login?oauth=error&msg="+fmt.Sprintf("code:%s", code[:8]))
	}
}

// ── GitHub OAuth ──

func githubOAuthURL() gin.HandlerFunc {
	return func(c *gin.Context) {
		id := strings.TrimSpace(os.Getenv("GITHUB_CLIENT_ID"))
		if id == "" {
			c.JSON(500, gin.H{"message": "GitHub OAuth belum dikonfigurasi admin"})
			return
		}
		base := strings.TrimRight(os.Getenv("PUBLIC_URL"), "/")
		if base == "" {
			base = "https://build.clipku.my.id"
		}
		u := "https://github.com/login/oauth/authorize?client_id=" + id +
			"&redirect_uri=" + base + "/api/auth/github/callback&scope=user:email"
		c.JSON(200, gin.H{"url": u})
	}
}

func githubOAuthCallback(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		code := c.Query("code")
		if code == "" {
			c.Redirect(302, "/login?oauth=error")
			return
		}
		c.Redirect(302, "/login?oauth=github&code="+code[:8])
	}
}

// ── Forgot / Reset Password ──

func forgotPassword(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Email string `json:"email" binding:"required,email"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(400, gin.H{"message": "Email tidak valid"})
			return
		}
		var u models.User
		if err := db.Where("email = ?", req.Email).First(&u).Error; err != nil {
			// Jangan bocorkan apakah email terdaftar
			c.JSON(200, gin.H{"message": "Jika email terdaftar, link reset telah dikirim"})
			return
		}
		token := randHex(32)
		db.Create(&models.PasswordReset{
			UserID: u.ID, Token: token,
			ExpiresAt: time.Now().Add(30 * time.Minute),
		})
		// Kirim via SMTP jika dikonfigurasi, fallback ke log
		if err := sendMail(db, u.Email, "Reset Password WebBuilder",
			"Klik link berikut untuk reset password (berlaku 30 menit):\n\n"+siteBaseURL(db)+"/reset?token="+token); err != nil {
			fmt.Printf("[RESET] %s -> token %s (email gagal: %v)\n", u.Email, token, err)
		}
		c.JSON(200, gin.H{"message": "Jika email terdaftar, link reset telah dikirim"})
	}
}

func resetPassword(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Token string `json:"token" binding:"required"`
			New   string `json:"new" binding:"required,min=6"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(400, gin.H{"message": "Data tidak valid"})
			return
		}
		var pr models.PasswordReset
		if err := db.Where("token = ? AND used = ?", req.Token, false).First(&pr).Error; err != nil {
			c.JSON(400, gin.H{"message": "Token tidak valid"})
			return
		}
		if time.Now().After(pr.ExpiresAt) {
			c.JSON(400, gin.H{"message": "Token kedaluwarsa"})
			return
		}
		hash, _ := bcrypt.GenerateFromPassword([]byte(req.New), 12)
		db.Model(&models.User{}).Where("id = ?", pr.UserID).Update("password", string(hash))
		db.Model(&pr).Update("used", true)
		c.JSON(200, gin.H{"message": "Password berhasil direset"})
	}
}

var _ = http.StatusOK

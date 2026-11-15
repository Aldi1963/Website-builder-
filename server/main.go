package main

import (
	"log"
	"os"
	"strings"

	"webbuilder/internal/database/models"
	"webbuilder/internal/handler"

	"github.com/gin-gonic/gin"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func main() {
	os.MkdirAll("../data", 0755)
	// JWT secret wajib dari file/env, tolak start tanpa secret
	secret := os.Getenv("JWT_SECRET")
	if secret == "" {
		if b, err := os.ReadFile("../.jwt-secret"); err == nil {
			secret = strings.TrimSpace(string(b))
		}
	}
	if secret == "" {
		log.Fatal("JWT_SECRET tidak diset — server menolak start")
	}
	os.Setenv("JWT_SECRET", secret)

	db, err := gorm.Open(sqlite.Open("../data/webbuilder.db"), &gorm.Config{})
	if err != nil {
		log.Fatal(err)
	}
	db.AutoMigrate(&models.User{}, &models.Project{}, &models.ChatSession{},
		&models.ChatMessage{}, &models.ProjectVersion{}, &models.ProjectMigration{}, &models.ProjectEnv{}, &models.AIUsage{}, &models.AgentRun{}, &models.AgentToolCall{}, &models.AgentContext{},
		&models.Template{}, &models.Deployment{}, &models.Domain{}, &models.AIConfig{},
		&models.PasswordReset{}, &models.GitHubConfig{}, &models.AuditLog{},
		&models.PlatformSetting{}, &models.Notification{}, &models.ProjectMember{},
		&models.UserAPIKey{}, &models.ProjectWebhook{}, &models.VisitStat{},
		&models.BlockedWord{}, &models.UserTOTP{}, &models.AIProposal{}, &models.AgentRun{}, &models.AgentToolCall{}, &models.FileComment{}, &models.Subscription{}, &models.Payment{},
		&models.FormSubmission{}, &models.AppFile{}, &models.AppCronJob{})

	r := gin.Default()
	handler.RegisterRoutes(r, db)
	go handler.StartCronRunner(db)

	// Public published projects
	r.GET("/pub/:slug", handler.ServePublished(db))
	r.GET("/pub-assets/:slug/*filepath", handler.ServePublishedAsset(db))
	r.GET("/share/:token", handler.ServeShared(db))
	r.GET("/share-assets/:token/:filepath", handler.ServeSharedAsset(db))

	// Serve frontend — index.html tidak di-cache agar deploy baru langsung tampil
	serveIndex := func(c *gin.Context) {
		c.Header("Cache-Control", "no-cache, no-store, must-revalidate")
		c.File("../server/web/dist/index.html")
	}
	r.Static("/assets", "../server/web/dist/assets")
	r.GET("/", serveIndex)
	r.NoRoute(func(c *gin.Context) {
		serveIndex(c)
	})

	log.Println("WebBuilder running on :18082")
	r.Run("127.0.0.1:18082")
}

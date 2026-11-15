package main

import (
	"context"
	"log"
	"log/slog"
	"os"

	"webbuilder/internal/config"
	"webbuilder/internal/database"
	"webbuilder/internal/handler"
	"webbuilder/internal/observability"

	"github.com/gin-gonic/gin"
)

func main() {
	os.MkdirAll("../data", 0755)
	// Structured logging: semua log aplikasi menjadi JSON via slog.
	observability.SetDefault(observability.NewLogger(os.Stdout, slog.LevelInfo))
	slog.SetDefault(observability.Default())

	// Validasi konfigurasi fail-fast: JWT_SECRET wajib (env atau
	// ../.jwt-secret); sisanya hanya peringatan, perilaku tidak berubah.
	cfg, warnings, err := config.Load()
	if err != nil {
		log.Fatal(err)
	}
	for _, w := range warnings {
		log.Println("[config]", w)
	}
	os.Setenv("JWT_SECRET", cfg.JWTSecret)
	log.Println("[config]", cfg.Summary())

	// DATABASE_URL kosong -> SQLite default (../data/webbuilder.db) + AutoMigrate.
	// DATABASE_URL postgres://... -> Postgres + migrasi berversi goose.
	// Lihat server/internal/database dan docs/database.md.
	db, driver, err := database.Open()
	if err != nil {
		log.Fatal(err)
	}
	if err := database.Migrate(context.Background(), db, driver); err != nil {
		log.Fatal(err)
	}

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

package main

import (
	"context"
	"log"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

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

	// Queue agent (durable): backend "db" (default) memakai tabel queue_jobs
	// di DB yang sama — dibuat otomatis untuk SQLite, wajib sudah ada
	// (migrasi goose 00002) untuk Postgres. Init gagal -> fail-start
	// (TANPA fallback diam-diam ke in-memory). Lihat docs/queue.md.
	mgr, err := handler.InitAgentQueue(db, cfg)
	if err != nil {
		log.Fatal(err)
	}
	// Consumer queue: N goroutine menjalankan job agent (pipeline chat/SSE).
	// Berhenti lebih dulu saat shutdown supaya tidak ada job baru yang
	// diambil sesudah server berhenti menerima request.
	queueCtx, queueStop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	for i := 0; i < cfg.QueueWorkers; i++ {
		go mgr.Run(queueCtx, handler.AgentJobHandler(db))
	}
	log.Printf("[queue] backend=%s workers=%d", cfg.QueueBackend, cfg.QueueWorkers)

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

	// Port listen (default 18082; override via PORT agar bisa jalan
	// berdampingan dengan layanan lain, mis. saat uji coba).
	port := strings.TrimSpace(os.Getenv("PORT"))
	if port == "" {
		port = "18082"
	}
	log.Println("WebBuilder running on :" + port)
	srv := &http.Server{Addr: "127.0.0.1:" + port, Handler: r}
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}()
	// Tunggu sinyal berhenti, lalu: hentikan consumer queue dulu (job yang
	// sedang berjalan dibatalkan lewat queueCtx; job pending/running yang
	// tertinggal diambil alih consumer sesudah restart lewat lease
	// takeover), baru matikan HTTP server (maks 30 detik).
	<-queueCtx.Done()
	queueStop()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Println("[shutdown] HTTP shutdown:", err)
	}
	log.Println("WebBuilder stopped")
}

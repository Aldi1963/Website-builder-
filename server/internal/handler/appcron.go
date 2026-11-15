package handler

import (
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/robfig/cron/v3"
	"gorm.io/gorm"

	"webbuilder/internal/database/models"
)

// ── App cron jobs ──
// Penjadwalan HTTP call milik aplikasi hasil generate (ala Supabase cron).
// CRUD: owner/editor project. Runner: goroutine tiap 60 detik.

var cronParser = cron.NewParser(cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow)

var cronMethods = map[string]bool{
	"GET": true, "POST": true, "PUT": true, "PATCH": true, "DELETE": true, "HEAD": true,
}

func validCronSchedule(s string) bool {
	_, err := cronParser.Parse(strings.TrimSpace(s))
	return err == nil
}

func validCronURL(u string) bool {
	parsed, err := url.Parse(strings.TrimSpace(u))
	if err != nil {
		return false
	}
	return parsed.Scheme == "http" || parsed.Scheme == "https"
}

// GET /api/projects/:id/app/cron — list (viewer)
func listAppCronJobs(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, _, ok := requireProject(db, c, "viewer")
		if !ok {
			return
		}
		var jobs []models.AppCronJob
		db.Where("project_id = ?", p.ID).Order("id ASC").Find(&jobs)
		c.JSON(200, gin.H{"items": jobs})
	}
}

// POST /api/projects/:id/app/cron — buat (editor)
func createAppCronJob(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, _, ok := requireProject(db, c, "editor")
		if !ok {
			return
		}
		var req struct {
			Name     string `json:"name" binding:"required"`
			Schedule string `json:"schedule" binding:"required"`
			URL      string `json:"url" binding:"required"`
			Method   string `json:"method"`
			Active   *bool  `json:"active"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(400, gin.H{"message": "Data tidak valid"})
			return
		}
		if !validCronSchedule(req.Schedule) {
			c.JSON(400, gin.H{"message": "Format schedule tidak valid (contoh: */5 * * * *)"})
			return
		}
		if !validCronURL(req.URL) {
			c.JSON(400, gin.H{"message": "URL harus http:// atau https://"})
			return
		}
		method := strings.ToUpper(strings.TrimSpace(req.Method))
		if method == "" {
			method = "GET"
		}
		if !cronMethods[method] {
			c.JSON(400, gin.H{"message": "Method tidak didukung"})
			return
		}
		active := true
		if req.Active != nil {
			active = *req.Active
		}
		job := models.AppCronJob{
			ProjectID: p.ID, Name: strings.TrimSpace(req.Name),
			Schedule: strings.TrimSpace(req.Schedule), URL: strings.TrimSpace(req.URL),
			Method: method, Active: active,
		}
		db.Create(&job)
		c.JSON(201, gin.H{"job": job})
	}
}

// PUT /api/projects/:id/app/cron/:jobId — ubah (editor)
func updateAppCronJob(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, _, ok := requireProject(db, c, "editor")
		if !ok {
			return
		}
		var job models.AppCronJob
		if err := db.Where("id = ? AND project_id = ?", c.Param("jobId"), p.ID).First(&job).Error; err != nil {
			c.JSON(404, gin.H{"message": "Cron job tidak ditemukan"})
			return
		}
		var req struct {
			Name     *string `json:"name"`
			Schedule *string `json:"schedule"`
			URL      *string `json:"url"`
			Method   *string `json:"method"`
			Active   *bool   `json:"active"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(400, gin.H{"message": "Data tidak valid"})
			return
		}
		updates := map[string]interface{}{}
		if req.Name != nil {
			updates["name"] = strings.TrimSpace(*req.Name)
		}
		if req.Schedule != nil {
			if !validCronSchedule(*req.Schedule) {
				c.JSON(400, gin.H{"message": "Format schedule tidak valid (contoh: */5 * * * *)"})
				return
			}
			updates["schedule"] = strings.TrimSpace(*req.Schedule)
		}
		if req.URL != nil {
			if !validCronURL(*req.URL) {
				c.JSON(400, gin.H{"message": "URL harus http:// atau https://"})
				return
			}
			updates["url"] = strings.TrimSpace(*req.URL)
		}
		if req.Method != nil {
			m := strings.ToUpper(strings.TrimSpace(*req.Method))
			if !cronMethods[m] {
				c.JSON(400, gin.H{"message": "Method tidak didukung"})
				return
			}
			updates["method"] = m
		}
		if req.Active != nil {
			updates["active"] = *req.Active
		}
		if len(updates) > 0 {
			db.Model(&job).Updates(updates)
		}
		db.First(&job, job.ID)
		c.JSON(200, gin.H{"job": job})
	}
}

// DELETE /api/projects/:id/app/cron/:jobId — hapus (editor)
func deleteAppCronJob(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, _, ok := requireProject(db, c, "editor")
		if !ok {
			return
		}
		var job models.AppCronJob
		if err := db.Where("id = ? AND project_id = ?", c.Param("jobId"), p.ID).First(&job).Error; err != nil {
			c.JSON(404, gin.H{"message": "Cron job tidak ditemukan"})
			return
		}
		db.Delete(&job)
		c.JSON(200, gin.H{"message": "Cron job dihapus"})
	}
}

// ── Runner ──

// StartCronRunner menjalankan loop pengecekan tiap 60 detik di goroutine
// sendiri. Dipanggil sekali dari main.go: go handler.StartCronRunner(db).
func StartCronRunner(db *gorm.DB) {
	go func() {
		defer func() {
			if r := recover(); r != nil {
				log.Printf("[cron] runner panic: %v (restart dalam 60 dtk)", r)
				time.Sleep(60 * time.Second)
				StartCronRunner(db)
			}
		}()
		// Beri waktu server selesai start sebelum cek pertama.
		time.Sleep(10 * time.Second)
		ticker := time.NewTicker(60 * time.Second)
		defer ticker.Stop()
		for {
			checkCronJobs(db)
			<-ticker.C
		}
	}()
}

func checkCronJobs(db *gorm.DB) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[cron] check panic: %v", r)
		}
	}()
	var jobs []models.AppCronJob
	if err := db.Where("active = ?", true).Find(&jobs).Error; err != nil {
		return
	}
	now := time.Now()
	for _, job := range jobs {
		sched, err := cronParser.Parse(job.Schedule)
		if err != nil {
			continue
		}
		ref := job.CreatedAt
		if job.LastRunAt != nil {
			ref = *job.LastRunAt
		}
		if next := sched.Next(ref); !next.After(now) {
			j := job
			go func() {
				defer func() {
					if r := recover(); r != nil {
						log.Printf("[cron] job %d panic: %v", j.ID, r)
					}
				}()
				fireCronJob(db, j)
			}()
		}
	}
}

func fireCronJob(db *gorm.DB, job models.AppCronJob) {
	now := time.Now()
	// Catat LastRunAt dulu agar tidak double-fire bila request lambat.
	db.Model(&models.AppCronJob{}).Where("id = ?", job.ID).Update("last_run_at", now)
	req, err := http.NewRequest(job.Method, job.URL, nil)
	if err != nil {
		log.Printf("[cron] job %d (%s): request error: %v", job.ID, job.Name, err)
		return
	}
	req.Header.Set("User-Agent", "WebBuilder-Cron/1.0")
	client := &http.Client{Timeout: 25 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("[cron] job %d (%s): call error: %v", job.ID, job.Name, err)
		return
	}
	resp.Body.Close()
	log.Printf("[cron] job %d (%s): %s %s -> %d", job.ID, job.Name, job.Method, job.URL, resp.StatusCode)
}

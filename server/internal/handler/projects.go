package handler

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"webbuilder/internal/database/models"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// autoVersionThrottle: cegah flood versi — max 1 auto-version per proyek per 3 menit
var (
	avMu   sync.Mutex
	avLast = map[uint]time.Time{}
)

const (
	autoVersionInterval = 3 * time.Minute
	maxVersionsPerProj  = 50
)

// saveAutoVersion menyimpan snapshot otomatis jika:
// 1. Belum ada throttle aktif (3 menit sejak terakhir), DAN
// 2. Files benar-benar berubah dari versi terakhir.
// label: sumber perubahan ("Edit manual", "AI diterima", dsb.)
func saveAutoVersion(db *gorm.DB, pid uint, files string, label string) {
	avMu.Lock()
	last, ok := avLast[pid]
	if ok && time.Since(last) < autoVersionInterval {
		avMu.Unlock()
		return
	}
	avLast[pid] = time.Now()
	avMu.Unlock()

	// Skip jika sama dengan versi terakhir
	var lastVer models.ProjectVersion
	if err := db.Where("project_id = ?", pid).Order("id DESC").First(&lastVer).Error; err == nil {
		if lastVer.Files == files {
			return
		}
	}

	if label == "" {
		label = "Auto"
	}
	db.Create(&models.ProjectVersion{ProjectID: pid, Label: label, Files: files})

	// Pruning: hapus yang paling lama jika melebihi batas
	var count int64
	db.Model(&models.ProjectVersion{}).Where("project_id = ?", pid).Count(&count)
	if count > maxVersionsPerProj {
		var oldest models.ProjectVersion
		if err := db.Where("project_id = ?", pid).Order("id ASC").First(&oldest).Error; err == nil {
			db.Delete(&oldest)
		}
	}
}

func listProjects(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := c.GetUint("userID")
		var ps []models.Project
		db.Where("user_id = ?", uid).Order("updated_at DESC").Find(&ps)
		// proyek yang dishare ke user
		var ms []models.ProjectMember
		db.Where("user_id = ?", uid).Find(&ms)
		shared := []gin.H{}
		for _, m := range ms {
			var p models.Project
			if err := db.First(&p, m.ProjectID).Error; err == nil {
				var owner models.User
				db.Select("name").First(&owner, p.UserID)
				shared = append(shared, gin.H{
					"id": p.ID, "name": p.Name, "framework": p.Framework,
					"shared": true, "role": m.Role, "owner": owner.Name,
					"updatedAt": p.UpdatedAt,
				})
			}
		}
		c.JSON(200, gin.H{"projects": ps, "shared": shared})
	}
}

func createProject(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Name      string `json:"name" binding:"required"`
			Framework string `json:"framework"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(400, gin.H{"message": "Nama wajib"})
			return
		}
		// Kuota proyek per plan
		uid := c.GetUint("userID")
		plan := userPlan(db, uid)
		maxProjects, _ := planQuota(db, plan)
		var n int64
		db.Model(&models.Project{}).Where("user_id = ?", uid).Count(&n)
		if int(n) >= maxProjects {
			c.JSON(402, gin.H{
				"error":   "quota_exceeded",
				"message": "Batas proyek paket " + plan + " tercapai. Upgrade untuk menambah.",
			})
			return
		}
		// Framework dipilih AI setelah membaca prompt; endpoint hanya menyimpan
		// auto sebagai profile awal agar user tidak perlu menentukan teknologi.
		fw := "auto"
		if candidate := strings.ToLower(strings.TrimSpace(req.Framework)); candidate != "" && candidate != "auto" {
			allowed := map[string]bool{"nextjs": true, "next.js": true, "react": true, "vite": true, "express": true, "nestjs": true, "fastapi": true, "django": true, "laravel": true, "vue": true, "svelte": true}
			if allowed[candidate] { fw = candidate }
		}
		slug := makeSlug(req.Name)
		for i := 1; ; i++ {
			try := slug
			if i > 1 {
				try = slug + "-" + itoa(i)
			}
			var n int64
			db.Model(&models.Project{}).Where("slug = ?", try).Count(&n)
			if n == 0 {
				slug = try
				break
			}
		}
		initialFiles := map[string]string{
			"README.md": fmt.Sprintf(`# %s

Project generated with WebBuilder.

## Menjalankan lokal

    npm install
    npm run dev

## Build production

    npm run build

## Struktur utama

- public/: aset statis
- src/components/: komponen reusable
- src/pages/: halaman aplikasi
- src/services/: integrasi API/database
- src/hooks/: custom hooks
- src/utils/: helper
- src/App.tsx: root component
- src/main.tsx: entry point

Jangan commit secret atau API key.
`, req.Name),
		}
		initialJSON, _ := json.Marshal(initialFiles)
		p := models.Project{UserID: c.GetUint("userID"), Name: req.Name, Slug: slug, Framework: fw, Files: string(initialJSON), FormToken: newFormToken(), FormEnabled: true}
		db.Create(&p)
		c.JSON(201, gin.H{"project": p})
	}
}

func getProject(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, role, ok := requireProject(db, c, "viewer")
		if !ok {
			return
		}
		c.JSON(200, gin.H{"project": p, "role": role})
	}
}

// GET /api/projects/:id/files — daftar file terurai (map path->content).
// Rute ini sebelumnya tidak ada sehingga klien menerima HTML SPA dan gagal
// mem-parse JSON; akibatnya tab Code kosong dan perbandingan versi selalu
// menganggap semua file berbeda.
func getProjectFiles(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, _, ok := requireProject(db, c, "viewer")
		if !ok {
			return
		}
		files := map[string]string{}
		if p.Files != "" {
			_ = json.Unmarshal([]byte(p.Files), &files)
		}
		c.JSON(200, gin.H{"files": files, "count": len(files)})
	}
}

func updateProject(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, _, ok := requireProject(db, c, "editor")
		if !ok {
			return
		}
		var req struct {
			Name  string `json:"name"`
			Files string `json:"files"`
		}
		c.ShouldBindJSON(&req)
		if req.Name != "" {
			p.Name = req.Name
		}
		if req.Files != "" {
			p.Files = req.Files
			p.Published = false
			p.PublishState = "stale"
			p.BuildStatus = "dirty"
			p.BuildError = ""
		}
		db.Save(&p)
		// Auto version dengan throttle + dedup
		if req.Files != "" {
			go saveAutoVersion(db, p.ID, p.Files, "Edit manual")
		}
		c.JSON(200, gin.H{"project": p})
	}
}

func deleteProject(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		pid := c.Param("id")
		var p models.Project
		if err := db.Where("id = ? AND user_id = ?", pid, c.GetUint("userID")).First(&p).Error; err != nil {
			c.JSON(404, gin.H{"message": "Tidak ditemukan"})
			return
		}
		// cascade cleanup: schema PG + record terkait
		dropAppSchema(pid)
		db.Where("project_id = ?", pid).Delete(&models.ChatSession{})
		db.Where("project_id = ?", pid).Delete(&models.ChatMessage{})
		db.Where("project_id = ?", pid).Delete(&models.ProjectVersion{})
		db.Where("project_id = ?", pid).Delete(&models.ProjectEnv{})
		db.Where("project_id = ?", pid).Delete(&models.Deployment{})
		db.Where("project_id = ?", pid).Delete(&models.FormSubmission{})
		db.Delete(&p)
		c.JSON(200, gin.H{"message": "Dihapus"})
	}
}

func makeSlug(name string) string {
	s := strings.ToLower(strings.TrimSpace(name))
	var b strings.Builder
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		} else if r == ' ' || r == '-' || r == '_' {
			b.WriteRune('-')
		}
	}
	slug := b.String()
	if slug == "" {
		slug = "proyek"
	}
	return slug
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b [16]byte
	pos := len(b)
	for i > 0 {
		pos--
		b[pos] = byte('0' + i%10)
		i /= 10
	}
	return string(b[pos:])
}

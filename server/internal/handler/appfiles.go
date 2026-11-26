package handler

import (
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"webbuilder/internal/database/models"
)

// ── App file storage ──
// File publik untuk dipakai aplikasi hasil generate (gambar, dokumen, dll).
// Upload/list/hapus: owner/editor project. Serve: publik tanpa auth.

const appFileMaxSize = 10 << 20 // 10MB

func appFileDir(projectID uint) string {
	return filepath.Join("..", "data", "appfiles", strconv.FormatUint(uint64(projectID), 10))
}

// sanitizeFileName: ambil basename, buang karakter berbahaya.
func sanitizeFileName(name string) string {
	name = filepath.Base(name)
	name = strings.ReplaceAll(name, "\x00", "")
	if name == "" || name == "." || name == ".." {
		return "file"
	}
	if len(name) > 120 {
		ext := filepath.Ext(name)
		name = name[:120-len(ext)] + ext
	}
	return name
}

// POST /api/projects/:id/app/files — upload multipart field "file" (editor)
func uploadAppFile(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, _, ok := requireProject(db, c, "editor")
		if !ok {
			return
		}
		fh, err := c.FormFile("file")
		if err != nil {
			c.JSON(400, gin.H{"message": "Field file wajib diisi"})
			return
		}
		if fh.Size > appFileMaxSize {
			c.JSON(400, gin.H{"message": "Ukuran file maksimal 10MB"})
			return
		}
		if fh.Size <= 0 {
			c.JSON(400, gin.H{"message": "File kosong"})
			return
		}
		dir := appFileDir(p.ID)
		if err := os.MkdirAll(dir, 0755); err != nil {
			c.JSON(500, gin.H{"message": "Gagal menyimpan file"})
			return
		}
		stored := randHex(8) + "_" + sanitizeFileName(fh.Filename)
		dst := filepath.Join(dir, stored)
		if err := c.SaveUploadedFile(fh, dst); err != nil {
			c.JSON(500, gin.H{"message": "Gagal menyimpan file"})
			return
		}
		rec := models.AppFile{ProjectID: p.ID, Name: stored, Path: dst, Size: fh.Size}
		db.Create(&rec)
		c.JSON(201, gin.H{
			"url":  "/app-files/" + c.Param("id") + "/" + stored,
			"name": stored, "size": fh.Size,
		})
	}
}

// GET /api/projects/:id/app/files — list metadata (editor)
func listAppFiles(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, _, ok := requireProject(db, c, "editor")
		if !ok {
			return
		}
		var files []models.AppFile
		db.Where("project_id = ?", p.ID).Order("id DESC").Find(&files)
		items := make([]gin.H, 0, len(files))
		for _, f := range files {
			items = append(items, gin.H{
				"id": f.ID, "name": f.Name,
				"url":  "/app-files/" + c.Param("id") + "/" + f.Name,
				"size": f.Size, "createdAt": f.CreatedAt,
			})
		}
		c.JSON(200, gin.H{"items": items})
	}
}

// DELETE /api/projects/:id/app/files/:name — hapus file (editor)
func deleteAppFile(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, _, ok := requireProject(db, c, "editor")
		if !ok {
			return
		}
		name := c.Param("name")
		if filepath.Base(name) != name || strings.Contains(name, "..") {
			c.JSON(400, gin.H{"message": "Nama file tidak valid"})
			return
		}
		var f models.AppFile
		if err := db.Where("project_id = ? AND name = ?", p.ID, name).First(&f).Error; err != nil {
			c.JSON(404, gin.H{"message": "File tidak ditemukan"})
			return
		}
		os.Remove(f.Path)
		db.Delete(&f)
		c.JSON(200, gin.H{"message": "File dihapus"})
	}
}

// GET /app-files/:projectID/:name — serve publik tanpa auth.
// Anti path-traversal: nama harus basename murni dan cocok dengan record DB.
func serveAppFile(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		pid := c.Param("projectID")
		name := c.Param("name")
		if filepath.Base(name) != name || strings.Contains(name, "..") || name == "" {
			c.JSON(400, gin.H{"message": "Nama file tidak valid"})
			return
		}
		var f models.AppFile
		if err := db.Where("project_id = ? AND name = ?", pid, name).First(&f).Error; err != nil {
			c.JSON(404, gin.H{"message": "File tidak ditemukan"})
			return
		}
		// Pastikan path hasil resolve tetap di dalam direktori project.
		abs, err := filepath.Abs(f.Path)
		if err != nil {
			c.JSON(404, gin.H{"message": "File tidak ditemukan"})
			return
		}
		dirAbs, err := filepath.Abs(appFileDir(f.ProjectID))
		if err != nil || !strings.HasPrefix(abs, dirAbs+string(os.PathSeparator)) {
			c.JSON(403, gin.H{"message": "Akses ditolak"})
			return
		}
		c.File(abs)
	}
}

var _ = http.StatusOK

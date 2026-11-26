package handler

import (
	"encoding/base64"
	"encoding/json"
	"mime"
	"path"
	"strings"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"webbuilder/internal/database/models"
)

// ── Preview per deployment ──
// Setiap deployment menyimpan snapshot JSON files proyek (diisi recordDeployment
// di platform.go), sehingga versi lama bisa dilihat sebelum rollback.

// GET /api/projects/:id/deployments — list deployment proyek, terbaru dulu (tanpa Files)
func listProjectDeployments(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, _, ok := requireProject(db, c, "viewer")
		if !ok {
			return
		}
		var ds []models.Deployment
		db.Where("project_id = ?", p.ID).Order("id DESC").Find(&ds)
		items := make([]gin.H, 0, len(ds))
		for _, d := range ds {
			items = append(items, gin.H{
				"id": d.ID, "status": d.Status, "url": d.URL, "createdAt": d.CreatedAt,
			})
		}
		c.JSON(200, gin.H{"deployments": items})
	}
}

// GET /api/projects/:id/deployments/:depId/files — snapshot files JSON (untuk preview iframe)
func deploymentFiles(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, _, ok := requireProject(db, c, "viewer")
		if !ok {
			return
		}
		var d models.Deployment
		if err := db.Where("id = ? AND project_id = ?", c.Param("depId"), p.ID).First(&d).Error; err != nil {
			c.JSON(404, gin.H{"message": "Deployment tidak ada"})
			return
		}
		var files map[string]string
		json.Unmarshal([]byte(d.Files), &files)
		if files == nil {
			files = map[string]string{}
		}
		c.JSON(200, gin.H{"files": files})
	}
}

// GET /api/projects/:id/deployments/:depId/preview/*filepath
// Sajikan file dari snapshot deployment (anti path traversal).
func previewDeploymentFile(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, _, ok := requireProject(db, c, "viewer")
		if !ok {
			return
		}
		var d models.Deployment
		if err := db.Where("id = ? AND project_id = ?", c.Param("depId"), p.ID).First(&d).Error; err != nil {
			c.JSON(404, gin.H{"message": "Deployment tidak ada"})
			return
		}
		fp := path.Clean("/" + c.Param("filepath"))
		fp = strings.TrimPrefix(fp, "/")
		if fp == "" || fp == "." || strings.Contains(fp, "..") {
			c.JSON(404, gin.H{"message": "File tidak ada"})
			return
		}
		var files map[string]string
		json.Unmarshal([]byte(d.Files), &files)
		content, ok := files[fp]
		if !ok {
			c.JSON(404, gin.H{"message": "File tidak ada"})
			return
		}
		servePreviewContent(c, fp, content)
	}
}

func servePreviewContent(c *gin.Context, name, content string) {
	// Nilai data URL (mis. gambar upload) → decode base64
	if strings.HasPrefix(content, "data:") {
		parts := strings.SplitN(content, ",", 2)
		if len(parts) == 2 && strings.Contains(parts[0], ";base64") {
			ct := strings.TrimSuffix(strings.TrimPrefix(parts[0], "data:"), ";base64")
			if b, err := base64.StdEncoding.DecodeString(strings.TrimSpace(parts[1])); err == nil {
				if ct == "" {
					ct = "application/octet-stream"
				}
				c.Data(200, ct, b)
				return
			}
		}
	}
	ct := mime.TypeByExtension(path.Ext(name))
	if ct == "" {
		ct = "text/plain; charset=utf-8"
	}
	c.Data(200, ct, []byte(content))
}

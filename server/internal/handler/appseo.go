package handler

import (
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// ── SEO per project ──
// Terpisah dari /settings agar tidak bentrok; menyimpan meta dasar
// yang dipakai saat publish (title, description, og:image, favicon).

// GET /api/projects/:id/seo — baca (viewer)
func getProjectSEO(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, _, ok := requireProject(db, c, "viewer")
		if !ok {
			return
		}
		c.JSON(200, gin.H{"seo": gin.H{
			"title":       p.SEOTitle,
			"description": p.SEODesc,
			"og_image":    p.SEOOGImage,
			"favicon":     p.SEOFavicon,
		}})
	}
}

// PUT /api/projects/:id/seo — simpan (owner/editor)
func updateProjectSEO(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, _, ok := requireProject(db, c, "editor")
		if !ok {
			return
		}
		var req struct {
			Title       *string `json:"title"`
			Description *string `json:"description"`
			OgImage     *string `json:"og_image"`
			Favicon     *string `json:"favicon"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(400, gin.H{"message": "Data tidak valid"})
			return
		}
		updates := map[string]interface{}{}
		if req.Title != nil {
			updates["seo_title"] = *req.Title
		}
		if req.Description != nil {
			updates["seo_desc"] = *req.Description
		}
		if req.OgImage != nil {
			updates["seo_og_image"] = *req.OgImage
		}
		if req.Favicon != nil {
			updates["seo_favicon"] = *req.Favicon
		}
		if len(updates) > 0 {
			if err := db.Model(&p).Updates(updates).Error; err != nil {
				c.JSON(500, gin.H{"message": "Gagal menyimpan SEO"})
				return
			}
		}
		c.JSON(200, gin.H{"ok": true})
	}
}

package handler

import (
	"webbuilder/internal/database/models"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// ── Galeri template publik ──

// templateJSON: representasi template TANPA field Files.
func templateJSON(db *gorm.DB, t models.Template) gin.H {
	ownerName := "WebBuilder"
	if t.OwnerID != nil {
		var u models.User
		if err := db.Select("name").First(&u, *t.OwnerID).Error; err == nil && u.Name != "" {
			ownerName = u.Name
		} else {
			ownerName = "Pengguna"
		}
	}
	return gin.H{
		"id": t.ID, "name": t.Name, "description": t.Description,
		"category": t.Category, "framework": t.Framework,
		"uses": t.Uses, "featured": t.Featured, "ownerName": ownerName,
		"createdAt": t.CreatedAt,
	}
}

// POST /api/templates — publish proyek sendiri jadi template publik.
func publishTemplate(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := c.GetUint("userID")
		var req struct {
			ProjectID   uint   `json:"projectId" binding:"required"`
			Name        string `json:"name" binding:"required"`
			Description string `json:"description"`
			Category    string `json:"category"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(400, gin.H{"message": "projectId & name wajib"})
			return
		}
		// hanya pemilik proyek
		var p models.Project
		if err := db.Where("id = ? AND user_id = ?", req.ProjectID, uid).First(&p).Error; err != nil {
			c.JSON(404, gin.H{"message": "Proyek tidak ada"})
			return
		}
		t := models.Template{
			OwnerID: &uid, Name: req.Name, Description: req.Description,
			Category: req.Category, Framework: p.Framework, Files: p.Files,
		}
		db.Create(&t)
		audit(db, uid, "template.publish", req.Name, c.ClientIP())
		notify(db, uid, "Template diterbitkan", "Template \""+req.Name+"\" tampil di galeri.")
		c.JSON(201, gin.H{"template": templateJSON(db, t)})
	}
}

// DELETE /api/templates/:id — pemilik template atau admin.
func deleteTemplate(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := c.GetUint("userID")
		var t models.Template
		if err := db.First(&t, c.Param("id")).Error; err != nil {
			c.JSON(404, gin.H{"message": "Template tidak ada"})
			return
		}
		if t.OwnerID == nil || *t.OwnerID != uid {
			if !isAdmin(db, uid) {
				c.JSON(403, gin.H{"message": "Bukan pemilik template"})
				return
			}
		}
		db.Delete(&t)
		audit(db, uid, "template.delete", t.Name, c.ClientIP())
		c.JSON(200, gin.H{"message": "Dihapus"})
	}
}

// PUT /api/admin/templates/:id — toggle featured (admin only).
func adminToggleFeatured(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Featured bool `json:"featured"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(400, gin.H{"message": "featured wajib"})
			return
		}
		var t models.Template
		if err := db.First(&t, c.Param("id")).Error; err != nil {
			c.JSON(404, gin.H{"message": "Template tidak ada"})
			return
		}
		db.Model(&t).Update("featured", req.Featured)
		audit(db, c.GetUint("userID"), "template.featured", t.Name+"="+boolToStr(req.Featured), c.ClientIP())
		c.JSON(200, gin.H{"template": templateJSON(db, t)})
	}
}

func boolToStr(b bool) string {
	if b {
		return "true"
	}
	return "false"
}

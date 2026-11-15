package handler

import (
	"fmt"
	"strings"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// ensureSchema sudah ada di database.go, kita gunakan untuk membuat schema jika belum ada
// validTableName juga sudah ada

func AppAPISelect(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		pid := c.Param("id")
		var req struct {
			Table        string                 `json:"table" binding:"required"`
			Where        map[string]interface{} `json:"where"`
			Order        string                 `json:"order"`
			Limit        int                    `json:"limit"`
			Page         int                    `json:"page"`
			PageSize     int                    `json:"pageSize"`
			Search       string                 `json:"search"`
			SearchFields []string               `json:"searchFields"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(400, gin.H{"error": "Invalid request"})
			return
		}
		if !validTableName(req.Table) {
			c.JSON(400, gin.H{"error": "Invalid table name"})
			return
		}
		if !checkTablePolicy(c, req.Table, "select") {
			return
		}

		appDb, err := getAppPG()
		if err != nil {
			c.JSON(500, gin.H{"error": "DB connection failed"})
			return
		}

		schemaTable := fmt.Sprintf("%s.%s", appSchema(pid), req.Table)

		// Fallback check table existence, if not exists return empty array instead of crashing
		var exists bool
		appDb.Raw("SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = ? AND table_name = ?)", appSchema(pid), req.Table).Scan(&exists)
		if !exists {
			c.JSON(200, gin.H{"data": []map[string]interface{}{}})
			return
		}

		query := appDb.Table(schemaTable)
		if len(req.Where) > 0 {
			query = query.Where(req.Where)
		}
		if req.Search != "" {
			fields := req.SearchFields
			if len(fields) == 0 {
				fields = []string{"name", "title", "email", "status"}
			}
			parts := make([]string, 0, len(fields))
			args := make([]interface{}, 0, len(fields))
			for _, field := range fields {
				if validTableName(field) {
					parts = append(parts, fmt.Sprintf("CAST(%s AS TEXT) ILIKE ?", field))
					args = append(args, "%"+req.Search+"%")
				}
			}
			if len(parts) > 0 {
				query = query.Where("("+strings.Join(parts, " OR ")+")", args...)
			}
		}
		if req.Order != "" {
			orderClean := strings.ReplaceAll(req.Order, ";", "")
			query = query.Order(orderClean)
		}
		pageSize := req.PageSize
		if pageSize <= 0 {
			pageSize = req.Limit
		}
		if pageSize <= 0 {
			pageSize = 50
		}
		if pageSize > 200 {
			pageSize = 200
		}
		page := req.Page
		if page < 1 {
			page = 1
		}
		var total int64
		if err := query.Count(&total).Error; err != nil {
			c.JSON(500, gin.H{"error": err.Error()})
			return
		}
		query = query.Offset((page - 1) * pageSize).Limit(pageSize)
		var results []map[string]interface{}
		if err := query.Find(&results).Error; err != nil {
			c.JSON(500, gin.H{"error": err.Error()})
			return
		}
		c.JSON(200, gin.H{"data": results, "pagination": gin.H{"page": page, "pageSize": pageSize, "total": total, "totalPages": (total + int64(pageSize) - 1) / int64(pageSize)}})
	}
}

func AppAPIInsert(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		if !requireAppOperation(c, "insert") {
			return
		}
		pid := c.Param("id")
		var req struct {
			Table string                 `json:"table" binding:"required"`
			Data  map[string]interface{} `json:"data" binding:"required"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(400, gin.H{"error": "Invalid request"})
			return
		}
		if !validTableName(req.Table) {
			c.JSON(400, gin.H{"error": "Invalid table name"})
			return
		}
		if !checkTablePolicy(c, req.Table, "insert") {
			return
		}

		appDb, err := getAppPG()
		if err != nil {
			c.JSON(500, gin.H{"error": "DB connection failed"})
			return
		}

		ensureSchema(pid) // Pastikan schema ada
		schemaTable := fmt.Sprintf("%s.%s", appSchema(pid), req.Table)

		if err := appDb.Table(schemaTable).Create(&req.Data).Error; err != nil {
			c.JSON(500, gin.H{"error": err.Error()})
			return
		}
		c.JSON(200, gin.H{"data": req.Data, "message": "Inserted successfully"})
	}
}

func AppAPIUpdate(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		if !requireAppOperation(c, "update") {
			return
		}
		pid := c.Param("id")
		var req struct {
			Table string                 `json:"table" binding:"required"`
			Where map[string]interface{} `json:"where" binding:"required"`
			Data  map[string]interface{} `json:"data" binding:"required"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(400, gin.H{"error": "Invalid request"})
			return
		}
		if !validTableName(req.Table) {
			c.JSON(400, gin.H{"error": "Invalid table name"})
			return
		}
		if !checkTablePolicy(c, req.Table, "update") {
			return
		}

		appDb, err := getAppPG()
		if err != nil {
			c.JSON(500, gin.H{"error": "DB connection failed"})
			return
		}
		schemaTable := fmt.Sprintf("%s.%s", appSchema(pid), req.Table)

		if err := appDb.Table(schemaTable).Where(req.Where).Updates(req.Data).Error; err != nil {
			c.JSON(500, gin.H{"error": err.Error()})
			return
		}
		c.JSON(200, gin.H{"message": "Updated successfully"})
	}
}

func AppAPIDelete(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		if !requireAppOperation(c, "delete") {
			return
		}
		pid := c.Param("id")
		var req struct {
			Table string                 `json:"table" binding:"required"`
			Where map[string]interface{} `json:"where" binding:"required"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(400, gin.H{"error": "Invalid request"})
			return
		}
		if !validTableName(req.Table) {
			c.JSON(400, gin.H{"error": "Invalid table name"})
			return
		}
		if !checkTablePolicy(c, req.Table, "delete") {
			return
		}

		appDb, err := getAppPG()
		if err != nil {
			c.JSON(500, gin.H{"error": "DB connection failed"})
			return
		}
		schemaTable := fmt.Sprintf("%s.%s", appSchema(pid), req.Table)

		if err := appDb.Table(schemaTable).Where(req.Where).Delete(nil).Error; err != nil {
			c.JSON(500, gin.H{"error": err.Error()})
			return
		}
		c.JSON(200, gin.H{"message": "Deleted successfully"})
	}
}

func AppAPIQuery(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		if !requireAppOperation(c, "query") {
			return
		}
		pid := c.Param("id")
		var req struct {
			SQL  string        `json:"sql" binding:"required"`
			Args []interface{} `json:"args"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(400, gin.H{"error": "Invalid request"})
			return
		}

		// Set search_path automatically to the project's isolated schema!
		appDb, err := getAppPG()
		if err != nil {
			c.JSON(500, gin.H{"error": "DB connection failed"})
			return
		}

		ensureSchema(pid)

		var results []map[string]interface{}

		// Run in a transaction with restricted search_path
		err = appDb.Transaction(func(tx *gorm.DB) error {
			tx.Exec(fmt.Sprintf("SET search_path TO %s", appSchema(pid)))

			// If it's a mutation (INSERT/UPDATE/DELETE), exec it and return affected rows
			upperSql := strings.ToUpper(strings.TrimSpace(req.SQL))
			if strings.HasPrefix(upperSql, "SELECT") || strings.HasPrefix(upperSql, "WITH") {
				if err := tx.Raw(req.SQL, req.Args...).Scan(&results).Error; err != nil {
					return err
				}
			} else {
				if err := tx.Exec(req.SQL, req.Args...).Error; err != nil {
					return err
				}
			}
			return nil
		})

		if err != nil {
			c.JSON(500, gin.H{"error": err.Error()})
			return
		}

		if results == nil {
			results = []map[string]interface{}{}
		}
		c.JSON(200, gin.H{"data": results})
	}
}

package main

import (
	"fmt"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"webbuilder/internal/database/models"
)

func main() {
	db, err := gorm.Open(sqlite.Open("../data/webbuilder.db"), &gorm.Config{})
	if err != nil {
		fmt.Println("DB Error:", err)
		return
	}
	var cfg models.AIConfig
	db.FirstOrCreate(&cfg, models.AIConfig{ID: 1})
	fmt.Printf("OLD - BaseURL: '%s', Model: '%s', HasKey: %t\n", cfg.BaseURL, cfg.Model, cfg.APIKey != "")

	// Update to 9router / ai.clipku.com AI backend on local port 20128
	cfg.BaseURL = "http://127.0.0.1:20128/v1"
	cfg.Model = "ag/gemini-3-flash"
	cfg.APIKey = "9router-key"
	db.Save(&cfg)

	fmt.Printf("NEW - BaseURL: '%s', Model: '%s', HasKey: %t\n", cfg.BaseURL, cfg.Model, cfg.APIKey != "")
}

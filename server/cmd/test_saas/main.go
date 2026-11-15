package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"webbuilder/internal/database/models"
	"github.com/golang-jwt/jwt/v5"
	"os"
)

func main() {
	db, err := gorm.Open(sqlite.Open("../data/webbuilder.db"), &gorm.Config{})
	if err != nil {
		fmt.Println("DB Error:", err)
		return
	}
	var u models.User
	db.First(&u)
	p := models.Project{UserID: u.ID, Name: "SaaS CRM Test", Slug: "saas-crm-test", Framework: "react", Files: "{}"}
	db.Create(&p)

	secret := os.Getenv("JWT_SECRET")
	if secret == "" {
		if b, e := os.ReadFile("../.jwt-secret"); e == nil {
			secret = string(b)
		}
	}

	t := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"uid": u.ID,
		"exp": time.Now().Add(1 * time.Hour).Unix(),
	})
	tokStr, _ := t.SignedString([]byte(secret))

	fmt.Printf("Testing SaaS creation for Project ID=%d...\n", p.ID)

	body, _ := json.Marshal(map[string]string{
		"message": "Buatkan aplikasi SaaS CRM lengkap dengan Login, Dashboard Analitik, Manajemen Lead & Deals, serta Pengaturan",
		"mode":    "build",
	})
	req, _ := http.NewRequest("POST", fmt.Sprintf("http://127.0.0.1:18082/api/projects/%d/chat", p.ID), bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+tokStr)

	client := &http.Client{Timeout: 90 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		fmt.Println("Error:", err)
		return
	}
	defer resp.Body.Close()

	b, _ := io.ReadAll(resp.Body)
	fmt.Printf("HTTP Status: %d\n", resp.StatusCode)
	fmt.Printf("Total Bytes Received: %d\n", len(b))
	if len(b) > 400 {
		fmt.Println("Sample Output:\n" + string(b[:400]) + "...")
	}
}

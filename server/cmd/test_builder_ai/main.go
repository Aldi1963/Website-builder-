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
	if err := db.First(&u).Error; err != nil {
		fmt.Println("No user found:", err)
		return
	}
	var p models.Project
	if err := db.Where("user_id = ?", u.ID).First(&p).Error; err != nil {
		p = models.Project{UserID: u.ID, Name: "Tes AI", Slug: "tes-ai", Framework: "react", Files: "{}"}
		db.Create(&p)
	}

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

	fmt.Printf("User: %s (ID=%d), Project ID=%d. Testing POST /api/projects/%d/chat...\n", u.Email, u.ID, p.ID, p.ID)

	body, _ := json.Marshal(map[string]string{
		"message": "Buatkan file src/App.tsx sederhana dengan tombol increment counter",
		"mode":    "build",
	})
	req, _ := http.NewRequest("POST", fmt.Sprintf("http://127.0.0.1:18082/api/projects/%d/chat", p.ID), bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+tokStr)

	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		fmt.Println("Request Error:", err)
		return
	}
	defer resp.Body.Close()

	fmt.Println("HTTP Response Status:", resp.Status)
	b, _ := io.ReadAll(resp.Body)
	fmt.Println("Response Sample (first 500 chars):")
	if len(b) > 500 {
		fmt.Println(string(b[:500]) + "...")
	} else {
		fmt.Println(string(b))
	}
}

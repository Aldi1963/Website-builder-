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
	var p models.Project
	db.Where("user_id = ?", u.ID).First(&p)

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

	body, _ := json.Marshal(map[string]string{
		"message": "Halo",
		"mode":    "build",
	})
	req, _ := http.NewRequest("POST", fmt.Sprintf("http://127.0.0.1:18082/api/projects/%d/chat", p.ID), bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+tokStr)

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		fmt.Println("Error:", err)
		return
	}
	defer resp.Body.Close()

	b, _ := io.ReadAll(resp.Body)
	fmt.Println("AI Output for 'Halo':\n" + string(b))
}

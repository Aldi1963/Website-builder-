package main

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"webbuilder/internal/database/models"
)

func main() {
	db, err := gorm.Open(sqlite.Open("../../../data/webbuilder.db"), &gorm.Config{})
	if err != nil {
		fmt.Println("DB error", err)
		return
	}
	var u models.User
	db.First(&u)
	var p models.Project
	db.Where("user_id = ?", u.ID).Order("id DESC").First(&p)

	secret := os.Getenv("JWT_SECRET")
	if secret == "" {
		if b, e := os.ReadFile("../../../.jwt-secret"); e == nil {
			secret = strings.TrimSpace(string(b))
		}
	}
	t := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{"uid": u.ID, "exp": time.Now().Add(1 * time.Hour).Unix()})
	tokStr, _ := t.SignedString([]byte(secret))

	req, _ := http.NewRequest("GET", fmt.Sprintf("http://127.0.0.1:18082/api/projects/%d/export", p.ID), nil)
	req.Header.Set("Authorization", "Bearer "+tokStr)
	resp, _ := http.DefaultClient.Do(req)
	
	fmt.Println("Status:", resp.StatusCode)
	data, _ := io.ReadAll(resp.Body)
	
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		fmt.Println("ZIP Error:", err)
		return
	}
	fmt.Println("Isi ZIP:")
	for _, f := range zr.File {
		fmt.Println("-", f.Name)
	}
}

package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
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

var baseURL = "http://127.0.0.1:18082/api"

func main() {
	fmt.Println("=== MEMULAI INTEGRATION TEST WEBBUILDER ===")
	
	// 1. Setup DB & User
	db, err := gorm.Open(sqlite.Open("../../../data/webbuilder.db"), &gorm.Config{})
	if err != nil {
		fmt.Println("❌ Gagal buka DB:", err)
		return
	}
	var u models.User
	db.First(&u)
	
	// Ensure Admin User for later tests
	u.IsAdmin = true
	db.Save(&u)

	// Buat Project Baru
	p := models.Project{
		UserID:    u.ID,
		Name:      "Integration Test App",
		Slug:      fmt.Sprintf("test-%d", time.Now().Unix()),
		Framework: "react",
		Files:     "{}",
		FormToken: fmt.Sprintf("frm_test_%d", time.Now().Unix()),
		FormEnabled: true,
	}
	db.Create(&p)
	fmt.Printf("✅ [Project] Proyek tes dibuat: ID=%d, Slug=%s\n", p.ID, p.Slug)

	// Bikin JWT Token
	secret := os.Getenv("JWT_SECRET")
	if secret == "" {
		if b, e := os.ReadFile("../../../.jwt-secret"); e == nil {
			secret = strings.TrimSpace(string(b))
		}
	}
	t := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"uid": u.ID,
		"exp": time.Now().Add(1 * time.Hour).Unix(),
	})
	tokStr, _ := t.SignedString([]byte(secret))
	client := &http.Client{Timeout: 90 * time.Second}

	// Helper func for requests
	doReq := func(method, path string, body interface{}) ([]byte, int) {
		var reqBody io.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			reqBody = bytes.NewReader(b)
		}
		req, _ := http.NewRequest(method, baseURL+path, reqBody)
		req.Header.Set("Authorization", "Bearer "+tokStr)
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := client.Do(req)
		if err != nil {
			fmt.Println("HTTP Error:", err)
			return nil, 0
		}
		defer resp.Body.Close()
		respData, _ := io.ReadAll(resp.Body)
		return respData, resp.StatusCode
	}

	// 2. Test AI Code Generation (SaaS Prompt)
	fmt.Println("\n⏳ [AI Chat] Menguji pembuatan aplikasi dengan Gemini 3.1 Pro...")
	chatBody := map[string]string{
		"message": "Buatkan aplikasi Todo sederhana 1 file saja dengan import react",
		"mode":    "build",
	}
	chatResp, code := doReq("POST", fmt.Sprintf("/projects/%d/chat", p.ID), chatBody)
	if code == 200 && bytes.Contains(chatResp, []byte("__applied__")) {
		fmt.Println("✅ [AI Chat] Kode berhasil di-generate dan auto-applied!")
	} else {
		fmt.Printf("❌ [AI Chat] Gagal: status %d. \n", code)
	}

	// 3. Test App CloudDB (BaaS)
	fmt.Println("\n⏳ [Cloud DB] Menguji injeksi SQL dan Data API (app_id schema)...")
	// Eksekusi DDL via Query endpoint
	dbQueryBody := map[string]interface{}{
		"sql": "CREATE TABLE IF NOT EXISTS test_users (id SERIAL PRIMARY KEY, name VARCHAR(50))",
		"args": []interface{}{},
	}
	_, code = doReq("POST", fmt.Sprintf("/app-api/%d/db/query", p.ID), dbQueryBody)
	if code == 200 {
		fmt.Println("✅ [Cloud DB] DDL Create Table dieksekusi dengan aman")
	} else {
		fmt.Println("❌ [Cloud DB] DDL gagal:", code)
	}

	// Insert Data
	dbInsertBody := map[string]interface{}{
		"table": "test_users",
		"data":  map[string]interface{}{"name": "User Tester"},
	}
	_, code = doReq("POST", fmt.Sprintf("/app-api/%d/db/insert", p.ID), dbInsertBody)
	if code == 200 {
		fmt.Println("✅ [Cloud DB] Operasi INSERT JSON berhasil")
	} else {
		fmt.Println("❌ [Cloud DB] INSERT gagal:", code)
	}

	// 4. Test Formulir Publik
	fmt.Println("\n⏳ [Form API] Menguji endpoint form publik tanpa auth...")
	formBody := map[string]interface{}{
		"data": map[string]interface{}{"email": "test@test.com", "pesan": "halo"},
		"hp": "",
	}
	// bypass baseURL untuk hit /f/:token
	req, _ := http.NewRequest("POST", fmt.Sprintf("http://127.0.0.1:18082/f/%s", p.FormToken), bytes.NewReader(mustJSON(formBody)))
	req.Header.Set("Content-Type", "application/json")
	resp, _ := client.Do(req)
	if resp.StatusCode == 200 {
		fmt.Println("✅ [Form API] Formulir tersimpan ke database!")
	} else {
		fmt.Println("❌ [Form API] Gagal:", resp.StatusCode)
	}

	// 5. Test Enterprise ZIP Exporter
	fmt.Println("\n⏳ [Exporter] Mengunduh & memvalidasi ZIP struktur Enterprise...")
	zipData, code := doReq("GET", fmt.Sprintf("/projects/%d/export", p.ID), nil)
	if code == 200 {
		// Validasi isi ZIP di memori
		zr, err := zip.NewReader(bytes.NewReader(zipData), int64(len(zipData)))
		if err == nil {
			filesMap := make(map[string]bool)
			for _, f := range zr.File {
				filesMap[f.Name] = true
			}
			if filesMap["package.json"] && filesMap["vite.config.ts"] && filesMap["README.md"] && filesMap[".env"] {
				fmt.Println("✅ [Exporter] ZIP Valid! package.json, vite.config.ts, .env ditemukan.")
			} else {
				fmt.Println("❌ [Exporter] ZIP tidak mengandung file boilerplate Enterprise!")
			}
		}
	}

	// 6. Test Admin Panel Routes
	fmt.Println("\n⏳ [Admin] Menguji statistik dan akses maintenance...")
	_, code = doReq("GET", "/admin/stats", nil)
	if code == 200 {
		fmt.Println("✅ [Admin] Akses Admin Stats berhasil.")
	} else {
		fmt.Println("❌ [Admin] Gagal akses admin:", code)
	}

	fmt.Println("\n=== INTEGRATION TEST SELESAI ===")
}

func mustJSON(v interface{}) []byte {
	b, _ := json.Marshal(v)
	return b
}

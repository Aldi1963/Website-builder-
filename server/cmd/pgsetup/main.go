// Setup awal PostgreSQL untuk WebBuilder app database.
// Dijalankan sekali via: go run ./cmd/pgsetup
package main

import (
	"fmt"
	"os"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func main() {
	pass, _ := os.ReadFile("../.pg-password")
	dsn := "host=127.0.0.1 port=5434 user=nobody dbname=postgres sslmode=disable"
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		panic(err)
	}
	sqlDB, _ := db.DB()
	defer sqlDB.Close()

	pw := string(pass)
	stmts := []string{
		fmt.Sprintf("DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='webbuilder') THEN CREATE USER webbuilder WITH PASSWORD '%s'; END IF; END $$;", pw),
		"SELECT 1 FROM pg_database WHERE datname='webbuilder'",
	}
	_ = stmts
	db.Exec(stmts[0])
	var exists bool
	db.Raw("SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname='webbuilder')").Scan(&exists)
	if !exists {
		if err := db.Exec("CREATE DATABASE webbuilder OWNER webbuilder").Error; err != nil {
			panic(err)
		}
		fmt.Println("database webbuilder dibuat")
	} else {
		fmt.Println("database webbuilder sudah ada")
	}
}

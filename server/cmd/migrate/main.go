// Command migrate menjalankan migrasi skema Postgres (goose) secara manual.
//
//	# Terapkan semua migrasi yang belum jalan (butuh DATABASE_URL postgres)
//	go run ./cmd/migrate up
//	# Lihat status migrasi
//	go run ./cmd/migrate status
//	# Mundur ke versi tertentu (0 = mundur semuanya). HANYA untuk rollback
//	# yang direncanakan; baca docs/database.md dulu.
//	go run ./cmd/migrate down-to 1
//
// Tanpa DATABASE_URL postgres, perintah ini menolak berjalan: migrasi berversi
// hanya berlaku untuk Postgres. Jalur SQLite tetap memakai AutoMigrate di
// server utama dan tidak memakai tool ini.
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"strconv"

	"webbuilder/internal/database"
)

func main() {
	log.SetFlags(0)
	if len(os.Args) < 2 {
		log.Fatal("pemakaian: migrate <up|status|down-to N>")
	}
	db, driver, err := database.Open()
	if err != nil {
		log.Fatal(err)
	}
	if driver != database.DriverPostgres {
		log.Fatal("migrate hanya untuk Postgres: set DATABASE_URL=postgres://... (SQLite memakai AutoMigrate)")
	}
	ctx := context.Background()
	switch os.Args[1] {
	case "up":
		if err := database.MigrateUp(ctx, db); err != nil {
			log.Fatal(err)
		}
		v, err := database.MigrationVersion(ctx, db)
		if err != nil {
			log.Fatal(err)
		}
		fmt.Printf("migrasi selesai, versi sekarang: %d\n", v)
	case "status":
		v, err := database.MigrationVersion(ctx, db)
		if err != nil {
			log.Fatal(err)
		}
		fmt.Printf("versi migrasi sekarang: %d\n", v)
	case "down-to":
		if len(os.Args) < 3 {
			log.Fatal("pemakaian: migrate down-to N")
		}
		n, err := strconv.ParseInt(os.Args[2], 10, 64)
		if err != nil {
			log.Fatalf("versi tidak valid: %v", err)
		}
		if err := database.MigrateDownTo(ctx, db, n); err != nil {
			log.Fatal(err)
		}
		fmt.Printf("migrasi dimundurkan ke versi: %d\n", n)
	default:
		log.Fatalf("perintah tidak dikenal: %s (harapkan up|status|down-to N)", os.Args[1])
	}
}

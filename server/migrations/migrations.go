// Package migrations menampung migrasi SQL berversi (goose) untuk Postgres.
//
// File di sini di-embed ke binary lewat FS di bawah, sehingga runner migrasi
// (server/internal/database) dan server utama tidak bergantung pada file di
// disk saat berjalan. Penomoran: 00001, 00002, ... — JANGAN pernah mengedit
// file migrasi yang sudah diterapkan di mana pun; buat file baru.
package migrations

import "embed"

// FS berisi seluruh file *.sql di direktori ini.
var (
	//go:embed *.sql
	FS embed.FS
)

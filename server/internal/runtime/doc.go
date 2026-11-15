// Package runtime menyediakan eksekusi kode hasil generate (tenant) yang
// terisolasi dan MATI secara default.
//
// Prinsip: eksekusi tenant adalah permukaan serangan terbesar WebBuilder —
// kode hasil AI berjalan di host yang sama dengan server. Karena itu:
//
//   - Eksekusi tenant MATI secara default. Menyalakannya butuh flag env
//     eksplisit WEBBUILDER_ENABLE_TENANT_EXEC=1 (lihat config.go).
//   - Executor adalah interface; implementasi default adalah proses OS
//     terisolasi (ProcessExecutor). Adapter Docker/OCI tersedia sebagai
//     DockerExecutor, tetapi hanya aktif bila daemon docker benar-benar ada.
//   - Semua implementasi WAJIB: timeout via context (bunuh proses + grup
//     prosesnya), environment yang di-scrub (allowlist saja), working
//     directory terpisah di bawah base dir yang dikonfigurasi, dan capture
//     stdout/stderr dengan batas ukuran.
//
// Catatan: runtime dev/preview yang sudah ada di internal/handler/runtime.go
// (npm install/build/dev server) TIDAK memakai paket ini dan TIDAK diubah
// oleh trek ini. Paket ini adalah fondasi agar eksekusi tenant di masa depan
// bisa dipindah ke sini tanpa mengubah perilaku default live.
package runtime

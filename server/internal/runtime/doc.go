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
// Catatan migrasi (2026-11-15): runtime preview lama di
// internal/handler/runtime.go kini MEMAKAI paket ini untuk eksekusi tenant
// satu-shot — install/build/verify/pipeline (runtimeRun) dan tool agent
// `run_build` — BILA flag WEBBUILDER_ENABLE_TENANT_EXEC=1 nyala. Bila flag
// mati, jalur lama (os.Environ() penuh) dipakai persis seperti sebelumnya.
// Yang masih jalur lama: dev server (long-running + restart loop, adapter
// saat ini one-shot) dan screenshot/browserAcceptance (cek browser milik
// server lewat MCP, bukan kode tenant). Lihat docs/isolation.md.
package runtime

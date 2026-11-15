# Rencana Integrasi MCP Penuh ke Agent Website-builder

Status: rencana — belum dikerjakan. Disusun 15 Nov 2026 dari repo main `3b09b04`
(+ branch `wb-browser-test` berisi PORT env, commit `0a94733`).
Sumber: `chrome-devtools-mcp` (ChromeDevTools, Apache-2.0) + arsitektur agent di repo ini.

## 1. Tujuan

Agent Website-builder bisa membuka hasil build-nya sendiri di Chrome sungguhan,
membaca console error, network request yang gagal, dan isi halaman, lalu
memperbaiki kode dari temuan itu — tanpa skrip browser hardcode dan tanpa
operator manusia di tengah. Loopnya: tulis kode → `npm run build` → dev server
nyala → agent buka di Chrome → cek → perbaiki → ulang sampai lolos atau batas
langkah habis.

Hasil akhir yang bisa diuji: jalankan satu prompt ("buatkan landing page X")
sampai selesai, lalu agent melaporkan "sudah dicek di Chrome: 0 console error,
0 request gagal, screenshot tersimpan" — dan laporan itu benar karena diverifikasi
dari log, bukan klaim model.

## 2. Keadaan sekarang (fakta terverifikasi)

- **Seam tool agent sudah bersih.** `streamChatWithTools` (`server/internal/handler/ai.go:332`)
  menerima `tools []AgentToolSpec` + `execute func(nama, input)`. Katalog ada di
  `agentToolSpecs` (`server/internal/handler/agent.go:96`), dieksekusi
  `executeAgentTool` (`agent.go:137`, contoh `run_build` di `agent.go:217`),
  dipanggil dari `agentpipeline.go:292` (katalog di-marshal ke JSON di `:179`).
  Artinya alat browser bisa disuntikkan di titik ini tanpa mengubah loop LLM.
- **Browser acceptance sekarang rapuh.** Screenshot (`runtime.go:928`) dan
  `browserAcceptance` (`runtime.go:1132`) memakai skrip node playwright-core
  inline dengan path hardcode. Path screenshot (`/home/hatch/workspace/tools/waview/...`,
  `/home/hatch/.cache/ms-playwright/...`) ada di VM ini; path acceptance
  (`/opt/webbuilder/tools/waview/...`, `/root/.cache/ms-playwright/...`) TIDAK ADA
  di VM ini — E2E selalu gagal di fase itu.
- **Tidak ada klien MCP sama sekali** di repo (grep `mcp` kosong di `server/` dan `web/src/`).
- **Tidak ada Chrome asli di VM.** Yang ada hanya Chromium Playwright 1243
  (`~/.cache/ms-playwright/chromium-1243/`). `chrome-devtools-mcp` resmi hanya
  mendukung Google Chrome / Chrome for Testing; Chromium lain "mungkin jalan,
  tidak dijamin".
- **Go 1.26.0, modul `webbuilder`.** Provider AI saat ini chat text-only
  (OpenAI-compatible); belum ada jalur image/vision ke model.
- **Isolasi sudah ada polanya.** Paket `server/internal/runtime/` (ProcessExecutor:
  timeout, cap output 1 MiB, env allowlist + scrub secret) + flag
  `WEBBUILDER_ENABLE_TENANT_EXEC` (default mati). Browser harus mengikuti pola
  yang sama, bukan jalur baru yang longgar.
- **Dev server per proyek** listen di `127.0.0.1:<port>` (`runtime.go:998`);
  vite.config hasil scaffold mem-proxy `/api` ke `127.0.0.1:18082` hardcode
  (`runtime.go:414,432`) — harus mengikuti port server (terkait, lihat Fase 1).

## 3. Arsitektur target

```
postChat (SSE) → queue (DBQueue) → executeAgentPipeline
    → streamChatWithTools( katalog statis + alat browser dinamis )
        → executeAgentTool: nama "browser_*" → MCPClient (per run)
            → chrome-devtools-mcp via stdio (subproses node)
                → Chrome headless (profil terisolasi per run)
                    → dev server proyek http://127.0.0.1:<port>
    → hasil tool (teks snapshot/console/network) kembali ke model
    → screenshot disimpan sebagai artifact chat (file), bukan dibaca model
```

- **Satu browser per agent run.** Klien MCP + Chrome dibuat malas (lazy) pada
  panggilan alat browser pertama dalam satu run, dimatikan (`defer`) saat run
  selesai/batal. Tidak ada browser yang dipakai bersama antar proyek atau antar run.
- **Satu profil Chrome per run.** User-data-dir di bawah workspace run
  (`runtime/<run-id>/chrome-profile/`), dihapus setelah run selesai.
- **Transport stdio.** Server MCP dijalankan sebagai subproses
  (`npx -y chrome-devtools-mcp@latest` atau biner lokal), komunikasi JSON-RPC
  lewat stdin/stdout. Tanpa HTTP, tanpa port tambahan, tanpa auth.
- **Katalog dinamis.** Saat pipeline mulai, agent menanyakan daftar tool ke server
  MCP (`tools/list`), memfilter dengan allowlist (lihat §5), lalu menggabungkan
  ke `agentToolCatalog()`. Nama diprefix `browser_` supaya tidak bentrok dengan
  alat lokal (`browser_navigate_page`, `browser_take_screenshot`, dst).
- **Screenshot bukan untuk model.** Model saat ini text-only. Screenshot disimpan
  ke disk run dan dilampirkan sebagai artifact pada pesan chat (tipe pesan
  artifact baru — ini lanjutan dari item yang sengaja tidak dibawa di PR #1).
  Yang dibaca model: `take_snapshot` (accessibility tree, teks), console, network.

## 4. Keputusan desain

| Keputusan | Pilihan | Alasan / catatan |
|---|---|---|
| SDK klien MCP (Go) | Resmi `modelcontextprotocol/go-sdk` v1 (saat ini v1.7.0) | API stabil v1, default untuk kode baru. Alternatif `mark3labs/mcp-go` v0.58.0 (~9.000 star, lebih kaya fitur) masih v0 — catat sebagai cadangan bila SDK resmi kekurangan sesuatu. Keduanya butuh Go 1.25+ (kita 1.26). |
| Transport | stdio, server sebagai subproses | Paling sederhana, tanpa port/auth; sesuai rekomendasi spesifikasi untuk lokal. |
| Chrome | Chrome for Testing, install pin versi | Diunduh sekali via `@puppeteer/browsers` (`npx @puppeteer/browsers install chrome@stable`), path lewat env `CHROME_FOR_TESTING_PATH` / flag `--executablePath`. Chromium Playwright hanya fallback percobaan (Fase 0 membuktikan). |
| Allowlist alat | Hanya §5 | Semua alat lain (heap snapshot, ekstensi, PWA, WebAuthn, mock network) ditutup — tidak relevan untuk acceptance dan memperbesar permukaan serangan. |
| Gating | Flag baru `WEBBUILDER_ENABLE_BROWSER_TOOLS` (default `0`) | Terpisah dari `WEBBUILDER_ENABLE_TENANT_EXEC` supaya bisa dinyalakan sendiri; tapi browser TIDAK boleh nyala bila eksekusi tenant mati? Diputuskan di Fase 1: syaratkan keduanya nyala (browser menggerakkan hasil eksekusi tenant). |
| Batas | Per panggilan 30 dtk; per run maks 15 panggilan browser / 5 menit (awal 10, diubah jadi 15 atas keputusan user 15 Nov 2026 pasca-Fase 3) | Mencegah run menggantung di page load / trace. Timeout mengikuti deadline ctx pemanggil seperti `runtimeRun`. |
| Output | Cap 64 KiB per hasil tool, truncate + marker | Snapshot halaman bisa sangat besar; jangan biarkan satu tool menghabiskan konteks model. |
| Privasi | `--no-usage-statistics` + `--no-performance-crux` selalu | MCP server ini mengumpulkan statistik pemakaian secara default; produk yang dipakai pelanggan wajib mati. Juga set env `CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS=1`, `CI=1`. |
| Observabilitas | Catat tiap panggilan browser di `agent_tool_calls` seperti tool lain | Nama tool, durasi, status, ringkasan hasil. Screenshot dicatat sebagai artifact, bukan blob di DB. |
| URL yang boleh dibuka | Hanya origin preview proyek sendiri (`127.0.0.1:<port>` + path-nya) | `navigate_page` ke URL luar ditolak di lapis klien (bukan mengandalkan model patuh). Pengecualian: tidak ada di Fase 1–3. |

## 5. Allowlist alat MCP (yang dibuka untuk agent)

Dari 60+ tool `chrome-devtools-mcp`, yang dibuka:

- Navigasi: `navigate_page`, `new_page`, `list_pages`, `select_page`, `close_page`, `wait_for`
- Inspeksi: `take_snapshot`, `list_console_messages`, `get_console_message`,
  `list_network_requests`, `get_network_request`, `evaluate_script`
- Tangkapan: `take_screenshot` (disimpan sebagai artifact, bukan dibaca model)
- Emulasi: `emulate`, `resize_page` (cek viewport mobile — menutup celah
  "tidak bisa emulasi HP" untuk acceptance)
- Kualitas: `lighthouse_audit`, `performance_start_trace`,
  `performance_stop_trace`, `performance_analyze_insight`

Sengaja ditutup: semua alat Memory/heap (14), Extensions (5), PWA (4), WebAuthn (1),
Network mocks (2), WebMCP/Third-party, dan alat input `click`/`fill`/`fill_form`/
`press_key`/`type_text`/`drag`/`hover`/`upload_file` di Fase 1–2. Interaksi
(klik/isi form) baru dipertimbangkan di Fase 4 setelah loop baca-saja terbukti
stabil — interaksi adalah tempat agent paling mudah menghabiskan langkah dan
token tanpa hasil.

## 6. Fase kerja

### Fase 0 — Spike validasi (0,5 hari, tanpa commit ke main)

Tujuan: membuktikan asumsi paling berisiko sebelum menulis kode produksi.

1. Install `chrome-devtools-mcp` + Chrome for Testing di VM
   (`npx @puppeteer/browsers install chrome@stable`), catat versi + path.
2. Jalankan server MCP stdio manual, panggil `tools/list`, lalu
   `navigate_page` → halaman statis lokal, `take_snapshot`,
   `list_console_messages`, `take_screenshot`. Catat latensi tiap panggilan.
3. Ulangi langkah 2 dengan `--executablePath` ke Chromium Playwright 1243:
   jalan atau tidak? Jawaban ini menentukan apakah fallback Chromium boleh
   masuk ke rencana.
4. Uji mode headless + `--no-sandbox` (wajib di VM ini, tanpa display).
5. Keluaran: catatan spike (versi Chrome, versi MCP, latensi, hasil fallback)
   + keputusan lanjut/berhenti. **Kriteria selesai:** satu halaman lokal
   berhasil dibuka + snapshot + console terbaca + screenshot tersimpan.

### Fase 1 — Fondasi: klien MCP + satu alat baca-saja (1–2 hari)

1. Tambah dependensi SDK resmi (`go get modelcontextprotocol/go-sdk/mcp`),
   pin versi di `go.mod`/`go.sum`.
2. Paket baru `server/internal/browser/`:
   - `client.go`: start/stop server MCP sebagai subproses stdio (command dari
     env `CHROME_DEVTOOLS_MCP_CMD`, default `npx -y chrome-devtools-mcp@latest`),
     flag wajib `--headless --isolated --no-usage-statistics --no-performance-crux`,
     `--executablePath` dari `CHROME_FOR_TESTING_PATH`.
     (Implementasi Fase 1: `--isolated` diganti `--user-data-dir` eksplisit per
     run — efeknya sama (profil sementara), tapi `Close()` bisa menghapusnya
     secara deterministik; `--isolated` membuat temp dir yang dibersihkan
     server MCP sendiri.)
   - `tools.go`: `tools/list` → filter allowlist → konversi ke `AgentToolSpec`
     (prefix `browser_`), cap skema.
   - `lifecycle.go`: satu klien per run, user-data-dir per run, kill + hapus
     profil di akhir run (termasuk saat run dibatalkan).
3. Wiring di pipeline: `executeAgentPipeline` membuat klien browser bila flag
   nyala, menggabungkan katalog, dan me-routing `browser_*` di `executeAgentTool`
   (atau di closure `execute` di `agentpipeline.go:292`).
4. Config: `WEBBUILDER_ENABLE_BROWSER_TOOLS` (default `0`) di `config.Load()`,
   env dicatat di `.env.example` + `docs/isolation.md`.
5. Perbaikan terkait: vite proxy `/api` mengikuti port server (bukan hardcode
   18082) — perlu agar preview proyek jalan saat server di port lain.
6. Test: `TestBrowserClientStartStop` (start → list tools → stop, tanpa Chrome
   bila tidak ada? pisah: test unit dengan server MCP palsu stdio; test
   integrasi butuh Chrome, di-skip bila `CHROME_FOR_TESTING_PATH` kosong).
   **Kriteria selesai:** agent dalam satu run bisa memanggil
   `browser_list_console_messages` dan hasilnya tercatat di `agent_tool_calls`.

### Fase 2 — Loop verifikasi: acceptance lewat MCP (2–3 hari)

1. Tambah alat allowlist §5 ke katalog dinamis (navigasi + snapshot + console +
   network + screenshot + emulate/resize).
2. Pipeline: setelah `run_build` sukses + dev server nyala, agent otomatis
   membuka preview (`browser_navigate_page` ke `http://127.0.0.1:<port>`),
   mengambil snapshot + console + network, lalu memutuskan: lolos / perbaiki
   (maks 2 putaran perbaikan otomatis per run, sisanya dilaporkan ke user).
3. Screenshot tiap putaran disimpan sebagai artifact run
   (`runtime/<run-id>/screenshot-<n>.png`) + dicatat di `agent_tool_calls`;
   tampilkan di chat sebagai artifact (tipe pesan baru — implementasi minimal:
   lampirkan sebagai file pada pesan selesai).
4. Ganti pemakaian `browserAcceptance` playwright di `runtime.go:1132`:
   jadikan MCP sebagai jalur utama bila flag nyala; jalur playwright dipertahankan
   sebagai fallback sementara (ditandai deprecated, dihapus di rilis berikutnya).
   Screenshot `runtime.go:928` ikut pindah ke MCP (hapus skrip node inline).
5. Prompt: tambah instruksi ke system prompt agent — kapan memakai alat browser,
   urutan cek (snapshot → console → network → screenshot), dan larangan
   membuka URL di luar preview proyek.
6. Test: E2E satu proyek uji (prompt sederhana) sampai agent melaporkan 0 console
   error; test regresi: proyek yang sengaja dibuat error (mis. `undefined`
   di render) harus ketahuan agent lewat console lalu diperbaiki atau dilaporkan.
   **Kriteria selesai:** E2E proyek uji lolos acceptance MCP; proyek error
   terdeteksi dan dilaporkan dengan isi console error yang benar.

### Fase 3 — Hardening + dokumentasi (1 hari)

1. Batas & keamanan: enforce allowlist URL di klien (tolak navigasi keluar
   preview), timeout per panggilan + budget per run, cap output 64 KiB,
   kill Chrome yang menggantung (pastikan tidak ada proses yatim pasca-run).
2. Observabilitas: durasi + status tiap panggilan browser di `/metrics` (counter
   `browser_tool_calls_total` + histogram durasi) dan di log JSON.
3. Resource: ukur memori Chrome per run; bila >512 MiB, dokumentasikan batas
   worker bersamaan (queue workers default 2 → maks 2 Chrome bersamaan).
4. Dokumen: `docs/browser-tools.md` (cara nyalakan flag, cara install Chrome for
   Testing, cara cek run macet via SQL `agent_tool_calls`, batasan), perbarui
   `.env.example` + `docs/isolation.md`.
5. Hapus jalur playwright lama (`runtime.go:928,1132`) bila Fase 2 stabil
   selama 1 minggu; kalau belum, tandai deprecated dan jadwalkan penghapusan.
   **Kriteria selesai:** `go vet/build/test` + `-race` bersih; docs lengkap;
   tidak ada proses Chrome yatim setelah 10 run berurutan.

### Fase 4 — Opsional: interaksi penuh (terpisah, butuh keputusan)

Buka alat input (`click`, `fill`, `fill_form`, `press_key`, `wait_for` lanjutan)
supaya agent bisa menguji alur (isi form, klik tombol, login dengan akun uji).
Syarat masuk: Fase 2–3 stabil + ada akun uji khusus (bukan akun user) + batas
langkah interaksi per run. Tidak dikerjakan sebelum itu.

## 7. Konfigurasi baru

| Env | Default | Keterangan |
|---|---|---|
| `WEBBUILDER_ENABLE_BROWSER_TOOLS` | `0` | Nyalakan alat browser untuk agent. |
| `CHROME_DEVTOOLS_MCP_CMD` | `npx -y chrome-devtools-mcp@latest` | Command server MCP (boleh path biner lokal). |
| `CHROME_FOR_TESTING_PATH` | kosong (auto-detect) | Path biner Chrome for Testing. |
| `CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS` | `1` | Matikan statistik pemakaian (wajib). |

## 8. Pengujian

- Unit (tanpa Chrome): katalog dinamis dari `tools/list` palsu, filter allowlist,
  tolak URL luar, cap output, lifecycle start/stop.
- Integrasi (butuh Chrome for Testing): start/stop klien, navigate + snapshot +
  console + screenshot terhadap dev server proyek uji.
- E2E: prompt → build → acceptance MCP lolos; proyek error → terdeteksi.
- Regresi: `go vet ./...`, `go test ./...`, `go test -race ./internal/handler/`,
  `pnpm typecheck` + `pnpm test` (tidak ada perubahan frontend di Fase 1–3).
- Manual: 10 run berurutan tanpa Chrome yatim (`ps` setelah tiap run).

## 9. Risiko & mitigasi

| Risiko | Dampak | Mitigasi |
|---|---|---|
| Chromium Playwright tidak didukung | Spike gagal, butuh unduh Chrome for Testing | Fase 0 membuktikan dulu; Chrome for Testing diunduh sekali, path di-pin |
| MCP server / Chrome tidak ada di host deploy | Fitur mati di produksi | Fail-closed: flag nyala tanpa Chrome → error jelas di log + agent jalan tanpa alat browser (bukan diam-diam) |
| Snapshot halaman membengkak | Konteks model habis, biaya token naik | Cap 64 KiB + ringkas snapshot (hanya struktur + teks terlihat) |
| Screenshot butuh vision, model text-only | Screenshot tidak bisa "dibaca" model | Screenshot jadi artifact untuk user; model membaca snapshot/console/network (teks) |
| Chrome menggantung / yatim | Memori VM habis | Timeout + kill di akhir run + cek `ps` di test; supervisi tidak menanggung Chrome (per-run, bukan daemon) |
| Agent membuka URL luar / menyerang | SSRF lewat browser | Allowlist origin preview di klien; tanpa kredensial di env browser |
| SDK Go berubah API | Kode tidak compile pasca-update | Pin versi di go.mod; pilih SDK resmi v1 (stabil), bukan mcp-go v0 |
| DockerExecutor belum teruji | Chrome di container butuh deps + `--no-sandbox` | Fase 1–3 hanya ProcessExecutor; Docker dicatat sebagai batasan |

## 10. Di luar lingkup

- Mengganti Playwright di semua tempat sekaligus (hanya acceptance + screenshot).
- Mengemulasi HP fisik / login sebagai user (tetap butuh sesi user).
- Menjalankan MCP server sebagai layanan HTTP publik (stdio lokal saja).
- Dukungan multi-browser (Firefox/Safari) — Chrome saja.
- Alat browser untuk pengguna akhir di UI builder (ini alat agent, bukan fitur produk).

## 11. Urutan yang disarankan

Fase 0 (spike) → keputusan lanjut/berhenti → Fase 1 → Fase 2 → Fase 3.
Fase 4 hanya bila Fase 2–3 stabil dan ada kebutuhan interaksi nyata.
Perkiraan total Fase 0–3: **4–6 hari kerja** (1 orang, termasuk verifikasi).
Dikerjakan di branch `feature/mcp-browser-tools` dari main `3b09b04`, PR per fase,
verifikasi independen tiap fase sebelum merge (pola PR #9/#10/#11).

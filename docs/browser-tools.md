# Alat Browser Agent (chrome-devtools-mcp)

Alat browser memungkinkan agent Website-builder membuka hasil build-nya
sendiri di Chrome headless sungguhan, membaca console error, request
network yang gagal, dan isi halaman, lalu memperbaiki kode dari temuan
itu — tanpa skrip browser hardcode dan tanpa operator di tengah.

Dokumen ini adalah dokumentasi operasional Fase 1–4 dari rencana
(`docs/mcp-browser-integration-plan.md` §6). Detail spike Fase 0
(versi, latensi, fallback Chromium) ada di `docs/mcp-spike-notes.md`;
aturan isolasi runtime ada di `docs/isolation.md`.

Kode: `server/internal/browser/` (`client.go`, `tools.go`,
`lifecycle.go`, `verify.go`, `acceptance.go`, `network.go`,
`memory.go`), metrik di `server/internal/observability/metrics.go`,
wiring pipeline di `server/internal/handler/agentpipeline.go`,
wiring observability di `server/internal/handler/observability.go`.

## Cara menyalakan

Alat browser HANYA aktif bila **kedua** flag bernilai persis `"1"`:

```bash
WEBBUILDER_ENABLE_BROWSER_TOOLS=1
WEBBUILDER_ENABLE_TENANT_EXEC=1
```

Hanya `"1"` yang menyalakan — `"true"`, `"yes"`, `"on"` tidak. Alasan
dua flag: browser menggerakkan hasil eksekusi tenant di Chrome, jadi
ia tidak boleh nyala bila eksekusi tenant mati (rencana §4, diputuskan
Fase 1). Lihat juga `.env.example` bagian `[server] Browser tools`.

### Flag alat input (Fase 4)

Alat input (`click`, `fill`, `fill_form`, `press_key` — lihat
"Alat input (Fase 4)" di bawah) punya flag sendiri dan **default
mati**:

```bash
WEBBUILDER_ENABLE_BROWSER_INPUT_TOOLS=1
```

Ujung-ke-ujung di produksi, alat input HANYA aktif bila **ketiga** flag bernilai persis `"1"`:

```bash
WEBBUILDER_ENABLE_BROWSER_TOOLS=1
WEBBUILDER_ENABLE_TENANT_EXEC=1
WEBBUILDER_ENABLE_BROWSER_INPUT_TOOLS=1
```

Dua lapis: di lapis paket browser, flag input sendiri yang
membuka/menutup keempat alat (`InputToolsEnabled()`); klien browser
sendiri hanya dibuat bila dua flag utama nyala (`Enabled()` di
`NewClientForRun`), jadi tanpa keduanya tidak ada sesi browser sama
sekali — katalog pun tidak pernah sampai ke model.

Alasan flag terpisah: interaksi (klik/isi form) adalah permukaan
serangan yang lebih besar daripada baca-saja — ia mengubah state
halaman dan bisa menghabiskan langkah run tanpa hasil — jadi ia
tidak boleh ikut nyala otomatis saat alat baca dinyalakan. Flag ini
tidak mengubah flag browser utama: alat baca tetap jalan seperti
sebelumnya bila flag input mati.

### Bila flag mati

- Katalog agent tidak berisi alat `browser_*` sama sekali — model
  tidak pernah melihatnya, jadi tidak bisa memanggilnya.
- Pemanggilan `browser_*` (bila entah bagaimana sampai ke server)
  ditolak dengan error jelas (`ErrBrowserToolsDisabled`).
- **Bila hanya flag input yang mati** (dua flag browser nyala):
  katalog agent berisi 19 alat baca §5 saja — keempat alat input
  tidak ada di katalog, dan pemanggilan `browser_click` /
  `browser_fill` / `browser_fill_form` / `browser_press_key`
  ditolak `CallTool` dengan error jelas (alat tidak aktif).
- Acceptance + screenshot mengembalikan error tegas (fail-closed):
  `browserAcceptance` mengembalikan `ErrBrowserToolsDisabled`,
  `runtimeCaptureScreenshot` mengembalikan HTTP 503. Tidak ada jalur
  lain — jalur playwright lama sudah dihapus.

### Bila flag nyala tapi Chrome/MCP tidak tersedia — fail-closed

Tidak ada mode diam-diam. Yang terjadi, per jalur:

| Jalur | Perilaku bila MCP/Chrome gagal start |
| --- | --- |
| Alat model-driven (katalog agent) | Pipeline mencatat error jelas di log (`agent pipeline: browser tools gagal start, lanjut tanpa alat browser`) dan agent jalan TANPA alat browser. Run tetap jalan; model tidak diberi alat yang tidak berfungsi. |
| Loop verifikasi scripted | `VerifyPreview` mengembalikan error; loop mencatat `browser_verify` `failed` di `agent_tool_calls` dan run berhenti dengan ringkasan "Verifikasi browser tidak bisa dijalankan: …". |
| Acceptance / screenshot satu tembakan (`RunAcceptance`, `CaptureScreenshot`) | Mengembalikan error infrastruktur (BUKAN `ErrAcceptanceFailed`) — caller (handler) mengembalikan error tegas ke pemanggil, tanpa fallback. Verdict halaman (`ErrAcceptanceFailed`) hanya keluar bila halaman benar-benar dibuka dan dicek tapi tidak lolos. |

Pesan error selalu menyebut penyebabnya (mis. path Chrome yang
salah ikut tercetak), supaya tidak perlu menebak.

## Cara install Chrome for Testing

Server MCP resmi hanya mendukung Google Chrome / Chrome for Testing.
Install sekali di host (lokasi persisten di bawah home, bukan `/tmp`
— aman dari reboot):

```bash
# 1. Install Chrome for Testing (pin stable saat instalasi)
npx -y @puppeteer/browsers@3.2.7 install chrome@stable

# 2. Catat path binernya, lalu pin lewat env
export CHROME_FOR_TESTING_PATH=/home/hatch/workspace/chrome/linux-157.0.8103.78/chrome-linux64/chrome
```

Yang terpasang di VM ini (spike Fase 0, 15 Nov 2026):

| Komponen | Versi | Path |
| --- | --- | --- |
| Chrome for Testing | 157.0.8103.78 | `/home/hatch/workspace/chrome/linux-157.0.8103.78/chrome-linux64/chrome` (408 MB) |
| chrome-devtools-mcp | 1.13.0 | dijalankan via `npx -y chrome-devtools-mcp@1.13.0` |
| Node | v24.22.3 | — |

Versi server MCP di-pin ke `1.13.0` di `DefaultMCPCommand`
(`server/internal/browser/client.go`) — jangan `@latest`, supaya
reproduksibel. Bila server MCP versi lain dipakai, alat yang hilang
dari `tools/list` dilaporkan fail-closed (lihat "Alat yang hilang"
di bawah), bukan diam-diam hilang dari katalog.

### Variabel env terkait

| Env | Default | Keterangan |
| --- | --- | --- |
| `WEBBUILDER_ENABLE_BROWSER_TOOLS` | (mati) | `"1"` = nyalakan alat browser. |
| `WEBBUILDER_ENABLE_TENANT_EXEC` | (mati) | `"1"` = nyalakan eksekusi tenant; wajib juga nyala untuk browser. |
| `WEBBUILDER_ENABLE_BROWSER_INPUT_TOOLS` | (mati) | `"1"` = nyalakan alat input Fase 4 (`click`, `fill`, `fill_form`, `press_key`). Di produksi, klien browser hanya dibuat bila dua flag di atas juga `"1"`, jadi ujung-ke-ujung ketiganya harus nyala; di lapis paket browser, flag ini sendiri yang membuka/menutup alat input. |
| `CHROME_DEVTOOLS_MCP_CMD` | `npx -y chrome-devtools-mcp@1.13.0` | Command server MCP (satu baris, dipisah spasi sederhana — tanpa quoting shell). Boleh path biner lokal. |
| `CHROME_FOR_TESTING_PATH` | kosong (auto-detect oleh server MCP) | Path biner Chrome for Testing. Sebaiknya di-pin (lihat atas) — jangan mengandalkan auto-detect. |
| `CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS` | `1` (di-set klien) | Matikan statistik pemakaian server MCP (wajib — server ini mengumpulkannya secara default). |
| `CI` | `1` (di-set klien) | Di-set klien saat start server MCP. |

Flag yang selalu dipasang klien saat start server MCP:
`--headless --no-usage-statistics --no-performance-crux
--no-page-id-routing --chrome-arg=--no-sandbox
--chrome-arg=--disable-setuid-sandbox`, plus `--executablePath`
(bila `CHROME_FOR_TESTING_PATH` diisi), `--workspace` (direktori run),
dan `--user-data-dir` (profil Chrome per run, lihat bawah).
`--no-sandbox` wajib di VM ini (tanpa display, user root) dan harus
lewat `--chrome-arg=` — bukan flag server langsung.

### Fallback: Chromium Playwright sebagai biner Chrome MCP

Bagian ini BUKAN tentang jalur skrip playwright lama (yang sudah
dihapus) — melainkan tentang biner Chromium sebagai alternatif
`CHROME_FOR_TESTING_PATH` untuk server MCP.

Spike Fase 0 membuktikan Chromium Playwright 1243
(`/home/hatch/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`,
melaporkan diri sebagai Chrome for Testing 153.0.8010.12) jalan penuh
— snapshot dan console identik, screenshot byte-identik (md5 sama).
Ia boleh dipakai sebagai fallback bila Chrome for Testing tidak ada di
host deploy, dengan catatan: versinya lebih tua dan status dukungannya
tetap "tidak dijamin" oleh upstream. Caranya: arahkan
`CHROME_FOR_TESTING_PATH` ke path Chromium itu. Chrome for Testing
tetap jalur utama.

### Cek cepat instalasi

```bash
# Biner ada + bisa dieksekusi
"$CHROME_FOR_TESTING_PATH" --version
# Harus mencetak mis. "Google Chrome for Testing 157.0.8103.78"

# Server MCP bisa start (tanpa menjalankan WebBuilder)
npx -y chrome-devtools-mcp@1.13.0 --headless --no-usage-statistics \
  --executablePath "$CHROME_FOR_TESTING_PATH" --workspace /tmp/mcp-cek
# (tekan Ctrl-C sesudah handshake initialize sukses)
```

## Daftar alat (allowlist §5 — 19 alat baca + 4 alat input Fase 4)

Dari 33 tool yang dikembalikan `tools/list` server MCP 1.13.0, yang
dibuka hanya 19 alat baca ini (rencana §5) — plus, sejak Fase 4, 4
alat input di bawah, yang HANYA aktif bila flag
`WEBBUILDER_ENABLE_BROWSER_INPUT_TOOLS=1` (lihat "Cara menyalakan").
Di katalog agent namanya berprefix `browser_` (mis.
`browser_navigate_page`); di lapis klien MCP namanya tanpa prefix.
Seluruh allowlist aktif sejak Fase 2 (`ActiveTools` =
`AllowlistTools` di `server/internal/browser/tools.go`); alat input
Fase 4 disimpan terpisah (`InputTools` di file yang sama) dengan
gating flag sendiri — `IsActiveTool` memeriksa keduanya.

| Kelompok | Alat | Kegunaan |
| --- | --- | --- |
| Navigasi | `navigate_page`, `new_page`, `list_pages`, `select_page`, `close_page`, `wait_for` | Buka / pindah / tutup halaman, tunggu. |
| Inspeksi | `take_snapshot`, `list_console_messages`, `get_console_message`, `list_network_requests`, `get_network_request`, `evaluate_script` | Baca accessibility tree, console, network, jalankan JS di halaman. |
| Tangkapan | `take_screenshot` | Simpan screenshot PNG sebagai artifact (bukan dibaca model — model text-only). |
| Emulasi | `emulate`, `resize_page` | Cek viewport mobile / emulasi perangkat. |
| Kualitas | `lighthouse_audit`, `performance_start_trace`, `performance_stop_trace`, `performance_analyze_insight` | Audit Lighthouse + trace performa. |
| Input (Fase 4, flag terpisah) | `click`, `fill`, `fill_form`, `press_key` | Klik elemen, isi field form, isi banyak field sekaligus, tekan tombol keyboard. Lihat "Alat input (Fase 4)" di bawah. |

### Alat input (Fase 4)

Sejak Fase 4 agent bisa MENGUJI ALUR, bukan hanya membaca halaman —
dengan syarat flag input nyala (lihat "Cara menyalakan") dan dalam
batas cap interaksi (lihat "Cap interaksi" di bawah).

| Alat | Fungsi |
| --- | --- |
| `click` | Mengklik satu elemen di halaman. Elemen ditunjuk lewat `uid` dari `take_snapshot` (accessibility tree) — bukan lewat koordinat layar dan bukan lewat teks bebas. |
| `fill` | Mengisi satu field form (mis. satu input teks) dengan satu nilai. Field ditunjuk lewat `uid` dari `take_snapshot`. |
| `fill_form` | Mengisi beberapa field form sekaligus dalam satu panggilan (mis. email + password login) — satu panggilan, bukan satu per field, supaya hemat langkah interaksi. |
| `press_key` | Menekan satu tombol keyboard (mis. `Enter` untuk submit form, `Tab` untuk pindah field, `Escape` untuk menutup dialog). |

`wait_for` BUKAN alat input baru Fase 4: ia sudah ada sejak §5
(kelompok Navigasi di atas — alat tunggu) dan TIDAK dihitung ke cap
interaksi.

Cari `uid` dengan mencocokkan peran + nama (mis. `textbox "Email"`,
`button "Masuk"`): snapshot memuat baris label polos (`"Email"`) dan
elemennya dengan nama yang sama — menarget baris label ditolak server
(`did not become interactive`).

#### Contoh alur: uji login pada proyek fixture

Proyek yang diuji adalah proyek **fixture** (proyek uji yang dibuat
untuk keperluan ini), dan kredensialnya **dummy** (mis.
`user@example.com` / `dummy-password`) — JANGAN PERNAH memakai
kredensial nyata atau akun user sungguhan (lihat "Invariant
keamanan" di bawah).

```
navigate_page → http://127.0.0.1:<port>/login        (halaman login fixture)
  → take_snapshot                                     (cari uid field email,
                                                       field password, tombol submit)
  → fill_form                                         (email + password dummy)
  → click                                             (tombol submit)
  → take_snapshot                                     (BUKTI state berubah:
                                                       mis. teks "Dashboard" /
                                                       sapaan user muncul,
                                                       form login hilang)
```

Pembuktian state berubah WAJIB lewat `take_snapshot` (atau
`list_console_messages` / `list_network_requests`) sesudah interaksi
— klaim model ("sudah login") tanpa snapshot sesudahnya bukan bukti.
Bila snapshot sesudah `click` masih menampilkan form login, alur
DINILAI GAGAL dan temuan dilaporkan apa adanya (sama seperti loop
verifikasi baca-saja).

#### Yang tetap tertutup sesudah Fase 4

`type_text`, `drag`, `hover`, `upload_file` tetap DITUTUP, begitu
juga semua alat Memory/heap (14), Extensions (5), PWA (4), WebAuthn
(1), Network mocks (2), dan WebMCP/Third-party. Alasan: `drag` /
`hover` / `type_text` mudah menghabiskan langkah tanpa hasil yang
terukur; `upload_file` membuka jalur file masuk ke browser (lihat
"Invariant keamanan"); sisanya tidak relevan untuk acceptance.

#### Invariant keamanan — tidak berubah di Fase 4

Membuka alat input TIDAK melonggarkan satu pun batas hardening
Fase 3:

- **Allowlist URL tetap terkunci ke port preview proyek** — interaksi
  hanya boleh terjadi di halaman preview proyek sendiri
  (`127.0.0.1`/`localhost:<port-preview>`); navigasi atau interaksi
  ke URL luar tetap ditolak fail-closed sebelum menyentuh browser.
- **Timeout tetap 30 dtk per panggilan** (`CallTimeout`) dan
  **cap output tetap 64 KiB** (`MaxOutputBytes`) — berlaku juga untuk
  hasil alat input.
- **Tanpa upload/download file** — tidak ada alat upload file yang
  dibuka, dan alat input tidak boleh dipakai untuk mengunduh atau
  mengunggah file apa pun.
- **Tanpa kredensial nyata** — pengujian alur login memakai proyek
  fixture + kredensial dummy saja. Jangan pernah mengisi form dengan
  kredensial akun sungguhan, token, atau secret apa pun; tidak ada
  kredensial di env browser.

### Alat yang hilang dari server MCP

Bila `tools/list` server MCP tidak memuat salah satu dari 19 alat
aktif (23 bila flag input nyala — 19 + 4 alat input) (mis. server MCP versi lama tanpa `lighthouse_audit`), pipeline
mencatat peringatan jelas di log + satu baris `browser_tools_missing`
`failed` di `agent_tool_calls`, dan katalog berjalan tanpa alat itu.
Alat yang hilang tidak pernah dikarang speknya.

## Alur verifikasi scripted (loop Fase 2)

Selain alat yang bisa dipanggil model, pipeline menjalankan
verifikasi OTOMATIS yang deterministik sesudah `run_build` sukses +
dev server nyala — tidak menunggu model ingat memanggil alat browser.
Satu putaran (`VerifyPreview`, `server/internal/browser/verify.go`):

```
navigate_page → (tunggu 1 dtk, beri React/Vite waktu mount)
  → take_snapshot → list_console_messages → list_network_requests
  → take_screenshot
```

- Maks **2 putaran** perbaikan otomatis per run
  (`MaxBrowserVerifyRounds = 2` di
  `server/internal/handler/agentpipeline.go`). Sesudah putaran ke-2
  masih gagal, temuan dilaporkan ke user apa adanya — tidak ada
  putaran ke-3.
- Tiap putaran yang gagal: temuan diumpankan ke `repairProjectFiles`
  (model memperbaiki dari temuan BENAR — isi console/network —
  bukan klaim model), lalu acceptance runtime dijalankan ulang; bila
  acceptance ulang gagal, loop berhenti dan error itu diteruskan.
- Bila tanpa provider AI (`repair == nil`), loop berhenti sesudah
  putaran itu dan melaporkan temuan.
- Tiap putaran dicatat di `agent_tool_calls` (tool `browser_verify`,
  status `success`/`failed`) dan dikirim sebagai event SSE
  `browser_verify` supaya terlihat di chat.
- Screenshot tiap putaran disimpan sebagai
  `runtime/<run-id>/screenshot-<n>.png` dan dicatat di
  `agent_tool_calls` — bukan blob di DB.

Satu putaran memakai **5 panggilan** tool browser. Lihat
"Konsekuensi budget" di bawah — angka ini penting.

### Aturan penilaian (format nyata chrome-devtools-mcp 1.13.0)

**Console** (`ParseConsoleErrors`, `verify.go`) — lolos bila 0 baris
`[error]`:

- Baris header (`## Console messages`, `Showing ...`) dan level lain
  (`[log]`/`[warn]`) diabaikan.
- Baris `Failed to load resource` DIABAIKAN — server menggabungkan
  beberapa resource gagal jadi satu baris `[N times]` TANPA menyebut
  URL, jadi 404 `favicon.ico` tidak bisa dibedakan dari 404 aset
  sungguhan lewat baris itu. Kegagalan resource dinilai lewat daftar
  network, yang menyebut URL tiap request.
- Baris apa pun yang menyebut `favicon.ico` diabaikan.

**Network** (`ParseFailedRequests`, inti bersama
`failedNetworkRequests` di `network.go`) — gagal bila status HTTP
`>= 400` atau error `net::*`, kecuali:

- `favicon.ico` 404 (bukan error aplikasi — spike Fase 0);
- `401` pada `/api/app-api/` (probe auth aplikasi logged-out, normal);
- URL `data:` (inline, bisa puluhan KB base64);
- request lintas-origin (font/CDN/analytics pihak ketiga bukan
  tanggung jawab preview ini).

Perbedaan yang disengaja antara dua pemakai parser network (jangan
disamakan tanpa keputusan eksplisit — dikunci test
`server/internal/browser/network_test.go`):

| Kasus | `ParseFailedRequests` (loop verifikasi) | `parseNetworkFailures` (acceptance) |
| --- | --- | --- |
| Halaman sendiri 404 | Dihitung gagal (preview rusak) | Dilewati (status halaman dinilai lewat navigation timing) |
| URL menyebut `favicon.ico` tapi path-nya bukan favicon (mis. `app.js?x=favicon.ico`) | Diabaikan | Dihitung gagal bila 404 |
| `pageURL` tidak bisa di-parse | Semua request lolos filter origin | Semua request ditolak |

**Snapshot** hanya diringkas (struktur + teks terlihat, ≤ 2 KiB,
`MaxSnapshotSummaryBytes`) untuk konteks perbaikan. Model text-only
tidak membaca screenshot.

**Acceptance** (`RunAcceptanceWithClient`, `acceptance.go`) memakai
parser yang sama + `evaluate_script` (status HTTP dari navigation
timing, panjang body, info SDK, resource gagal dari performance
timing). Gagal bila HTTP 0/`>= 400`, body kosong, ada resource gagal,
atau ada console error fatal. `ErrAcceptanceFailed` berarti halaman
dibuka dan dicek tapi tidak lolos — final, TANPA fallback. Error lain
berarti MCP/Chrome tidak jalan dan caller mengembalikan error tegas
(tidak ada fallback).

## Batas hardening (Fase 3)

### Allowlist URL + fail-closed port preview

Hanya origin preview proyek sendiri yang boleh dibuka:

- Cek statis (`ValidateURL`): hanya skema `http`/`https` ke
  `127.0.0.1`, `localhost`, atau `::1`. URL luar, skema lain, dan URL
  relatif ditolak sebelum menyentuh browser.
- Cek port (`validatePreviewURL`, `Client`): port HARUS SAMA dengan
  port preview yang sudah dikunci (`SetPreviewPort`). Bila port belum
  diketahui (previewPort 0 — klien dibuat sebelum dev server nyala),
  navigasi ke URL mana pun DITOLAK fail-closed dengan error jelas
  ("port preview belum diketahui"). Tidak ada fallback "port mana pun".

Port dikunci dari sumber tepercaya saja (bukan input model):

- pipeline mengunci dari `runtimeDev.ports` bila dev server sudah
  jalan sebelum stream;
- `runBrowserVerificationLoop` mengunci ulang tiap putaran dari port
  acceptance runtime (port bisa berubah antar putaran karena dev
  server di-start ulang sesudah perbaikan);
- `VerifyPreview` / `RunAcceptanceWithClient` /
  `CaptureScreenshotWithClient` mempelajari port dari `pageURL`
  yang dibangun kode server tepercaya; bila klien sudah dikunci ke
  port lain, URL port berbeda ditolak.

### Budget per run: 15 panggilan / 5 menit

`MaxBrowserCallsPerRun = 15`, `BrowserBudgetWindow = 5m`
(`server/internal/browser/client.go`).

- Dihitung SEMUA pemanggilan `CallTool` + `callAcceptanceTool` dalam
  satu `Client` — model-driven dan scripted memakai SATU jatah
  bersama (bukan budget terpisah). `ListTools` tidak dihitung (bukan
  panggilan tool).
- Yang dihitung adalah pemanggilan yang lolos cek allowlist + URL —
  termasuk yang gagal di server MCP / timeout. Penolakan allowlist /
  URL / belum-start tidak menghabiskan jatah, tapi tetap tercatat di
  metrik (lihat bawah). Panggilan yang ditolak karena budget habis
  tidak menambah hitungan.
- Jendela 5 menit dihitung sejak panggilan browser PERTAMA run itu.
  Sesudah jendela lewat, panggilan berikutnya ditolak walau hitungan
  baru 2 dari 15 — jendela TIDAK me-reset hitungan, dan sesudah lewat
  tidak ada panggilan lagi untuk run itu.
- Panggilan ke-16 / sesudah jendela ditolak dengan error jelas
  ("budget browser run habis — sudah N panggilan browser (maks 15
  per run)" / "sudah 5m0s sejak panggilan browser pertama"), bukan
  menggantung dan bukan diam-diam.

#### Konsekuensi budget — dibaca jujur, bukan disembunyikan

Satu `VerifyPreview` = 5 panggilan, jadi loop 2 putaran = 10
panggilan dari budget 15 — tersisa 5 panggilan untuk model. Akibatnya:

- Bila model memakai **≤ 5 panggilan browser sebelum loop**, kedua
  putaran loop tetap muat (5 model + 10 loop = 15).
- Bila model memakai **≥ 6 panggilan browser sebelum loop**
  (mis. `browser_navigate_page` sendiri selama stream), putaran ke-2
  loop akan kehabisan budget: `VerifyPreview` putaran ke-2 gagal
  dengan error budget, loop mencatat `browser_verify` `failed`, dan
  run berhenti tanpa putaran perbaikan ke-2.
- Budget awalnya 10 (rencana §4) — dengan 10, model yang memakai
  ≥ 1 panggilan saja sudah membuat putaran ke-2 gagal. Atas keputusan
  user 15 Nov 2026 (pasca-Fase 3), budget dinaikkan jadi 15 supaya
  loop 2 putaran punya ruang untuk pemakaian model yang wajar.

### Cap interaksi (Fase 4): maks 5 panggilan interaksi per run

Selain budget umum 15 di atas, panggilan INTERAKSI dibatasi
tersendiri: **maks 5 panggilan interaksi per run**.

- Yang dihitung HANYA keempat alat input: `click`, `fill`,
  `fill_form`, `press_key`. `wait_for` tidak dihitung (alat tunggu,
  bukan interaksi — sudah ada sejak §5).
- Panggilan interaksi ke-6 dalam satu run ditolak dengan error jelas,
  bukan menggantung dan bukan diam-diam — sama seperti penolakan
  budget umum.
- Panggilan interaksi TETAP dihitung ke budget umum 15 panggilan /
  5 menit: tidak ada jatah terpisah. Satu `fill_form` = 1 panggilan
  interaksi DAN 1 panggilan dari budget 15. Contoh hitungan:
  5 interaksi + loop verifikasi 2 putaran (10 panggilan) = 15 —
  sesudah itu tidak ada panggilan browser lagi di run itu, termasuk
  panggilan baca. Sebaliknya, bila model memakai 5 interaksi SEBELUM
  loop, putaran ke-2 loop kehabisan budget (konsekuensi yang sama
  seperti di "Konsekuensi budget" di atas).
- Alasan cap terpisah: interaksi mengubah state halaman dan paling
  mudah menghabiskan langkah tanpa hasil — cap 5 memaksa alur uji
  tetap pendek (satu `fill_form` + satu `click` + snapshot bukti =
  2 interaksi untuk satu alur login) dan mencegah loop klik-isi
  tanpa ujung. Jangan menaikkan angka cap diam-diam; itu keputusan
  terpisah.

### Timeout per panggilan: 30 detik

`CallTimeout = 30 dtk` (`client.go`). Mengikuti deadline ctx
pemanggil seperti `runtimeRun`. Acceptance satu tembakan juga dibatasi
total `AcceptanceTimeout = 30 dtk`.

### Cap output: 64 KiB

`MaxOutputBytes = 64 KiB` (`TruncateOutput`). Kelebihan dipotong dan
ditandai dengan marker:

```
...[dipotong: output melebihi 64 KiB]
```

Cap berlaku TERMASUK jalur error tool (`IsError`) — hasil error yang
panjang juga dipotong sebelum diteruskan ke model / dicatat. Snapshot
halaman yang membengkak tidak bisa menghabiskan konteks model lewat
satu tool.

### Satu browser per run, tanpa proses yatim

- Satu `Client` + satu Chrome per agent run, dibuat malas saat
  pipeline mulai (model harus tahu alatnya ada sebelum memanggilnya),
  ditutup `defer` saat run selesai — termasuk saat run dibatalkan.
- Profil Chrome per run di bawah
  `runtime/project-<id>/run-<id>/browser/chrome-profile/`, dihapus
  `Close()` sesudah run selesai. Acceptance satu tembakan memakai
  profil di direktori temporer (`wb-browser-acceptance-*` /
  `wb-browser-screenshot-*`) yang dihapus sesudahnya.
- `Close()` aman dipanggil berkali-kali dan sesudah `Start` gagal;
  sesi MCP ditutup (stdin ditutup → SIGTERM → SIGKILL bila membandel,
  oleh SDK), lalu profil dihapus. Bila penghapusan profil gagal,
  hanya dicatat `slog.Warn` — `Close()` tidak gagal karenanya.
- Kriteria rencana: tidak ada proses Chrome yatim setelah 10 run
  berurutan (cek manual dengan `ps`, lihat "Troubleshooting").

## Metrik `/metrics`

Setiap percobaan `CallTool` / `callAcceptanceTool` tercatat SEKALI ke
metrik Prometheus — termasuk penolakan (allowlist, URL, budget) —
lewat observer default yang dipasang `RegisterObservability`
(`server/internal/handler/observability.go` →
`SetDefaultCallObserver(Metrics.RecordBrowserTool)`). Klien yang
dibuat pipeline (`NewClientForRun`) otomatis tercatat tanpa perubahan
di `agent.go` / `agentpipeline.go`. Observer yang panic ditelan
(`observeCall` me-recover) supaya pencatatan tidak pernah menggagalkan
run.

| Metrik | Jenis | Label | Keterangan |
| --- | --- | --- | --- |
| `browser_tool_calls_total` | counter | `tool`, `status` | Jumlah panggilan per alat. `status` hanya `success` / `error` — pesan error TIDAK PERNAH jadi label. Nama tool di luar allowlist aktif dinormalisasi ke `unknown` supaya kardinalitas label tetap terbatas (nama tool bisa datang dari model). |
| `browser_tool_calls_duration_seconds` | histogram | `tool` | Durasi panggilan (detik). Bucket: `.005 .01 .025 .05 .1 .25 .5 1 2.5 5 10 30` (+ `+Inf` implisit — mengikuti `CallTimeout` 30 dtk; bucket rapat di bawah 1 dtk karena panggilan baca seperti console/network umumnya < 250 ms sesudah initialize). |

Implementasi hand-rolled di `server/internal/observability/metrics.go`
(counter + histogram, `WritePrometheus` dengan HELP/TYPE yang benar
+ urutan stabil di-sort). Contoh:

```bash
curl -s http://127.0.0.1:18082/metrics | grep browser_tool_calls
# browser_tool_calls_total{tool="list_console_messages",status="success"} 42
# browser_tool_calls_duration_seconds_bucket{tool="navigate_page",le="1"} 7
```

Catatan: metrik menghitung PERCOBAAN (termasuk yang ditolak), jadi
`browser_tool_calls_total` bisa lebih besar dari `BrowserCalls()`
(klien) pada run yang sama — penolakan allowlist/URL tercatat di
metrik tapi tidak menghabiskan budget. Selain metrik, tiap panggilan
browser juga tercatat di `agent_tool_calls` seperti tool lain (nama
tool, durasi, status, ringkasan hasil) dan di log JSON server.

## Memori Chrome per run

Chrome diukur, tidak dibunuh karena memori.

- **Metode** (`Client.ChromeMemoryBytes()`, `memory.go`): RSS TOTAL
  pohon proses yang berakar di PID server MCP (node + Chrome + semua
  anaknya: renderer, GPU, network, …) — dijumlahkan dengan berjalan
  di `/proc` (`VmRSS` tiap proses di pohon). Itulah biaya memori satu
  run browser apa adanya.
- **Kapan diukur**: `Close()` mengukur SEBELUM sesi ditutup (sesudah
  Close, server MCP + Chrome sudah mati dan `/proc`-nya hilang) dan
  mencatat ke `slog` (`bytes`, `mib`, `melebihi_512mib`). Hasil
  terakhir bisa dibaca handler lewat `LastChromeMemoryBytes()`.
- **Bila tidak tersedia** (klien belum start, proses sudah mati,
  `/proc` tidak ada): hasilnya `-1` + log "tidak tersedia". Pengukuran
  TIDAK PERNAH menggagalkan run atau `Close()`.
- **Ambang**: `ChromeMemoryHighBytes` = **512 MiB** per run
  (`melebihi_512mib: true` di log bila terlampaui). Chrome tidak
  pernah dibunuh karena melewati ambang — hanya diukur + dicatat.
- **Hasil ukur nyata** (6 run Chrome asli, log `Close()`): satu run
  ≈ **1,1 GiB** — kisaran ukur 1084–1175 MiB — dan **setiap** run
  sejauh ini melewati ambang 512 MiB (`melebihi_512mib=true` di semua
  6 run). Ambang 512 MiB tetap hanya garis peringatan, bukan batas
  yang ditegakkan.
- **Batas worker bersamaan**: queue workers default 2
  (`WEBBUILDER_QUEUE_WORKERS=2`) → maks 2 Chrome bersamaan → kebutuhan
  puncak **~2,2 GiB hanya untuk Chrome** (di luar server + build).
  Bila worker dinaikkan, kalikan: N worker → puncak ~N × 1,1 GiB.
  Jaga memori host saat menaikkan `WEBBUILDER_QUEUE_WORKERS`.

Contoh log:

```
INFO browser: memori Chrome akhir run bytes=1136947200 mib=1084 melebihi_512mib=true
```

## Screenshot verifikasi (PR #14 + #15, ringkas)

Screenshot loop verifikasi BUKAN dibaca model (text-only) — ia
artifact untuk user, ditampilkan di chat sebagai kartu verifikasi.

- **Endpoint** (PR #14): `GET /api/projects/:id/runtime/screenshots/verification/:runId/:name`
  — auth sama seperti endpoint screenshot lama (owner/editor proyek,
  lewat `authMiddleware`). Keamanan path: `:runId` harus angka dan
  harus baris `agent_runs` milik proyek ini (run proyek lain / user
  lain → 404, bukan file); `:name` harus persis
  `screenshot-<n>.png`; path hasil join dicek tetap di dalam
  direktori run itu sebelum disajikan.
- **Persistensi kartu** (PR #15): hasil verifikasi disimpan di pesan
  chat (`ChatMessage.Verification`, JSON) — `getChat` mengembalikannya
  dan frontend me-restore kartu dari riwayat saat reload. Kartu live
  tetap tampil selama run; sesudah reload ia dibangun ulang dari
  pesan tersimpan, bukan dari memori halaman. Edge case yang diketahui:
  bila jawaban model kosong, pipeline tidak membuat pesan asisten
  sehingga verifikasi run itu tidak tersimpan (kartu live tampil,
  hilang sesudah reload).

## Troubleshooting

### Chrome yatim (proses Chrome/MCP tertinggal sesudah run)

```bash
ps aux | grep -E "chrome|chrome-devtools-mcp" | grep -v grep
# Normal: kosong sesudah semua run selesai (Close menghapus profil +
# menutup sesi). Bila ada yang tertinggal, catat PID + run-id-nya,
# lalu bunuh hanya proses itu:
kill <pid>            # beri waktu mati bersih
kill -9 <pid>         # bila membandel
```

Profil yatim (bila ada) ada di bawah
`runtime/project-<id>/run-<id>/browser/chrome-profile/` — hapus
direktori run yang sudah terminal itu. Penyebab yang paling sering:
server mati mendadak (reboot / kill -9) sebelum `defer Close()`
jalan — supervisi tidak menanggung Chrome (per-run, bukan daemon).

### Navigasi ditolak — "port preview belum diketahui"

```
browser: URL preview ditolak — port preview belum diketahui (fail-closed, dev server belum nyala / belum dikunci)
```

Artinya klien dibuat sebelum dev server nyala dan belum ada yang
mengunci port. Periksa urutan: dev server harus start (acceptance
runtime) sebelum `navigate_page` model-driven; loop verifikasi
mengunci port tiap putaran dari acceptance. Bila dev server sudah
jalan tapi error tetap muncul, cek `runtimeDev.ports` — port proyek
itu mungkin berubah (dev server di-start ulang) dan kunci lama
menunjuk port yang sudah mati; `SetPreviewPort` boleh dipanggil ulang
dengan port baru.

### Navigasi ditolak — port bukan port preview

```
browser: URL di luar preview ditolak (port "18099" bukan port preview 18098)
```

Model mencoba membuka URL di luar preview proyek ini (atau port lama).
Ini penolakan yang benar — bukan bug. Bila URL-nya memang preview
proyek ini, port preview sudah berubah antar putaran; loop mengunci
ulang tiap putaran, jadi putaran berikutnya memakai port baru.

### Budget habis di tengah run

```
browser: budget browser run habis — sudah 15 panggilan browser (maks 15 per run)
browser: budget browser run habis — sudah 5m0s sejak panggilan browser pertama (maks 5m0s per run)
```

Periksa berapa panggilan yang sudah dipakai run itu + siapa yang
memakainya (model vs loop scripted):

```bash
# SQLite default (../data/webbuilder.db) — sesuaikan DATABASE_URL bila Postgres
sqlite3 ../data/webbuilder.db \
  "SELECT tool, status, substr(input, 1, 120), created_at FROM agent_tool_calls
   WHERE run_id = <RUN_ID> AND tool LIKE 'browser%' ORDER BY id DESC LIMIT 20;"
```

Atau hitung pemakaian loop scripted: tiap putaran `browser_verify`
= 5 panggilan (`navigate_page`, `take_snapshot`,
`list_console_messages`, `list_network_requests`, `take_screenshot`).
Bila model sudah memakai ≥ 1 panggilan sebelum loop, putaran ke-2
tidak akan kebagian budget — itu konsekuensi yang didokumentasikan
(lihat "Konsekuensi budget"), bukan bug. Jangan menaikkan angka
budget diam-diam; itu keputusan terpisah.

### MCP gagal start

```bash
# 1. Path Chrome benar + bisa dieksekusi?
ls -l "$CHROME_FOR_TESTING_PATH"
"$CHROME_FOR_TESTING_PATH" --version

# 2. Command MCP benar? (default: npx -y chrome-devtools-mcp@1.13.0)
echo "$CHROME_DEVTOOLS_MCP_CMD"
which npx node; node --version

# 3. Lihat stderr server MCP di log JSON server (diteruskan ke slog):
#    cari "browser: stderr server MCP" + "browser: gagal start server MCP"
```

Penyebab yang paling sering: `CHROME_FOR_TESTING_PATH` menunjuk path
tak ada (error menyebut path-nya), `npx` tidak ada di PATH server,
atau Chrome gagal start karena `--no-sandbox` tidak diteruskan (klien
selalu memasangnya — bila menjalankan server MCP manual, jangan lupa
`--chrome-arg=--no-sandbox`).

### Cara cek run macet

Run yang macet di tengah pemakaian browser biasanya terlihat dari
`agent_tool_calls` + `agent_runs` — bukan dari menebak:

```bash
sqlite3 ../data/webbuilder.db \
  "SELECT id, status, phase, updated_at FROM agent_runs WHERE id = <RUN_ID>;"
sqlite3 ../data/webbuilder.db \
  "SELECT tool, phase, status, substr(output, 1, 200) AS output, substr(error, 1, 200) AS error, created_at
   FROM agent_tool_calls WHERE run_id = <RUN_ID> ORDER BY id DESC LIMIT 20;"
```

- Baris terakhir `browser_verify` / `browser_*` dengan status
  `failed` + kolom `error` berisi penyebabnya (budget, port, MCP
  gagal start, timeout 30 dtk).
- Bila tidak ada baris browser sama sekali padahal flag nyala:
  pipeline tidak pernah membuat klien — cek log server untuk
  `agent pipeline: browser tools tidak bisa dibuat` /
  `browser tools gagal start` (flag nyala tapi Chrome/MCP tidak
  tersedia → agent jalan tanpa alat browser).
- Bila baris terakhir sudah lama tapi `agent_runs.status` masih
  `running`: cek log JSON server di sekitar waktu itu untuk
  `browser: memori Chrome akhir run` (Close sudah jalan = run
  selesai menutup browser) atau `browser: stderr server MCP`
  (server MCP masih hidup / menggantung). Timeout per panggilan 30
  dtk membatasi satu panggilan menggantung; run yang macet total
  biasanya bukan di panggilan browser, melainkan di antrean / LLM.
- Log JSON server: cari berdasarkan `runId` (contoh grep):
  `grep '"runId":<RUN_ID>' <log-server> | grep -i browser`.

Kolom `agent_tool_calls`: `id, run_id, tool, phase, status, input
(maks 4000 karakter), output (maks 8000), error (maks 2000),
created_at`. Input/output/error dipotong di situ — untuk output tool
lengkap, lihat log JSON server atau `/metrics` (durasi per tool).

# Catatan Spike Fase 0 — chrome-devtools-mcp di VM

Tanggal: 15 Nov 2026. Branch: `feature/mcp-browser-tools` (basis main `3b09b04`).
Tujuan spike: membuktikan asumsi paling berisiko dari rencana
(`docs/mcp-browser-integration-plan.md` §6) sebelum menulis kode produksi.
Skrip klien stdio yang dipakai: `~/workspace/go-tmp/mcp-spike.mjs`
(tidak di-commit — hanya alat spike; log mentah tiap run ada di
`~/workspace/go-tmp/spike-run{1,2,3,4}-*.log`).

## Keputusan: LANJUT ke Fase 1

Semua kriteria selesai terpenuhi di **kedua** jalur browser: satu halaman lokal
berhasil dibuka (`navigate_page`), snapshot terbaca, console terbaca (termasuk
pesan error), dan screenshot tersimpan sebagai PNG. Mode headless +
`--no-sandbox` jalan tanpa display. Fallback Chromium Playwright ternyata
**jalan penuh** — bukan sekadar "mungkin jalan".

## 1. Versi & path yang terpasang

| Komponen | Versi | Path |
|---|---|---|
| Chrome for Testing | **157.0.8103.78** (`Google Chrome for Testing 157.0.8103.78`) | `/home/hatch/workspace/chrome/linux-157.0.8103.78/chrome-linux64/chrome` (408 MB) |
| chrome-devtools-mcp | **1.13.0** (npm `latest` per 15 Nov 2026; `serverInfo.version: 1.13.0`) | dijalankan via `npx -y chrome-devtools-mcp@1.13.0` (cache `~/.npm`) |
| @puppeteer/browsers (installer) | 3.2.7 | `npx -y @puppeteer/browsers@3.2.7 install chrome@stable` |
| Chromium Playwright (fallback) | **153.0.8010.12** (biner ini melaporkan diri sebagai `Google Chrome for Testing 153.0.8010.12`) | `/home/hatch/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome` |
| Node | v24.22.3 | — |

Catatan instalasi: `@puppeteer/browsers install chrome@stable` menyimpan ke
`~/workspace/chrome/` (bukan `~/.cache/puppeteer`) karena dijalankan dari
`~/workspace`. Lokasi ini persisten di bawah home — bukan `/tmp`, aman dari
reboot. Untuk Fase 1, path Chrome sebaiknya di-pin lewat env
`CHROME_FOR_TESTING_PATH` ke path di atas (jangan mengandalkan auto-detect).

## 2. Cara menjalankan server MCP (yang terbukti jalan)

```bash
npx -y chrome-devtools-mcp@1.13.0 \
  --headless --isolated \
  --no-usage-statistics --no-performance-crux \
  --chrome-arg=--no-sandbox --chrome-arg=--disable-setuid-sandbox \
  --executablePath /home/hatch/workspace/chrome/linux-157.0.8103.78/chrome-linux64/chrome \
  --workspace /home/hatch/workspace/go-tmp/mcp-test
```

Env tambahan di klien: `CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS=1`, `CI=1`
(server mengonfirmasi: "turning off usage statistics").

Poin penting yang ditemukan:

- **`--no-sandbox` bukan flag server** — harus lewat
  `--chrome-arg=--no-sandbox` (plus `--disable-setuid-sandbox`).
  Tanpa ini Chrome di VM ini tidak bisa start (tanpa display, user root).
- **Semua tool per-halaman butuh `pageId`** (pageIdRouting default `true`
  di v1.13.0). Tanpa `pageId`, `navigate_page`/`take_snapshot`/
  `list_console_messages`/`take_screenshot` menolak dengan
  `Input validation error: pageId: Invalid input: expected number, received undefined`
  (terbukti di run 1). `pageId` didapat dari `list_pages` — formatnya teks
  markdown (`## Pages\n1: about:blank [selected]`), angka di depan adalah
  `pageId` (halaman pertama = `1`). Alternatif: `--no-page-id-routing`
  (belum diuji — tidak perlu untuk Fase 1 yang satu halaman per run).
- **`take_screenshot` butuh `--workspace`** (atau `--allowUnrestrictedPaths`):
  secara default tool file hanya boleh menulis ke direktori temp OS.
  Dengan `--workspace <dir>`, `filePath` di dalam dir itu diterima.
- `tools/list` mengembalikan **33 tool** (bukan 60+ — kategori Extensions,
  PWA, WebAuthn, NetworkMocks, WebMCP, dan Memory-debugging mati secara
  default; `take_heapsnapshot` tetap muncul di daftar).

## 3. Hasil panggilan — Chrome for Testing (run 3, sukses penuh)

Halaman uji: `http://127.0.0.1:18099/index.html` (file
`~/workspace/go-tmp/mcp-test/index.html`, disajikan `python3 -m http.server 18099`).
Isi halaman: `<h1>`, satu paragraf, satu tombol, plus `console.log` /
`console.warn` / `console.error` sengaja.

| Panggilan | Hasil | Latensi |
|---|---|---|
| `initialize` | OK (`protocolVersion 2025-03-26`, server `chrome_devtools` 1.13.0) — termasuk start Chrome | **2119 ms** |
| `tools/list` | OK, 33 tool | 13 ms |
| `list_pages` | OK, `1: about:blank [selected]` | 729 ms |
| `navigate_page` | OK, `Successfully navigated to http://127.0.0.1:18099/index.html` | 206 ms |
| `take_snapshot` | OK — heading, paragraf, tombol terbaca dari accessibility tree | 16 ms |
| `list_console_messages` | OK — 4 pesan: log + warn + error contoh + 1 error 404 `favicon.ico` | 5 ms |
| `take_screenshot` | OK — tersimpan `screenshot-cft.png`, PNG 1905×2053, 76.161 byte | 177 ms |

Total run (initialize → screenshot): ~3,3 detik. Setelah `initialize`,
semua panggilan berikutnya < 250 ms.

## 4. Hasil fallback — Chromium Playwright 1243 (run 4, sukses penuh)

Perintah sama, hanya `--executablePath` diganti ke
`/home/hatch/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`.

| Panggilan | Hasil | Latensi |
|---|---|---|
| `initialize` | OK | 1677 ms |
| `tools/list` | OK, 33 tool (identik) | 13 ms |
| `list_pages` | OK | 1846 ms |
| `navigate_page` | OK | 194 ms |
| `take_snapshot` | OK (isi identik dengan CfT) | 29 ms |
| `list_console_messages` | OK (4 pesan, identik) | 7 ms |
| `take_screenshot` | OK — `screenshot-chromium.png`, PNG 1905×2053, 76.161 byte, **md5 identik** dengan screenshot CfT (`20d9fe43d7c5e76b2cd495170a2d93ca`) | 118 ms |

**Kesimpulan fallback: JALAN.** Bukti: semua 7 panggilan sukses, snapshot dan
console identik, screenshot byte-identik (md5 sama). Chromium Playwright 1243
boleh masuk rencana sebagai fallback bila Chrome for Testing tidak ada di host
deploy — dengan catatan: biner ini melaporkan versi `153.0.8010.12` (lebih tua
dari CfT 157) dan status dukungannya tetap "tidak dijamin" oleh upstream, jadi
CfT tetap jalur utama; fallback hanya dipakai bila CfT tidak terinstal.

## 5. Headless + no-sandbox

Kedua run memakai `--headless --isolated` + `--chrome-arg=--no-sandbox
--chrome-arg=--disable-setuid-sandbox`, tanpa display, tanpa variabel
`DISPLAY`. Keduanya sukses. Tidak ada proses Chrome/MCP yang tertinggal
sesudah run (dicek `ps` — bersih; server MCP dimatikan SIGTERM oleh skrip
klien dan Chrome ikut mati).

## 6. Hal-hal kecil yang perlu diingat untuk Fase 1

- 404 `favicon.ico` muncul di console untuk halaman tanpa favicon — bukan
  error aplikasi; acceptance harus mengabaikan/membedakan 404 favicon.
- Screenshot default 1905×2053 (viewport headless default cukup tinggi);
  pertimbangkan `--viewport 1280x720` atau `--screenshotMaxWidth` agar ukuran
  file dan token konteks terkendali.
- `list_pages` mengembalikan teks markdown, bukan JSON terstruktur — klien Go
  harus mem-parse angka `pageId` dari teks (atau pakai
  `--no-page-id-routing` bila satu halaman per run sudah cukup).
- Server MCP mencetak peringatan privasi ke stderr saat start (bukan error).
- Isolated profile: `--isolated` membuat user-data-dir temporer yang
  dibersihkan otomatis saat browser ditutup — sesuai kebutuhan "satu profil
  per run" di rencana.

## 7. Yang TIDAK diuji di Fase 0 (di luar lingkup)

- `lighthouse_audit`, `performance_*_trace`, `emulate`/`resize_page`,
  `list_network_requests` — alat allowlist lain, diuji di Fase 2.
- `--no-page-id-routing`.
- Menjalankan MCP dari Go (SDK `modelcontextprotocol/go-sdk`) — itu Fase 1.
- Chrome di DockerExecutor — Fase 1–3 hanya ProcessExecutor (lihat rencana §9).

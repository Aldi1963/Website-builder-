# AUDIT — Rewrite Panel Admin VibeBuilder ke React

> Audit statis cakupan (bukan uji runtime). Dibuat 2026-11-26 oleh agen AUDIT.
> Repo `~/workspace/vibebuilder`, HEAD `3e2e0e8` — **working tree kotor**:
> `SPEC.md` + 21 file `src/pages/*.tsx` + `src/components/Table.tsx` termodifikasi,
> komponen `BCharts/BFormDialog/BFormat/CFormDialog/CFormat/CProviderCard`
> untracked. Audit ini memeriksa **isi working tree saat ini**, bukan HEAD.
> Tidak ada file kode yang diubah oleh audit ini; satu-satunya file yang ditulis
> adalah dokumen ini.
>
> Sumber yang dibaca penuh: `admin-react/SPEC.md` (§0–§3, 2039 baris),
> `admin-react/src/pages/*.tsx` (22 file, dibaca baris demi baris),
> `admin-react/src/routes.ts`, `admin-react/src/layout.tsx`,
> `admin-react/src/main.tsx`, `admin-react/src/index.html`,
> `admin-react/src/lib/{api,auth,router,toast}.tsx`,
> `admin-react/src/components/*` (termasuk `BFormat/CFormat/DFormat`,
> `BFormDialog/CFormDialog`, `CProviderCard`, `BCharts`),
> `server/src/admin/admin.js` (spot-check perilaku lama) dan
> `server/src/admin/src/shell.html` (urutan + label menu).
>
> Metode: untuk tiap halaman, endpoint SPEC §1.x dicocokkan dengan string
> `api.*('/api/...')` di file halaman (grep), dan tiap aksi UI dicocokkan
> dengan label/handler di kode. Klaim grup halaman tidak dipercaya begitu saja.

## Ringkasan

| Ukuran | Hasil |
|---|---|
| Halaman diperiksa | 22 |
| **LOLOS** (semua endpoint + aksi UI SPEC ada di kode) | **21** |
| **GAP** | **1** — Plan (minor, diwarisi dari kode lama; lihat §1.6) |
| Endpoint SPEC §2 yang ada call-site-nya di `src/` | **64 dari 64** (62 `/api/admin/*` + 2 `/api/auth/*`) |
| Stub tersisa (`"sedang ditulis ulang"`) | **0** — grep `src/` tidak menemukan frasa itu |
| `npx tsc --noEmit` | **LOLOS** (exit 0, tanpa error) |
| `npm run build` (`tsc --noEmit && vite build`) | **LOLOS** (exit 0, built 1,60 dtk; 22 chunk halaman lazy + `index` 357,45 kB) |
| Temuan lintas halaman (global) | **6 gap** — semuanya di luar halaman: pencarian header + Ctrl+K hilang, tombol fullscreen hilang, skip-link hilang, judul dokumen statis, sidebar desktop tidak bisa di-collapse, label tautan keluar sidebar salah |

Catatan konteks (dari `MEMORY.md`, diperbarui saat audit berjalan): panel lama
(server-rendered Metis) tetap dipertahankan sebagai cadangan sampai user
memeriksa React di HP dan menyatakan OK — jadi gap di bawah ini belum
mematikan panel lama.

## 1) Tabel per halaman

Legenda verdict: **LOLOS** = semua endpoint §1.x + aksi UI ada di kode.
**GAP** = ada yang hilang/salah. "Diwarisi" = perilaku sudah begitu di
`admin.js` lama dan SPEC menandainya sebagai pertanyaan terbuka (§3) —
tetap dicatat, bukan dihaluskan.

| # | Halaman (file) | Verdict | Gap / catatan |
|---|---|---|---|
| 1.1 | Dashboard (`pages/dashboard.tsx`, 214 brs) | LOLOS | Catatan: refresh hanya memuat ulang halaman, tidak badge/notifikasi (lihat G-7). Badge `#chart-range-label` sengaja kosong, sama seperti lama (SPEC §3 Q1; komentar baris 128–129). |
| 1.2 | Pengguna (`pages/users.tsx`, 199 brs) | LOLOS | PATCH + DELETE + toast + konfirmasi + `akun ini` untuk baris sendiri semua ada. `adminEmail` diterima tapi tidak dipakai UI — sama seperti lama (SPEC §1.2). |
| 1.3 | Proyek (`pages/projects.tsx`, 153 brs) | LOLOS | GET + DELETE, tautan `Buka` → `/proyek/<id>`, slug → `/p/<slug>`, badge status 5 varian, konfirmasi + toast `Proyek dihapus.` |
| 1.4 | Moderasi (`pages/moderasi.tsx`, 324 brs) | LOLOS | 5 endpoint (GET moderation, flag POST/DELETE, suspend, unsuspend) + alert kuning + form alasan + konfirmasi + unsuspend tanpa konfirmasi. |
| 1.5 | Domain (`pages/domain.tsx`, 284 brs) | LOLOS | GET domains + GET projects paralel, POST, verify (hasil DNS lengkap: CNAME/A/`expectedCname`/`note`/`ssl`), DELETE. Catatan: tanpa opsi proyek kosong — bila 0 proyek, submit mengirim `projectId ''` dan gagal di server; perilaku lama yang sama (SPEC §3 Q17, belum diputuskan). |
| 1.6 | Plan (`pages/plans.tsx`, 327 brs) | **GAP (minor)** | **G-1: form tambah/ubah tidak mengirim `monthlyCredits`.** `submitAdd` (baris 84–92) dan `submitEdit` (102–110) hanya mengirim `name, tokenLimit, priceIdr, description`; field `monthly_credits` ada di interface `Plan` (baris 20) tapi tidak pernah dikirim. Akibat: plan baru via UI selalu `monthly_credits = 0` dan jatah credit plan itu tidak pernah terisi — persis bug lama yang didokumentasikan SPEC §1.6 + §3 Q5. Keputusan Q5 belum ada; React mereplikasi, bukan memperbaiki. Minor lain: field `Nama plan` di dialog Ubah (via konstanta `PLAN_FIELDS`, baris 39–44) tidak punya `help: 'cth. Pro, Starter, Enterprise'` seperti di dialog Tambah (baris ~286). |
| 1.7 | Kelola Credit (`pages/credits.tsx`, 532 brs) | LOLOS | 5 endpoint + 7 field pengaturan + cari (state awal `Ketik email/nama lalu tekan Cari.`, Enter = Cari) + detail 4 kartu saldo + adjust (validasi `Isi jumlah dan alasan.`) + 3 tabel riwayat + `scrollIntoView` detail. |
| 1.8 | Penggunaan (`pages/usage.tsx`, 140 brs) | LOLOS | GET usage, 4 kartu (counter in-memory, bukan `totals.tokens`), grafik 3 dataset, 2 tabel + empty state. |
| 1.9 | Biaya LLM (`pages/biaya.tsx`, 431 brs) | LOLOS | GET cost `?days=`, PUT prices (map utuh), CSV via `downloadFile` (nama `biaya-llm-{semua\|Nd}hari.csv`), select 7/30/0, 4 kartu, 3 tabel harga (termasuk baris `Isi harga` untuk model tanpa harga). Catatan: `Number(vals.prompt) \|\| 0` (baris ~123–133) — input kosong tersimpan sebagai 0, bukan "belum diketahui"; semantik lama yang dipertahankan (SPEC §3 Q16). |
| 1.10 | Provider LLM (`pages/providers.tsx` 85 brs + `components/CProviderCard.tsx`) | LOLOS | 7 endpoint (GET providers, PUT provider, PUT model aktif/tarif, PUT key, POST test, POST sync, POST prices/sync) + `encodeURIComponent(modelId)` (baris ~200, ~215 — memenuhi SPEC §3 Q15) + pencarian model + badge + `PROVIDER_NOTES` verbatim (SPEC §3 Q6). Minor: hasil Tes koneksi memakai `r.status ?? 200` (baris 246) — bila server tidak mengembalikan `status`, tampil "200" padahal kode lama mencetak nilai `status` apa adanya. Minor: label `Aktif/Nonaktif` dirender dua kali berdampingan (prop `label` Toggle + `<span>`). |
| 1.11 | Pembayaran (`pages/billing.tsx`, 293 brs) | LOLOS | GET + PUT billing, badge sumber key env/panel/belum, alert env, salin webhook (clipboard + fallback `execCommand`), 4 baris status, paket, order counts, tabel event, kartu `Cara Mengganti Key`. Minor: fallback salin selalu toast `Webhook URL disalin.` (baris 89–96) walau `execCommand('copy')` gagal — tidak ada pengecekan hasil. |
| 1.12 | Build (`pages/builds.tsx`, 111 brs) | LOLOS | GET `?limit=100`, modal log (state, bukan atribut `data-log` — sesuai anjuran SPEC), judul `Log build #<id> — <nama>`, `(log kosong)`. |
| 1.13 | Pesan (`pages/messages.tsx`, 120 brs) | LOLOS | GET `?q=&limit=100`, cari via tombol + Enter (form submit), badge peran, empty state `Tidak ada pesan.` |
| 1.14 | Pengumuman (`pages/pengumuman.tsx`, 345 brs) | LOLOS | 5 endpoint (GET/POST/PUT/DELETE/activate), aktifkan pakai konfirmasi, nonaktifkan tanpa konfirmasi + `POST {active:false}`, kutipan isi 120 karakter, alert + kartu Catatan banner tertunda. |
| 1.15 | Sesi (`pages/sessions.tsx`, 137 brs) | LOLOS | GET + DELETE, tombol `Cabut` hanya bila aktif, konfirmasi + toast `Sesi dicabut.` Minor: teks konfirmasi memakai `revokeTarget?.email ?? ''` (baris ~118) — bila `email` null, tampil `Cabut sesi login milik ?` |
| 1.16 | Kesehatan Sistem (`pages/health.tsx`, 204 brs) | LOLOS | GET health + GET alerts (gagal alerts ditelan diam-diam), 4 kartu stat, kartu LLM Gateway, ambang peringatan + footer `key alert_thresholds`. **BUG lama §3 Q3 DIPERBAIKI**: `previews` dirender sebagai array `{projectId, port}` (baris ~175–185), bukan `Object.entries` seperti `admin.js` yang menampilkan indeks + `[object Object]`. |
| 1.17 | Cadangan & Pulihkan (`pages/cadangan.tsx`, 269 brs) | LOLOS | GET backup/list, unduh via `<a href="/api/admin/backup">`, restore JSON `{backup}` + restore upload `FormData` (field `file`, `accept=".db,application/octet-stream"`; `lib/api.ts` tidak memaksa header JSON untuk FormData — benar), 4 kartu stat, tombol Pulihkan hanya untuk `isAutoBackup`. Minor: restore otomatis gagal hanya toast error (baris 71), sedangkan restore upload gagal ditampilkan di area `#restore-result` (baris ~128–134) — asimetri tampilan error antar dua jalur restore. |
| 1.18 | Pembersihan (`pages/pembersihan.tsx`, 198 brs) | LOLOS | GET + POST run + PUT settings, 3 kartu, form retensi 1–365 + switch auto, kartu Hasil Terakhir + Catatan, konfirmasi + toast `Pembersihan selesai: N build, M sesi dihapus.` |
| 1.19 | Log Audit (`pages/audit.tsx`, 184 brs) | LOLOS | GET `?q=&action=&limit=100`, filter aksi + cari, subtitle `N entri log`, logika cache aksi (`if (!act && actions.length)` — sama seperti SPEC §1.19). |
| 1.20 | Pemeliharaan (`pages/pemeliharaan.tsx`, 177 brs) | LOLOS | GET + PUT maintenance, alert `Belum berlaku.`, pratinjau mengikuti isi textarea (state `message`, baris ~100), kartu Status, toast berbeda untuk aktif/nonaktif. |
| 1.21 | Pengaturan AI (`pages/ai-settings.tsx`, 282 brs) | LOLOS | GET + PUT (key hanya dikirim bila terisi; string kosong ikut terkirim = hapus dari DB) + POST test (HTTP 200, `ok:false` di body), badge sumber panel/env/default, kartu Konfigurasi Efektif + Hasil Tes + Sumber Nilai. |
| 1.22 | Pengaturan (`pages/settings.tsx`, 137 brs) | LOLOS | GET settings, 8 baris konfigurasi, kartu Admin (`via` env/first-account), kartu Catatan. Read-only, tanpa form — sesuai SPEC. |

## 2) Temuan lintas halaman (global)

### 2.1 GAP global — fitur shell lama yang tidak ada di React

| ID | Temuan | Bukti |
|---|---|---|
| **G-2** | **Pencarian header + Ctrl+K hilang total.** SPEC §0.8 (`searchComponent`: min 2 karakter, maks 6 hasil, filter substring 22 judul) dan §0.13 (Ctrl+K fokus ke `[data-search-input]`) tidak diimplementasikan di mana pun. `layout.tsx` tidak punya input pencarian; grep `Ctrl+K`, `searchComponent`, `ADMIN_PAGES` di `src/` + `index.html` = 0 hasil. Satu-satunya pencarian yang ada adalah pencarian per-halaman (Pesan, Credit, Audit, model Provider). | `src/layout.tsx` (seluruh file); grep kosong |
| **G-3** | **Tombol fullscreen hilang.** SPEC §0.12: `[data-fullscreen-toggle]`, tampil `d-none d-lg-inline-block`. Tidak ada di `layout.tsx`. | grep `fullscreen` di `src/` = 0 |
| **G-4** | **Skip-link hilang.** `shell.html` punya `<a href="#main-content" class="skip-link">Lewati ke konten utama</a>`; React tidak punya. (`<main id="main-content">` sendiri ada di `layout.tsx`.) | grep `skip-link\|Lewati ke konten` di `src/` = 0 |
| **G-5** | **Judul dokumen statis.** SPEC §0.1: `<title>{{PAGE_TITLE}} — Admin VibeBuilder</title>` per halaman (22 judul berbeda di `build-pages.mjs`). React: `index.html` baris 7 hardcode `<title>Admin — VibeBuilder</title>` dan tidak ada `document.title` di mana pun di `src/` (grep = 0). Semua halaman tampil dengan judul tab yang sama. Judul di `routes.ts` (baris 97–118) hanya dipakai sebagai label menu, bukan judul dokumen. | `admin-react/index.html:7`; grep `document.title` = 0 |
| **G-6** | **Sidebar desktop tidak bisa di-collapse; status collapse tidak disimpan.** SPEC §0.12: tombol `[data-sidebar-toggle]` di desktop menambah/menghapus `sidebar-collapsed` + simpan `localStorage['sidebar-collapsed']`. React: tombol hamburger hanya ada di mobile (`lg:hidden`, `layout.tsx` ~baris 262); tidak ada state collapse desktop, tidak ada kunci `sidebar-collapsed` (grep = 0). Sidebar desktop selalu tampil penuh 256px. | `src/layout.tsx`; grep `sidebar-collapsed` = 0 |
| **G-7** | **Tombol refresh Dashboard tidak me-refresh badge nav + notifikasi.** `admin.js` lama (baris 1717–1723): refresh memuat ulang overview + `fillNavBadges` + `fillNotifications` + halaman + toast. React: `refresh()` di `pages/dashboard.tsx` baris 61–63 hanya memanggil `load()` halaman; badge/notifikasi di `layout.tsx` hanya diambil sekali saat mount (`useEffect []`). Setelah refresh, badge sidebar + lonceng bisa basi sampai remount layout. | `src/pages/dashboard.tsx:61-63`, `src/layout.tsx` (effect mount) |
| **G-8** | **Label tautan keluar sidebar salah.** `shell.html` memakai `Kembali ke Builder`; `routes.ts` baris 126 mendefinisikan `SITE_LINK = { title: 'Lihat situs', … }` dan `layout.tsx` merender judul itu sebagai item terakhir sidebar. (Menu profil di `layout.tsx` sudah benar memakai `Kembali ke Builder`.) | `src/routes.ts:126` |
| **G-9** | **Teks layar terkunci menyimpang dari SPEC §0.2 (tanpa interpolasi email).** Lama: belum masuk → `Panel admin hanya untuk akun yang sudah masuk. Masuk lewat Builder, lalu kembali ke sini.`; bukan admin → `` `Akun ${email} bukan admin. Hanya pemilik instalasi yang bisa membuka panel ini.` ``. React (`main.tsx` baris 79–91): `Masuk dulu untuk membuka panel admin.` dan `Akun ini masuk, tetapi bukan admin. Hanya admin yang boleh membuka panel ini.` — email tidak ditampilkan. Mekanisme gate-nya benar (`lib/auth.tsx`: `GET /api/auth/me` lalu `GET /api/admin/overview`, 403 → `non-admin`). | `src/main.tsx:79-91`, `src/lib/auth.tsx:34-56` |

### 2.2 Temuan lintas halaman — duplikasi & inkonsistensi antar grup

Pengelompokan impor halaman **konsisten per grup** (tidak ditemukan impor
silang yang salah): grup B (`users, projects, plans, usage, credits,
dashboard`) memakai `BFormat`/`BFormDialog`/`BCharts`; grup C (`domain,
biaya, billing, builds, messages, providers`) memakai `CFormat`/
`CFormDialog`/`CProviderCard`; grup D (`moderasi, sessions, health,
cadangan, pembersihan, ai-settings`) memakai `DFormat`. Masalahnya adalah
**isi** helper-nya yang diduplikasi, bukan arah impornya:

| ID | Temuan | Bukti |
|---|---|---|
| **D-1** | **Helper format ada 3 salinan nyaris identik.** `BFormat.ts`, `CFormat.ts`, `DFormat.ts` masing-masing mendefinisikan ulang `fmtNum/fmtRp/fmtDate/fmtDateShort/timeAgo` dengan isi yang sama persis (dibandingkan baris demi baris). Perbedaannya hanya kelengkapan: `BFormat` punya `fmtBytes` + `avatarInitial` + `errMessage`; `CFormat` **tidak** punya `fmtBytes`/`avatarInitial`/`errMessage`; `DFormat` punya `fmtBytes` + kelas tombol (`btnPrimary`, `btnOutline*`) tapi tidak punya `avatarInitial`/`errMessage`. Risiko nyata: perbaikan format di satu file tidak menjalar ke dua lainnya. | `src/components/BFormat.ts`, `CFormat.ts`, `DFormat.ts` |
| **D-2** | **Dua dialog form generik yang nyaris sama.** `BFormDialog.tsx` vs `CFormDialog.tsx` — logika init field + `Number()` untuk number (string kosong → 0) sama; beda API: B memakai `onSubmit(vals \| null)` (batal = `null`), C memakai `onCancel` + `onSubmit(vals)` + prop `saving`/`submitLabel`. Dipakai: B oleh `plans.tsx`, C oleh `biaya.tsx`. `moderasi.tsx` dan `pengumuman.tsx` tidak memakai keduanya (modal buatan sendiri via `Modal` + `Field`). | diff `BFormDialog.tsx` ↔ `CFormDialog.tsx` |
| **D-3** | **Helper format didefinisikan ulang secara lokal di 4 halaman**, padahal padanan bersama sudah ada: `fmtNum` + `fmtDate` lokal di `audit.tsx` baris 21–32; `fmtDate` lokal di `pemeliharaan.tsx` baris 20–28 dan `pengumuman.tsx` baris 24–33; `fmtBytes` lokal di `settings.tsx` baris 23–28; `errMessage` lokal di `pengumuman.tsx` baris 35–37. Isinya sama dengan `BFormat`/`DFormat`. | grep `function fmtDate\|fmtNum\|fmtBytes\|errMessage` di `src/pages/` |
| **D-4** | **Kelas tombol didefinisikan ulang per halaman** meski `DFormat` sudah menyediakan varian bersama: `users.tsx` (baris ~24–29), `projects.tsx`, `plans.tsx`, `pengumuman.tsx` (`btnBase/btnSuccess/...` lokal) masing-masing menulis string kelas sendiri. Tidak ada yang salah fungsi, tapi drift visual antar halaman mudah terjadi. | `src/pages/users.tsx`, `projects.tsx`, `plans.tsx`, `pengumuman.tsx` |
| **D-5** | **Komponen mati (dead code).** `components/Pagination.tsx` dan `components/EmptyState.tsx` tidak diimpor oleh halaman, layout, maupun main manapun (grep = 0 pemakaian; `EmptyState` hanya disebut di komentar `toast.tsx` baris 79). Wajar — SPEC §0.17 menyatakan tidak ada pagination server-side di halaman manapun — tapi file-nya tetap ada tanpa pemakai. | grep pemakaian = 0 |
| **D-6** | **Grafik bukan Chart.js lagi (perbedaan implementasi, bukan gap).** `BCharts.tsx` menggambar line/doughnut sebagai SVG sendiri: tanpa kurva `tension: 0.3` (polyline lurus), tanpa tooltip/hover, tanpa `destroy()` antar render. Palet warna sama (`CHART_COLORS` = `chartColors` lama). Doughnut menambah angka total di tengah — tidak ada di Chart.js lama (tambahan, bukan kekurangan). Perilaku ini hanya bisa dinilai visual (lihat §4). | `src/components/BCharts.tsx` |
| **D-7** | **Badge kesehatan nav diisi di layout, bukan di halaman Kesehatan.** SPEC §0.11: `#nav-health-badge` hanya diisi `loadHealth()`. React: `layout.tsx` memanggil `GET /api/admin/health` di setiap mount layout dan menampilkan badge `OK`/`LLM mati` di semua halaman. Perilaku superset (badge selalu ada), bukan kekurangan — dicatat karena menyimpang dari kontrak. | `src/layout.tsx` (effect + `badgeFor('health')`) |
| **D-8** | **Footer notifikasi selalu tampil.** SPEC §0.10: tautan `Lihat semua aktivitas` hanya bila ada aktivitas; bila kosong, item `Belum ada aktivitas.` berupa tautan ke `/admin`. React (`layout.tsx`): footer tautan selalu dirender (juga saat kosong) dan empty state berupa `<p>` tanpa tautan. Minor. | `src/layout.tsx` (dropdown notifikasi) |

### 2.3 Yang diperiksa dan dinyatakan SESUAI (agar tidak ditanya ulang)

- **routes.ts**: 22 entri (baris 97–118), path + judul label + ikon Phosphor
  1:1 dengan `shell.html` (urutan identik; pemisah seksi `Admin` sebelum
  `audit` via `ADMIN_SECTION_SLUGS`; ikon: Gauge/speedometer2, Users/people,
  Cube/box, Flag, Link, Medal/award, Coins, ChartLine, CurrencyDollar, Plug,
  CreditCard, Hammer, ChatText, Megaphone, Key, Heartbeat, Archive, Trash,
  ClockCounterClockwise, Wrench, Robot, Gear). Semua slug diimpor lazy
  eksplisit (tanpa template dinamis). `matchRoute` mendukung segmen `:param`.
- **Tema**: kunci `theme` + fallback `vb-admin-theme` + default
  `prefers-color-scheme` + penerapan sebelum paint dipertahankan
  (`index.html` baris 9–17 memakai class `dark` di `<html>`; toggle di
  `layout.tsx` menulis `localStorage['theme']`). Perbedaan: lama memakai
  atribut `data-bs-theme`, React memakai class `dark` — konsekuensi desain
  baru (Tailwind), bukan kehilangan perilaku.
- **Toast** (`lib/toast.tsx`): `delay` 4000 ms, tombol close, `aria-live`,
  pesan error = pesan server (`ApiError.message` dari `data.error`, fallback
  `Permintaan gagal (N).` di `lib/api.ts`) — sesuai SPEC §0.4/§0.5.
- **Modal**: `Modal.tsx` menutup dengan Escape (baris 19–24); `ConfirmDialog`
  dipakai semua aksi destruktif dengan judul/teks/label-Ya sesuai SPEC.
- **Auth/boot** (`lib/auth.tsx`, `main.tsx`): `GET /api/auth/me` →
  `GET /api/admin/overview` (403 → layar terkunci), logout `POST
  /api/auth/logout` lalu `location.href = '/'`, route tak dikenal → halaman
  `NotFound` dengan tautan ke Dashboard (keputusan atas SPEC §3 Q12).
- **Cadangan restore**: `lib/api.ts` tidak memaksa `content-type: application/json`
  bila body `FormData` — upload `.db` terkirim sebagai multipart yang benar.
- **Endpoint**: seluruh 64 endpoint SPEC §2 ditemukan sebagai call-site
  (daftar string `/api/…` unik di `src/` mencakup semuanya; satu-satunya
  kemunculan `/api/announcements/active` hanyalah teks literal di kartu
  Catatan `pengumuman.tsx` baris 268, bukan pemanggilan — benar, endpoint itu
  memang belum ada).
- **Perilaku lama yang sengaja dipertahankan** (bukan gap): badge
  `#chart-range-label` kosong (§3 Q1); `monthlyCredits` tidak dikirim (§3 Q5,
  tapi dicatat sebagai G-1 karena berdampak); `PROVIDER_NOTES` verbatim
  termasuk tanggal PRO Gater 2 Des 2026 (§3 Q6); input number kosong → 0 di
  form dialog (§3 Q16); tanpa polling/auto-refresh (§3 Q8); restore tanpa
  pengecekan kesiapan server (§3 Q9).

## 3) Hasil verifikasi build

Dilaksanakan di `admin-react/` pada 2026-11-26 (perintah audit, hanya verifikasi):

| Perintah | Hasil |
|---|---|
| `npx tsc --noEmit` | **LOLOS** — exit 0, tidak ada output/error |
| `npm run build` (= `tsc --noEmit && vite build`) | **LOLOS** — exit 0, `✓ built in 1.60s`; 22 chunk halaman lazy (`dashboard` … `settings`) + `index-CPEd7AUi.js` 357,45 kB (gzip 105,76 kB). `dist/` di-gitignore, tidak di-commit. |

## 4) Batasan audit (tidak dapat diverifikasi statis)

1. **Render visual & layout**: audit ini membaca JSX, bukan membuka browser.
   Tidak terverifikasi: apakah grafik SVG `BCharts` terbaca dengan benar,
   apakah tabel 22 halaman muat di layar HP, apakah sidebar off-canvas +
   backdrop + Escape bekerja di perangkat nyata, dan apakah tema gelap/terang
   konsisten (class `dark` vs `data-bs-theme` lama).
2. **Perilaku runtime dengan data nyata**: semua endpoint hanya dicek
   keberadaan string + bentuk pemanggilan di kode. Tidak terverifikasi:
   respons server bentuk sebenarnya (mis. `previews` array, `cost.prices`,
   `llm/providers`), penanganan 401/403 di tengah sesi, perilaku `encodeURIComponent`
   untuk model ID ber-slash (`cx/gpt-5.6-luna`, SPEC §3 Q15) terhadap server
   Hono, dan isi `downloadFile` CSV/backup saat `Content-Disposition` berbeda.
3. **Alur yang butuh interaksi berurutan**: dialog konfirmasi ganda,
   toggle provider/model yang gagal lalu reload, sinkronisasi harga, restore
   + restart server (apakah UI memang tidak mengecek kesiapan — sesuai SPEC),
   dan urutan notifikasi (alert vs aktivitas) saat kedua fetch selesai
   berurutan/bersamaan.
4. **Kesesuaian teks 100%**: teks toast/judul/konfirmasi dicocokkan dengan
   SPEC §1 secara manual; perbedaan kecil (mis. G-9, footer notifikasi D-8)
   yang ditemukan dicatat, tetapi audit statis tidak menjamin tidak ada
   selisih satu-dua kata lain di 22 halaman.
5. **Keputusan terbuka SPEC §3**: Q1, Q5, Q6, Q16 sudah diputuskan sepihak
   oleh kode (dipertahankan seperti lama) tanpa catatan keputusan dari
   pemilik — audit mencatat pilihannya, bukan menyetujuinya. Q2 (arsitektur
   SPA vs halaman penuh) terjawab oleh kode: ini SPA dengan routing klien
   (`lib/router.tsx`, satu entry `index.html`); Q11 (target visual) terjawab:
   desain baru Tailwind + Phosphor, bukan Metis/Bootstrap identik. Q3 (bug
   preview) diperbaiki tanpa konfirmasi tertulis. Sisanya (Q4, Q7–Q10,
   Q12–Q15, Q17–Q22) tetap terbuka.
6. **Cakupan**: audit tidak memeriksa server (`server/src/*`), tidak
   memeriksa apakah panel React sudah terpasang/dilayani oleh server
   (routing `/admin/*` ke SPA), dan tidak memeriksa `platform/` (builder).

## 5) Rekomendasi tindak lanjut (urut prioritas)

1. **Putuskan Q5 (G-1)** — tambah field `monthlyCredits` di form Plan, atau
   nyatakan resmi bahwa plan baru memang `monthly_credits = 0`. Ini
   satu-satunya gap halaman, dan berdampak langsung ke jatah credit pengguna.
2. **Putuskan nasib pencarian header + Ctrl+K (G-2)** — implementasikan
   (komponen kecil, daftar 22 judul sudah ada di `routes.ts`) atau nyatakan
   resmi dihapus. Ini gap global terbesar.
3. **Perbaiki label `SITE_LINK` (G-8)** — satu baris (`routes.ts:126`):
   `'Lihat situs'` → `'Kembali ke Builder'`.
4. **Judul dokumen per halaman (G-5)** — set `document.title` dari
   `route.title` saat navigasi (mis. di `RouterProvider`/`App`).
5. **Collapse sidebar desktop + `localStorage['sidebar-collapsed']` (G-6)**,
   tombol fullscreen (G-3), skip-link (G-4) — kecil, satu tempat
   (`layout.tsx`/`index.html`).
6. **Samakan teks layar terkunci dengan SPEC §0.2 (G-9)** — sertakan email
   pada kasus bukan-admin.
7. **Konsolidasi helper (D-1 s.d. D-4)** — satu `lib/format.ts` + satu
   `FormDialog` + satu set kelas tombol; hapus `Pagination.tsx` +
   `EmptyState.tsx` bila memang tidak dipakai (D-5). Bukan fungsional, tapi
   mencegah drift pada perawatan berikutnya.
8. **Verifikasi runtime** (di luar audit statis): buka tiap halaman dengan
   server nyata, uji 64 endpoint end-to-end, uji HP (menu, tabel, tema),
   dan uji model ID ber-slash (SPEC §3 Q15).

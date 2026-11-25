# SPEC — Rewrite Panel Admin VibeBuilder ke React

> Kontrak build untuk 4 agen halaman. Dokumen ini hasil audit baca-penuh kode
> yang sedang berjalan (bukan dari ingatan). Semua path endpoint, nama field
> respons, dan teks Indonesia dikutip persis dari kode sumber.
>
> - Repo: `~/workspace/vibebuilder`, git HEAD `718a88c`, working tree bersih
>   (satu file untracked di luar cakupan: `template/src/lib/rag.ts`).
> - Sumber yang dibaca penuh:
>   - `server/src/admin/admin.js` (1782 baris)
>   - `server/src/admin/src/shell.html` (405 baris)
>   - `server/src/admin/src/pages/*.html` (22 fragmen, 753 baris)
>   - `server/src/admin/src/build-pages.mjs` (generator komposisi shell)
>   - `server/src/admin.ts` (1992 baris)
>   - `server/src/app.ts` (bagian auth + mount admin)
>   - `server/src/admin/VENDOR.md`
>   - Pendukung untuk bentuk respons: `server/src/billing.ts`
>     (`GET`/`PUT /api/admin/billing`), `server/src/providers.ts`
>     (`/api/admin/llm/*`), `server/src/credits.ts`
>     (`getBalance`/`getUserPlan`/`getCreditSettings`/`adjustCredit`),
>     `server/src/auth.ts` (tipe `User`, cookie sesi),
>     `server/src/workspace.ts` (`runningPreviews`), `server/src/llm.ts`
>     (`llmUsage`).
> - Aturan cakupan: rewrite HANYA mengganti sisi penyajian (HTML + `admin.js`).
>   API server (`/api/admin/*`, `/api/auth/*`) TIDAK berubah. Bila sebuah
>   perilaku di bawah ini ternyata bug di kode lama, SPEC menandainya eksplisit
>   sebagai **BUG / PERILAKU SAAT INI** — agen build TIDAK boleh diam-diam
>   "memperbaiki" tanpa keputusan; lihat §3.

---

## 0) Global

### 0.1 Arsitektur penyajian saat ini (yang digantikan React)

- Setiap route admin adalah **halaman server-rendered penuh** (bukan SPA).
  Komposisi dilakukan saat build oleh `server/src/admin/src/build-pages.mjs`
  (`node build-pages.mjs`): `src/shell.html` + `src/pages/<id>.html` →
  `server/src/admin/pages/<id>.html` (22 file, ter-commit di git).
  Placeholder yang diganti generator:
  `{{PAGE_TITLE}}`, `{{BODY_DATA_PAGE}}`, `{{PAGE_CONTENT}}`,
  `{{NAV_ACTIVE:<id>}}` → `' active'` untuk halaman aktif, `''` untuk lainnya.
  Generator melempar error bila ada placeholder `{{...}}` tersisa.
- Server menyajikan file hasil build itu lewat `serveAdminFile`
  (`server/src/admin.ts`): `GET /admin` dan `GET /admin/<slug>`,
  header `Cache-Control: no-store`. `GET /admin/` → redirect 302 ke `/admin`.
- Aset statis (disajikan `no-store` juga, kecuali lewat `vendor/assets`):
  - `GET /admin/assets/admin.js` → `server/src/admin/admin.js`
  - `GET /admin/assets/admin-icons.css` → `server/src/admin/admin-icons.css`
  - `GET /admin/assets/*` → `server/src/admin/vendor/assets/<rest>` dengan
    whitelist ekstensi: `.css .js .mjs .woff2 .woff .ttf .svg .png .jpg .ico
    .json .map`. Path mengandung `..` atau berawalan `/` → 404.
  - Isi vendor (lihat `server/src/admin/VENDOR.md`): template Metis 3.7.2
    (Bootstrap 5.3.9 + Bootstrap Icons + Inter Variable, MIT),
    `bootstrap.bundle.min.js`, `alpine.min.js` (Alpine.js 3.17.5),
    `chart.umd.min.js` (Chart.js 4.6.1).
- **Keputusan arsitektur untuk React (wajib ditegaskan sebelum build):**
  apakah React tetap memakai pola "satu halaman penuh per route, disajikan
  server" (pengganti drop-in `pages/*.html` + `admin.js`) atau menjadi SPA
  dengan routing klien. SPEC ini mendeskripsikan perilaku per route apa pun
  pola yang dipilih; pola SPA harus tetap memenuhi semua perilaku §0 dan §1.
- Judul dokumen: `<title>{{PAGE_TITLE}} — Admin VibeBuilder</title>`.
  Daftar judul ada di `build-pages.mjs` dan di §1 tiap halaman.

### 0.2 Alur auth (me → admin check → 403)

Urutan di `boot()` (`admin.js`, akhir file):

1. `GET /api/auth/me` (lihat §2).
   - Respons: `{ user: <User|null>, signupOpen: boolean }`.
   - `User` (`server/src/auth.ts`): `{ id, email, name, created_at,
     disabled? }`. `created_at` = epoch ms. TIDAK ada field role.
   - Sesi dibaca dari cookie `vb_session` (`SESSION_COOKIE`).
2. Bila `me.user` null → **layar terkunci "belum masuk"**:
   - Judul: `Masuk dulu`
   - Teks: `Panel admin hanya untuk akun yang sudah masuk. Masuk lewat
     Builder, lalu kembali ke sini.`
   - Tombol aksi (label default): `Buka Builder & Masuk`, href `/`.
   - `#page-content` disembunyikan (`d-none`), `#locked-screen` ditampilkan.
   - Loading screen tetap disembunyikan.
3. Bila ada user → simpan `window.__vbAdminMe = me.user.email`, isi
   `#user-email-label` dengan email, lalu `GET /api/admin/overview`.
   - Bila overview balas **403** → **layar terkunci "bukan admin"**:
     - Judul: `Bukan admin`
     - Teks: `` `Akun ${me.user.email} bukan admin. Hanya pemilik instalasi
       yang bisa membuka panel ini.` ``
     - Tombol aksi: `Kembali ke Builder`, href `/`.
   - Bila overview gagal dengan status lain → error dilempar ke `catch`
     boot → toast error, loading screen disembunyikan, halaman tetap kosong.
4. Bila overview OK → `fillNavBadges(ov)`, `fillNotifications(ov)`,
   sembunyikan loading screen, `loadPage(page, ov)` dengan `page =
   document.body.dataset.page || 'dashboard'`.
5. **Siapa admin** (`isAdmin`, `server/src/admin.ts`, tanpa kolom role):
   1. Bila env `VB_ADMIN_EMAIL` diset dan cocok (case-insensitive) dengan
      email akun → admin.
   2. Jika tidak, akun pertama yang dibuat (`ORDER BY created_at ASC, id ASC
      LIMIT 1`) → admin ("pemilik instalasi").
   3. Semua akun lain ditolak (default-deny).
   - `GET /api/admin/settings` mengembalikan identitas ini sebagai
     `admin: { email, via: 'env' | 'first-account' } | null`.
6. **Gate server** (`requireAdmin`, `app.use('/api/admin/*', requireAdmin)`):
   - Tanpa sesi → `401 { error: 'Belum masuk.' }`.
   - Sesi ada tapi bukan admin → `403 { error: 'Bukan admin.' }`.
   - Semua endpoint `/api/admin/*` (termasuk `GET /api/admin/billing` dan
     `/api/admin/llm/*` yang didaftarkan dari `billing.ts`/`providers.ts`)
     memakai gate yang sama.
7. **Login/logout (bukan bagian panel, tapi alur terkait):**
   - Halaman login adalah Builder React di `/` (`platform/dist/index.html`,
     disajikan `no-store` oleh `app.ts`). Panel admin TIDAK punya halaman
     login sendiri; layar terkunci selalu mengarah ke `/`.
   - Logout: klik `#logout-link` → `POST /api/auth/logout` (error diabaikan)
     → `window.location.href = '/'`.
   - `POST /api/auth/login` menolak akun nonaktif:
     `403 { ok: false, error: 'Akun ini dinonaktifkan. Hubungi admin.' }`.
     (Relevan: admin bisa menonaktifkan akun dari halaman Pengguna, dan
     semua sesi akun itu langsung dihapus server — lihat §1.2.)

### 0.3 Tema (light/dark)

- Kunci localStorage: **`theme`** (utama), fallback baca **`vb-admin-theme`**
  (kunci lama; hanya dibaca, tidak pernah ditulis lagi).
- Nilai: `'light'` | `'dark'`.
- Default bila tidak ada kunci tersimpan:
  `window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'`.
- Diterapkan **sebelum paint** oleh script inline di `<head>` shell.html
  (baca kunci → set `document.documentElement[data-bs-theme]`).
- `applyTheme(theme)`: set atribut `data-bs-theme` + simpan ke
  `localStorage['theme']`. `toggleTheme()`: balik light↔dark.
- Komponen Alpine `themeSwitch` (lihat §0.8): state `currentTheme`,
  `init()` memakai `storedTheme()` atau `prefers-color-scheme`, `toggle()`
  membalik dan memanggil `applyTheme`. Ikon: `bi-sun-fill` saat light,
  `bi-moon-fill` saat dark.
- **Pengaman bila Alpine gagal dimuat:** `setTimeout(..., 1500)` — bila
  `window.Alpine` tidak ada, tombol tema (`[x-data="themeSwitch"] button`)
  diikat langsung ke `toggleTheme`.
- React WAJIB mempertahankan kunci `'theme'`, nilai `'light'/'dark'`,
  default `prefers-color-scheme`, dan penerapan sebelum paint (tanpa kedip).

### 0.4 Helper `api(path, opts)` — satu-satunya jalur fetch JSON

```js
fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...opts.headers } })
```

- Respons dibaca sebagai teks lalu `JSON.parse` (toleran bila bukan JSON).
- Bila `!res.ok`: lempar `Error((data && data.error) || `Permintaan gagal
  (${res.status}).`)` dengan properti `err.status = res.status`.
- Bila OK: kembalikan objek JSON (bisa `null` bila body kosong/bukan JSON).
- **Semua handler UI mengandalkan `data.error` dari server sebagai pesan
  toast.** Pesan error server dikutip di §1/§2 apa adanya.
- Pengecualian: restore via upload memakai `fetch` mentah + `FormData`
  (bukan `api()`), lihat §1.17.

### 0.5 Toast

- Container: `#toast-container` (fixed kanan-atas, `z-index: 1080`,
  `aria-live="polite"`).
- `toast(msg, kind)`: `kind === 'error'` → `text-bg-danger`, selain itu
  → `text-bg-success`. Bootstrap Toast, `delay: 4000` ms, ada tombol close
  (`btn-close btn-close-white`, `data-bs-dismiss="toast"`), elemen dihapus
  dari DOM pada event `hidden.bs.toast`.
- Pesan toast di-`esc()` (HTML-escape) sebelum dimasukkan ke DOM.
- Teks toast sukses/error tiap aksi dikutip persis di §1 (format umum:
  `` `Akun ${email} dinonaktifkan.` ``, `Proyek dihapus.`,
  `Pengaturan credit disimpan.`, dst.). Bila aksi gagal, toast menampilkan
  `err.message` (yaitu `data.error` server, atau `Permintaan gagal (N).`).

### 0.6 Modal konfirmasi (`confirmDialog`)

- Modal Bootstrap `#confirmModal` (dialog terpusat):
  - Judul `#confirm-title`, teks `#confirm-text`, tombol Ya `#confirm-yes`
    (class `btn-danger`, label default `Ya, lanjutkan`), tombol Batal
    (`btn-light`, `data-bs-dismiss="modal"`, label `Batal`).
- `confirmDialog(title, text, yesLabel)` → `Promise<boolean>`:
  `true` bila tombol Ya diklik, `false` bila modal ditutup/dibatalkan
  (event `hidden.bs.modal` menyelesaikan promise yang tertunda).
- Semua teks judul/teks/label-Ya tiap aksi dikutip persis di §1.
- Catatan: bila modal dibuka dua kali sebelum promise pertama selesai,
  `confirmResolve` lama tertimpa (tidak ada antrean). Jangan membuka dua
  konfirmasi bersamaan.

### 0.7 Modal form generik (`formDialog`)

- Modal Bootstrap `#formModal`: judul `#form-title`, body `#form-body`,
  tombol Simpan `#form-save` (`btn-primary`, label `Simpan`), Batal
  (`btn-light`).
- `formDialog(title, fields, values)` → `Promise<object|null>`:
  `null` bila dibatalkan/ditutup.
- Field: `{ name, label, type, value?, min?, required?, help?, rows? }`.
  - `type: 'textarea'` → `<textarea rows>` (default 3).
  - Selain itu → `<input type>` (default `'text'`), atribut `min` bila ada,
    `required` bila ada. `help` → `<div class="form-text">`.
  - Nilai awal: `values[name]` bila ada, else `field.value ?? ''`.
- Saat Simpan: kumpulkan semua `input, textarea` di `#form-body` berdasarkan
  `id` (`form-<name>`); input `type="number"` → `Number(el.value)`,
  lainnya string. **Tidak ada validasi klien di sini** selain atribut
  `required`/`min` HTML; validasi substantif dilakukan server dan/atau
  pemeriksaan eksplisit di handler pemanggil (mis. `!vals ||
  !String(vals.reason || '').trim()` → batal diam-diam).
- Semua definisi field form tiap halaman dikutip di §1.

### 0.8 Alpine.js — pemakaian (hanya header)

Alpine 3.17.5 dimuat `defer` dari `/admin/assets/alpine.min.js`. Dipakai di
**dua tempat saja**, keduanya di header shell:

1. **`searchComponent`** (pada `.search-container`, input
   `[data-search-input]`):
   - `query`, `results`. `search()`: bila `query.length < 2` → hasil kosong;
     selain itu filter `ADMIN_PAGES` (22 entri `{ title, url, type:
     'halaman' }`, lihat daftar di `admin.js`) berdasarkan substring
     judul lowercase, maks **6** hasil.
   - Dropdown hasil: tautan ke `result.url`, tampilkan `result.title` +
     `result.type`. Ditampilkan bila `results.length > 0` (`x-show`,
     transisi enter 100ms).
   - Daftar 22 entri (judul → URL): Dashboard `/admin`, Pengguna
     `/admin/users`, Proyek `/admin/projects`, Plan `/admin/plans`, Kelola
     Credit `/admin/credits`, Penggunaan `/admin/usage`, Biaya LLM
     `/admin/biaya`, Provider LLM `/admin/providers`, Pembayaran
     `/admin/billing`, Build `/admin/builds`, Domain `/admin/domain`, Pesan
     `/admin/messages`, Moderasi `/admin/moderasi`, Pengumuman
     `/admin/pengumuman`, Sesi `/admin/sessions`, Kesehatan Sistem
     `/admin/health`, Cadangan & Pulihkan `/admin/cadangan`, Pembersihan
     `/admin/pembersihan`, Pemeliharaan `/admin/pemeliharaan`, Log Audit
     `/admin/audit`, Pengaturan AI `/admin/ai-settings`, Pengaturan
     `/admin/settings`.
2. **`themeSwitch`** (pada tombol tema): lihat §0.3.
- **Tidak ada `x-data` lain.** Semua logika halaman murni `admin.js`
  (DOM imperatif). React menggantikan keduanya dengan komponen React biasa;
  perilaku pencarian (min 2 karakter, maks 6 hasil, filter substring judul)
  dan tema harus dipertahankan.

### 0.9 Bootstrap Modal — pemakaian

Bootstrap 5.3.9 (`bootstrap.bundle.min.js`). Tiga modal di shell:

| Modal | Dipakai oleh | Catatan |
|---|---|---|
| `#confirmModal` | Semua aksi destruktif/konfirmasi (§0.6) | Dibuat sekali, dipakai ulang |
| `#formModal` | Semua form tambah/ubah (§0.7) | Dibuat sekali, dipakai ulang |
| `#logModal` (`modal-lg`) | Halaman Build — lihat log (§1.12) | Judul `#log-title`, isi `<pre id="log-body">` (max-height 60vh, scroll, `white-space: pre-wrap`) |

Di React, ketiganya menjadi komponen modal React dengan perilaku janji
(confirm/form) yang sama.

### 0.10 Notifikasi (lonceng header)

- Dipicu di `boot()` dan saat tombol refresh Dashboard diklik — **bukan
  polling**. Tidak ada `setInterval` apa pun di `admin.js` (satu-satunya
  timer: `setTimeout` 1500 ms pengaman tema, dan debounce resize 150 ms).
- `fillNotifications(ov)`:
  - Sumber aktivitas: `ov.recent` (dari `GET /api/admin/overview`, maks 10
    entri gabungan user/proyek/build terbaru, diurutkan `at` menurun) —
    diambil **5 pertama** (`slice(0, 5)`).
  - Sumber peringatan: `GET /api/admin/alerts` (lihat §2). Bila fetch ini
    gagal, peringatan diabaikan diam-diam — aktivitas tetap tampil.
  - Badge `#notif-badge`: `alerts.length + items.length`; disembunyikan
    (`d-none`) bila total 0.
  - Isi dropdown `#notifications-menu` (lebar maks `min(360px, 100vw-24px)`,
    teks melipat):
    - Header `Notifikasi`.
    - Bila ada alert: sub-header `Peringatan` (kuning) + tiap alert sebagai
      item tautan ke `/admin/health`, ikon `bi-exclamation-triangle`
      (`text-danger` bila `level === 'critical'`, else `text-warning`),
      `a.message` + `<small>` `timeAgo(a.at)`. Lalu divider.
    - Tiap aktivitas: tautan ke `/admin`, ikon menurut `kind`:
      `user` → `bi-person-plus`, `project` → `bi-box`, selain itu
      (`build`) → `bi-hammer`; teks `r.text` + `<small>` `timeAgo(r.at)`.
    - Footer (bila ada aktivitas): divider + `Lihat semua aktivitas` →
      `/admin`.
    - Bila tidak ada aktivitas: item `Belum ada aktivitas.` → `/admin`.
- Dropdown notifikasi di halaman Dashboard dan halaman lain memakai data
  overview yang sama (diambil sekali saat boot).

### 0.11 Badge navigasi (sidebar)

- `fillNavBadges(ov)` (boot + refresh Dashboard):
  - `#nav-users-count` (menu Pengguna) = `fmtNum(ov.users.total)`.
  - `#nav-projects-count` (menu Proyek) = `fmtNum(ov.projects.total)`.
  - Keduanya badge `bg-primary rounded-pill ms-auto`; awalnya kosong.
- `#nav-health-badge` (menu Kesehatan) **hanya** diisi oleh `loadHealth()`
  (halaman Kesehatan): `llm.reachable` → teks `OK`, class
  `badge rounded-pill ms-auto bg-success`; tidak terjangkau → teks
  `LLM mati`, class `... bg-danger`. Di halaman lain badge ini kosong.
- Tidak ada badge lain di sidebar.

### 0.12 Sidebar, hamburger, mobile

- `initSidebar()` (`admin.js`):
  - Breakpoint mobile: lebar window `< 992` (`MOBILE_BP = 992`).
  - Desktop: tombol `[data-sidebar-toggle]` (hamburger, `aria-label="Toggle
    sidebar"`) mengaktifkan/mematikan class `sidebar-collapsed` pada
    `#admin-wrapper`; status disimpan `localStorage['sidebar-collapsed']`
    (`'true'`/`'false'`), dibaca saat init (hanya desktop).
  - Mobile: tombol membuka/menutup sidebar sebagai off-canvas: class `show`
    pada `#admin-sidebar` + `show` pada `.sidebar-backdrop` +
    `document.body.style.overflow = 'hidden'`; tutup via klik backdrop atau
    tombol `Escape`.
  - Resize (debounce 150 ms): bila kembali desktop, hapus `show`/backdrop/
    overflow. `aria-expanded` tombol disinkronkan (`syncSidebarAria`).
  - Sidebar memakai `overflow-y: auto` (tambahan di shell, karena template
    Metis memberi tinggi tetap tanpa scroll — 22+ item terpotong). Di mobile
    sidebar `top: 0; height: 100vh / 100dvh`.
- Menu sidebar (urutan persis shell.html, 22 halaman + 1 tautan keluar):
  Dashboard, Pengguna (badge), Proyek (badge), Moderasi, Domain, Plan,
  Kelola Credit, Penggunaan, Biaya LLM, Provider LLM, Pembayaran, Build,
  Pesan, Pengumuman, Sesi, Kesehatan (badge), Cadangan, Pembersihan,
  — pemisah seksi berlabel `Admin` — Log Audit, Pemeliharaan, Pengaturan AI,
  Pengaturan, **Kembali ke Builder** (`/`).
- Ikon Bootstrap Icons tiap menu dikutip di §1 (bila React memakai ikon
  lain, petakan 1:1 dari shell.html).
- Item aktif: class `active` pada `nav-link` (diisi generator build-pages,
  bukan JS).
- Header juga berisi: brand (logo `/admin/assets/images/logo.svg` +
  `VibeBuilder`) → `/admin`; tombol fullscreen (`[data-fullscreen-toggle]`,
  hanya tampil `d-none d-lg-inline-block`); menu profil (avatar placeholder
  `/admin/assets/images/avatar-placeholder.svg`, label `#user-email-label`
  default `Admin` → diisi email saat boot) dengan item Pengaturan
  (`/admin/settings`), Kembali ke Builder (`/`), Keluar (`#logout-link`).
- Footer: `© 2026 VibeBuilder Admin` dan `UI: template Metis (Bootstrap 5,
  MIT)`.

### 0.13 Pintasan keyboard

- `Ctrl+K` / `Cmd+K` (tanpa Alt/Shift): fokus ke input pertama yang cocok
  `[data-search-input]` di DOM, `preventDefault`.
  - **Catatan:** ada DUA elemen `data-search-input`: pencarian header dan
    `#credit-search` di halaman Kelola Credit. `querySelector` mengambil
    yang pertama di DOM (header). Di halaman credits, Ctrl+K tetap fokus ke
    header, bukan ke pencarian credit.
- `Escape` menutup sidebar mobile (lihat §0.12).
- Tidak ada pintasan lain.

### 0.14 Chart.js — pemakaian

- Helper `makeChart(id, config)`: lewati bila canvas tidak ada atau `Chart`
  undefined; bungkus canvas diberi `position: relative` + tinggi `300px`
  bila belum ada; hancurkan chart lama dengan id sama sebelum membuat baru
  (`charts[id].destroy()`).
- Palet `chartColors`: blue `#2563eb`, green `#16a34a`, amber `#d97706`,
  red `#dc2626`, slate `#64748b`, teal `#0d9488`.
- Dipakai di **2 halaman saja**:
  - Dashboard (§1.1): `messagesChart` (line, 2 dataset) dan `statusChart`
    (doughnut).
  - Penggunaan (§1.8): `usageChart` (line, 3 dataset).
- Opsi umum: `responsive: true, maintainAspectRatio: false`, legenda di
  bawah (`position: 'bottom'`), sumbu Y mulai 0 dengan `ticks.precision: 0`.
  Line chart memakai `tension: 0.3`; dataset pertama Dashboard/Usage memakai
  `fill: true` + `backgroundColor: 'rgba(37,99,235,.12)'`.

### 0.15 Unduhan & unggahan file

| Aksi | Cara saat ini | Detail |
|---|---|---|
| Unduh CSV biaya | Tautan `<a id="cost-csv" download href="/api/admin/cost.csv?days=N">` | `href` diperbarui tiap `loadCost()` mengikuti `costDays`. Server balas `text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="biaya-llm-${label}.csv"`, label `semua` bila days=0 else `${days}hari`. Isi: header `bagian,model_atau_pengguna,permintaan,prompt_tokens,completion_tokens,total_tokens,biaya_idr`, baris `per_model`, `per_pengguna`, `total`. Nilai kosong untuk biaya null. |
| Unduh cadangan DB | Tautan `<a id="backup-download-btn" href="/api/admin/backup">` | Server: snapshot via `VACUUM INTO` file tmp, di-stream, `application/octet-stream`, `Content-Disposition: attachment; filename="vibebuilder-YYYYMMDD-HHMM.db"`, `Content-Length`. File tmp dihapus saat stream selesai/error. |
| Pulihkan dari file | Form `#restore-form` + `fetch` mentah `multipart/form-data` field `file` | Lihat §1.17. Batas server: file kosong → 400, `> 200 MB` → 400. |

### 0.16 Format tampilan (wajib sama di React)

- `fmtNum(n)`: `Number(n ?? 0).toLocaleString('id-ID')`.
- `fmtRp(n)`: `null`/`undefined` → `–`; else `` `Rp ${fmtNum(n)}` ``.
- `fmtBytes(n)`: falsy kecuali 0 → `–`; `<1024` → `N B`; `<1048576` →
  `X.X KB`; else `X.X MB`.
- `fmtDate(ts)`: `toLocaleString('id-ID', { day:'2-digit', month:'short',
  year:'numeric', hour:'2-digit', minute:'2-digit' })`, falsy → `–`.
- `fmtDateShort(ts)`: `toLocaleDateString('id-ID', { day:'2-digit',
  month:'short', year:'numeric' })`, falsy → `–`.
- `timeAgo(ts)`: falsy → `–`; `<60 dtk` → `baru saja`; `<60 mnt` →
  `N mnt lalu`; `<24 jam` → `N jam lalu`; else `N hari lalu`.
- `esc(v)`: escape `& < > " '` → entitas HTML. Dipakai untuk semua teks dari
  server sebelum `innerHTML`.
- Avatar inisial: huruf pertama `name || email`, trim, uppercase, dalam
  lingkaran `.avatar-sm` (32px, background primary).
- Semua timestamp server adalah **epoch milidetik** (kolom `*_at`,
  `created_at`, `updated_at`, `expires_at`, `reset_at`).

### 0.17 Penanganan error & empty state (konvensi umum)

- Gagal memuat data halaman (di `loadPage`): error dilempar ke `catch`
  `boot()` → toast error; halaman menampilkan kerangka kosong (nilai awal
  `–` / tabel kosong). Tidak ada layar error khusus per halaman.
- Gagal aksi (tombol/form): toast error berisi `err.message`; tabel tidak
  di-refresh (tetap menampilkan data lama).
- Setelah aksi sukses: toast sukses + `loadX()` ulang (refresh data halaman
  penuh). Pengecualian: toggle model provider TIDAK reload bila sukses
  (hanya bila gagal); lihat §1.10.
- Empty state tabel: satu baris `<tr><td colspan=N class="text-muted">…</td></tr>`
  dengan teks spesifik tiap halaman (dikutip di §1).
- Tidak ada pagination server-side di halaman mana pun kecuali batas
  `limit` query (builds/messages/audit/sessions/credits-detail). Pencarian
  hanya di: credits, messages, audit. Sort: tidak ada kontrol sort di UI
  mana pun (urutan ditentukan server, lihat §2).
- Tidak ada auto-refresh/polling di halaman mana pun. Satu-satunya refresh
  manual: tombol `#refresh-btn` (hanya ada di Dashboard) — memuat ulang
  `GET /api/admin/overview` + `fillNavBadges` + `fillNotifications` +
  `loadPage(halaman saat ini)` + toast `Data dimuat ulang.`

### 0.18 Layar loading & layar terkunci

- `#loading-screen`: overlay fixed penuh dengan spinner Bootstrap
  (`spinner-border text-primary`, teks tersembunyi `Memuat...`).
  Disembunyikan dengan menambah class `done` (`display: none`) di akhir
  `boot()` — di SEMUA jalur (sukses, belum masuk, bukan admin, error).
- `#locked-screen` (awal `d-none`): kartu terpusat dengan ikon
  `bi-shield-lock`, `#locked-title`, `#locked-text`, tombol `#locked-action`
  (href `/`, label default `Buka Builder & Masuk`). `showLocked(title, text,
  actionLabel)` mengisi ketiganya dan menyembunyikan `#page-content`.


---

## 1) Per halaman (22, urut sidebar)

Konvensi penulisan tiap halaman: **Route** (path server + judul dokumen dari
`build-pages.mjs`), **Loader** (fungsi di `admin.js`), **Endpoint** (method +
path + param + field respons yang dipakai UI), **Inventaris UI**, **Catatan /
edge case**. Teks Indonesia dikutip persis.

### 1.1 Dashboard

- **Route:** `GET /admin` · judul dokumen `Dashboard` · `body[data-page] =
  "dashboard"` · loader `loadDashboard(ov)` (menerima overview dari boot).
- **Endpoint:**
  - `GET /api/admin/overview` — sudah dipanggil di `boot()` (bukan di loader);
    loader menerima hasilnya sebagai `ov`.
  - `GET /api/admin/usage` — tambahan di dalam `loadDashboard()` (untuk
    grafik harian; overview tidak punya deret harian).
- **Field `overview` yang dipakai UI:**
  - `users.total`, `users.new7d`, `users.disabled`
  - `projects.total`, `projects.published`, `projects.new7d`,
    `projects.byStatus` (objek `{ status: jumlah }`)
  - `messages.total`, `messages.today`, `messages.last7d`
  - `usage.promptTokens`, `usage.completionTokens`, `usage.requests`
    (counter in-memory sejak server start, lihat §2)
  - `recent[]` (`{ kind, text, at }`), `topUsers[]`
    (`{ name, email, projects, messages }`)
  - **Tidak dipakai UI** (tapi ada di respons): `builds { total, ok, fail }`,
    `plans.total`, `tokenUsage { totalTokens, usersTracked }`.
- **Field `usage` yang dipakai UI:** `daily[]` (`{ date, messages, users,
  projects }`, 14 hari, `date` format `YYYY-MM-DD`).
- **Inventaris UI:**
  - Header: `Dashboard` + subtitle `#dashboard-subtitle` (awal
    `Ringkasan VibeBuilder`, diisi loader menjadi `` `Diperbarui
    ${new Date().toLocaleTimeString('id-ID')} · semua angka dari database` ``)
    + tombol refresh `#refresh-btn` (ikon `bi-arrow-clockwise`, title
    `Muat ulang data`) — lihat §0.17.
  - 4 kartu stat: Total Pengguna (`#stat-users`, sub
    `` `+${new7d} dalam 7 hari · ${disabled} nonaktif` ``), Total Proyek
    (`#stat-projects`, sub `` `${published} diterbitkan · +${new7d} dalam 7
    hari` ``), Total Pesan (`#stat-messages`, sub `` `${today} hari ini ·
    ${last7d} dalam 7 hari` ``), Token LLM (`#stat-tokens` =
    `promptTokens + completionTokens`, sub `` `${requests} permintaan ·
    sejak server start` ``).
  - Grafik `Pesan per Hari (14 hari)` — canvas `#messagesChart`, line, 2
    dataset: `Pesan` (`usage.daily[].messages`, biru, fill) dan `Proyek baru`
    (`usage.daily[].projects`, hijau); label = `d.date.slice(5)` (`MM-DD`).
    Badge `#chart-range-label` di header kartu **tidak pernah diisi oleh
    `admin.js`** — lihat §3 Q1.
  - `Aktivitas Terbaru` — `#activity-feed`, dari `ov.recent` (semua 10
    entri, bukan 5 seperti notifikasi): ikon menurut `kind` (sama seperti
    §0.10), teks + `timeAgo(at)`. Kosong → `Belum ada aktivitas.`
  - `Status Proyek` — canvas `#statusChart`, doughnut dari
    `Object.entries(ov.projects.byStatus || {})`, warna berurutan
    `[blue, green, amber, red, slate]`.
  - `Pengguna Teraktif` — tabel `#top-users-body`, kolom Pengguna (avatar
    inisial + nama + email kecil) | Proyek | Pesan; kosong →
    `Belum ada data.` (`colspan=3`).
- **Catatan:** tidak ada search/sort/pagination. Angka "Token LLM" dan
  "Permintaan LLM" NOL setelah server restart (counter in-memory).

### 1.2 Pengguna

- **Route:** `GET /admin/users` · judul `Pengguna` · loader `loadUsers()`.
- **Endpoint:**
  - `GET /api/admin/users` → `{ adminEmail, users[] }`.
    - `users[]`: `{ id, email, name, created_at, disabled, projects,
      messages, tokens, last_seen, plan_id, plan_name, plan_limit, isAdmin }`.
      `last_seen` = `max(sessions.created_at)` user itu, `null` bila belum
      pernah login. `isAdmin` dihitung server (email == admin).
    - `adminEmail` dikembalikan tapi **tidak dipakai UI**.
  - `PATCH /api/admin/users/:id` — body `{ disabled: boolean }` (wajib
    boolean) → `{ ok, id, disabled }`.
    Error server: 404 `Pengguna tidak ditemukan.`; 400 `Akun sendiri tidak
    boleh diubah dari sini.`; 400 `Field disabled wajib boolean.`
    Efek server bila `disabled=true`: semua sesi user dihapus.
  - `DELETE /api/admin/users/:id` → `{ ok, deletedProjects }`.
    Error: 404 `Pengguna tidak ditemukan.`; 400 `Akun sendiri tidak boleh
    dihapus.` Efek server: hentikan preview tiap proyek miliknya, hapus DB
    terkelola tiap proyek, hapus proyek, hapus sesi, hapus user.
- **Inventaris UI:**
  - Header `Pengguna` + subtitle `#users-subtitle`:
    `` `${N} akun terdaftar` ``.
  - Tabel `#users-body`, kolom: Pengguna (avatar inisial + nama + email) |
    Dibuat (`fmtDateShort(created_at)`) | Proyek | Pesan | Token | Plan
    (badge `bg-info` `plan_name`, atau `–`) | Terakhir aktif
    (`timeAgo(last_seen)`) | Status | Aksi.
  - Status: `isAdmin` → badge `bg-primary` `Admin`; else `disabled` → badge
    `bg-secondary` `Nonaktif`; else badge `bg-success` `Aktif`.
  - Aksi per baris (kecuali baris akun sendiri — dikenali dari
    `u.email.toLowerCase() === (window.__vbAdminMe || '').toLowerCase()`,
    tampil teks `akun ini`):
    - `Nonaktifkan` / `Aktifkan` (`btn-outline-warning`): konfirmasi
      `Nonaktifkan akun` / `Aktifkan akun`, teks `` `${disable ?
      'Nonaktifkan' : 'Aktifkan'} akun ${email}?${disable ? ' Akun tidak
      bisa masuk sampai diaktifkan lagi.' : ''}` ``, label Ya
      `Ya, nonaktifkan` / `Ya, aktifkan`. Sukses → toast `` `Akun ${email}
      ${disable ? 'dinonaktifkan' : 'diaktifkan'}.` `` + reload.
    - `Hapus` (`btn-outline-danger`): konfirmasi `Hapus pengguna`, teks
      `` `Hapus akun ${email} beserta SEMUA proyeknya? Tindakan ini tidak
      bisa dibatalkan.` ``, label Ya `Ya, hapus`. Sukses → toast
      `` `Akun ${email} dihapus (${deletedProjects} proyek ikut
      terhapus).` `` + reload.
  - Tidak ada search/sort/pagination; tabel memuat SEMUA user.
- **Edge:** tombol aksi memakai `data-disabled` terbalik (`u.disabled ? 0 :
  1`) sebagai nilai target baru.

### 1.3 Proyek

- **Route:** `GET /admin/projects` · judul `Proyek` · loader `loadProjects()`.
- **Endpoint:**
  - `GET /api/admin/projects` → `{ projects[] }`, tiap proyek:
    `{ id, name, status, slug, created_at, updated_at, owner_id,
    owner_email, owner_name, messages, files, last_build_ok }`.
    Diurutkan `updated_at DESC`. `last_build_ok` **tidak dipakai UI**.
  - `DELETE /api/admin/projects/:id` → `{ ok: true }`. Error 404
    `Proyek tidak ditemukan.` Efek server: hentikan preview, hapus DB
    terkelola, hapus proyek.
- **Inventaris UI:**
  - Header `Proyek` + subtitle `` `${N} proyek dari semua pengguna` ``.
  - Tabel `#projects-body`, kolom: Proyek (nama tebal + `id` monospace kecil)
    | Pemilik (`owner_email` atau `tanpa pemilik`) | Status | Pesan | File |
    Slug (tautan `/p/<slug>` target `_blank` bila ada, else `–`) |
    Diperbarui (`fmtDateShort(updated_at)`) | Aksi.
  - Status badge: `idle` bg-success, `working` bg-primary, `building`
    bg-warning, `error` bg-danger, lain bg-secondary; teks = nilai `status`
    mentah.
  - Aksi: `Buka` (tautan `btn-outline-primary` ke `/proyek/<id>` — halaman
    builder SPA, bukan admin) dan `Hapus` (`btn-outline-danger`):
    konfirmasi `Hapus proyek`, teks `` `Hapus proyek "${name}" beserta semua
    file, pesan, dan build-nya? Tindakan ini tidak bisa dibatalkan.` ``,
    label Ya `Ya, hapus`. Sukses → toast `Proyek dihapus.` + reload.
  - Tidak ada search/sort/pagination; tidak ada empty state khusus (tabel
    kosong bila tidak ada proyek).

### 1.4 Moderasi

- **Route:** `GET /admin/moderasi` · judul `Moderasi` · loader
  `loadModeration()`.
- **Endpoint:**
  - `GET /api/admin/moderation` → `{ projects[] }`, tiap proyek: field
    proyek seperti §1.3 + `suspended` (boolean), `flag_reason`,
    `flag_by`, `flagged_at`, `flagged` (boolean, true bila ada flag).
    Flag diambil dari baris `project_flags` terbaru per proyek.
  - `POST /api/admin/projects/:id/flag` — body `{ reason }` → `{ ok, flagId }`.
    Error: 404 `Proyek tidak ditemukan.`; 400 `Alasan penandaan wajib diisi.`;
    400 `Alasan maksimal 500 karakter.` Server menghapus flag lama lalu
    insert baru (satu flag aktif per proyek).
  - `DELETE /api/admin/projects/:id/flag` → `{ ok: true }`. Error 404
    `Proyek tidak ditemukan.` atau `Proyek ini tidak ditandai.`
  - `POST /api/admin/projects/:id/suspend` (tanpa body) →
    `{ ok: true, suspended: true }`. Error 404. Efek server: set
    `projects.suspended = 1`, hentikan preview.
  - `POST /api/admin/projects/:id/unsuspend` (tanpa body) →
    `{ ok: true, suspended: false }`. Error 404.
  - **Tidak satu pun dari keempat aksi di atas menulis log audit**
    (tidak ada `logAdmin` di handlernya).
- **Inventaris UI:**
  - Header `Moderasi` + subtitle
    `` `${N} proyek · ${flagged} ditandai · ${suspended} ditangguhkan` ``.
  - Alert kuning permanen: `Penangguhan di sini hanya menandai proyek di
    panel admin dan menghentikan preview yang sedang berjalan.
    Preview/publish di jalur publik **belum diblokir otomatis** — penegakan
    itu masih tertunda (butuh perubahan jalur penyajian). Penangguhan tidak
    terkait kuota.`
  - Tabel `#moderation-body`, kolom: Proyek | Pemilik | Status (badge sama
    §1.3) | Ditandai (badge `bg-warning text-dark` `Ditandai` + alasan +
    `oleh ${flag_by || '–'} · ${fmtDateShort(flagged_at)}`, atau `–`) |
    Ditangguhkan (badge `bg-danger` `Ditangguhkan` atau `bg-success`
    `Aktif`) | Tautan (`Buka` → `/proyek/<id>`; `Terbit` → `/p/<slug>`
    bila ada slug) | Aksi.
  - Aksi:
    - `Tandai` (`btn-outline-warning`) bila belum ditandai → formDialog
      `Tandai proyek`, field `reason` (textarea, required, label
      `Alasan penandaan`, help `Alasan ini terlihat oleh admin lain di
      tabel moderasi.`). Batal diam-diam bila kosong. Sukses → toast
      `` `Proyek "${name}" ditandai.` `` + reload.
    - `Hapus tanda` (`btn-outline-secondary`) bila ditandai → konfirmasi
      `Hapus tanda`, teks `` `Hapus tanda pada proyek "${name}"?` ``,
      label Ya `Ya, hapus tanda`. Sukses → toast `Tanda dihapus.` + reload.
    - `Tangguhkan` (`btn-outline-danger`) bila aktif → konfirmasi
      `Tangguhkan proyek`, teks `` `Tangguhkan proyek "${name}"? Preview
      yang sedang berjalan dihentikan. Catatan: preview/publish di jalur
      publik belum diblokir otomatis sampai penegakan dibangun.` ``,
      label Ya `Ya, tangguhkan`. Sukses → toast
      `` `Proyek "${name}" ditangguhkan.` `` + reload.
    - `Buka penangguhan` (`btn-outline-success`) bila ditangguhkan → TANPA
      konfirmasi, langsung POST. Sukses → toast `` `Penangguhan proyek
      "${name}" dibuka.` `` + reload.
  - Empty state: `Belum ada proyek.` (`colspan=7`).
- **Catatan penting:** penangguhan TIDAK memblokir preview/publish publik
  dan TIDAK terkait kuota/token. Jangan klaim sebaliknya di UI React.

### 1.5 Domain

- **Route:** `GET /admin/domain` · judul `Domain` · loader `loadDomains()`.
- **Endpoint:**
  - `GET /api/admin/domains` → `{ domains[], expectedCname, ssl }`.
    `expectedCname` selalu `'clidi.net'`; `ssl` selalu `'belum dipasang'`.
    `domains[]`: `{ id, project_id, domain, status, created_at,
    verified_at, project_name, project_slug }`.
  - `GET /api/admin/projects` (paralel, `Promise.all`) — hanya untuk mengisi
    dropdown proyek di form tambah.
  - `POST /api/admin/domains` — body `{ projectId, domain }` →
    `{ ok: true, id }`. Normalisasi server: trim, lowercase, buang
    `http(s)://`, buang path. Error: 400 `Proyek wajib dipilih.`; 404
    `Proyek tidak ditemukan.`; 400 `Format domain tidak valid.` (regex
    `DOMAIN_RE`); 400 `Domain sudah terdaftar.` (UNIQUE).
  - `POST /api/admin/domains/:id/verify` (tanpa body) → `{ ok, domain,
    expectedCname, cnames[], addresses[], cnameError, aError, matched,
    status, note, ssl }`. `matched` = ada CNAME yang sama dengan
    `clidi.net` atau berakhiran `.clidi.net`. Bila cocok, server set
    `status='verified'`, `verified_at=now`. DNS timeout 5 detik per lookup
    (CNAME + A paralel). `note`: cocok → `CNAME cocok dengan target
    platform.`; tidak → `Perlu penyesuaian manual: arahkan CNAME domain ke
    clidi.net, lalu periksa lagi.`
  - `DELETE /api/admin/domains/:id` → `{ ok: true }`. Error 404
    `Domain tidak ditemukan.`
- **Inventaris UI:**
  - Header `Domain` + subtitle
    `` `${N} domain terdaftar · target CNAME ${expectedCname} · SSL: ${ssl}` ``.
  - Alert kuning: `Routing dan SSL otomatis **belum dipasang** — halaman ini
    hanya mencatat domain dan memeriksa DNS. Target CNAME yang diharapkan:
    clidi.net.`
  - Form tambah (kartu `Tambah domain`): select `#domain-project` (opsi
    `` `${name} (${id})` ``, value `id`; TANPA opsi kosong — proyek pertama
    terpilih default), input `#domain-name` (placeholder
    `contoh: toko.example.com`), tombol `#domain-add-btn` `Tambah`.
    Validasi klien: domain kosong → toast error `Isi dulu nama domainnya.`
    Sukses → toast `` `Domain ${domain} ditambahkan.` ``, kosongkan input,
    reload.
  - Area hasil DNS `#dns-result` (kosong awal): saat `Periksa DNS` diklik →
    alert info `Memeriksa DNS ${domain}…`; selesai → alert sukses
    (`matched`) / warning: `**${domain}** — CNAME cocok dengan target
    platform.` / `Belum cocok.`, plus baris kecil: `CNAME yang ditemukan:
    ...` (atau `cnameError` / `tidak ada`), `A yang ditemukan: ...` (atau
    `aError` / `tidak ada`), `Target yang diharapkan: CNAME ke
    <code>${expectedCname}</code>`, `note`, `SSL: ${ssl}`. Setelah verify,
    `loadDomains()` dipanggil ulang (tabel ikut refresh).
  - Tabel `#domains-body`, kolom: Domain (monospace tebal) | Proyek
    (`project_name || project_id` + `project_id` monospace) | Status
    (`verified` → badge `bg-success` `Terverifikasi`; else badge
    `bg-warning text-dark` `Menunggu verifikasi`) | Dibuat | Diverifikasi
    (`fmtDateShort(verified_at)` atau `–`) | Aksi.
  - Aksi: `Periksa DNS` (`btn-outline-primary`), `Hapus`
    (`btn-outline-danger`): konfirmasi `Hapus domain`, teks
    `` `Hapus domain ${domain} dari daftar? Routing (bila sudah dipasang
    manual) tidak ikut dihapus.` ``, label Ya `Ya, hapus`. Sukses → toast
    `` `Domain ${domain} dihapus.` `` + reload.
  - Empty state: `Belum ada domain.` (`colspan=6`).

### 1.6 Plan

- **Route:** `GET /admin/plans` · judul `Plan` · loader `loadPlans()`.
- **Endpoint:**
  - `GET /api/admin/plans` → `{ plans[] }`, tiap plan:
    `{ id, name, token_limit, price_idr, description, monthly_credits,
    created_at, updated_at, users }` (`users` = jumlah pengguna memakai plan).
    Diurutkan `created_at ASC`.
  - `GET /api/admin/users` (paralel) — untuk tabel "Plan per Pengguna";
    dipakai `plan_id, plan_name, tokens, plan_limit, name, email`.
  - `POST /api/admin/plans` — body `{ name, tokenLimit, priceIdr,
    description }` → `{ ok: true, id }`. `id` digenerate server:
    `` `plan_${random 6 char}` ``. Error 400 `Nama plan wajib diisi (maks
    80 karakter).` Server juga menerima `monthlyCredits` (tidak dikirim UI
    — lihat Catatan).
  - `PATCH /api/admin/plans/:id` — body `{ name, tokenLimit, priceIdr,
    description }` → `{ ok: true }`. Error 404 `Plan tidak ditemukan.`;
    400 `Nama plan wajib diisi (maks 80 karakter).`; 400
    `Tidak ada field yang diubah.`
  - `DELETE /api/admin/plans/:id` → `{ ok: true }`. Error 404. Efek server:
    hapus `user_plans` yang memakai plan itu, lalu hapus plan.
  - `POST /api/admin/users/:id/plan` — body `{ planId: string | null }` →
    `{ ok: true, planId }`. `planId: null` = lepas plan. Error 404
    `Pengguna tidak ditemukan.` / `Plan tidak ditemukan.` Efek server:
    `plan_credits_reset_at` user dinolkan supaya jatah plan baru terisi
    pada baca saldo berikutnya.
- **Inventaris UI:**
  - Header `Plan` + sub-teks statis: `Paket token untuk pengguna. Kuota
    dipakai untuk pemantauan — chat belum dibatasi kuota.` + tombol
    `#plan-add-btn` `Tambah Plan`.
  - Tabel plan `#plans-body`, kolom: Nama (tebal + `id` monospace) | Kuota
    Token (`token_limit > 0` → angka; else badge `bg-success`
    `Tanpa batas`) | Harga (Rp) (`Rp ${fmtNum(price_idr)}`) | Pengguna |
    Keterangan (`description` atau `–`) | Aksi.
  - `Tambah Plan` → formDialog `Tambah plan`: `name` (required, help
    `cth. Pro, Starter, Enterprise`), `tokenLimit` (number, min 0, value 0,
    label `Kuota token (0 = tanpa batas)`, help `Jumlah token maksimum per
    pengguna.`), `priceIdr` (number, min 0, value 0, label `Harga (Rp)`),
    `description` (textarea). Batal bila nama kosong. Sukses → toast
    `Plan dibuat.` + reload.
  - `Ubah` (`btn-outline-primary`) → formDialog `Ubah plan` (field sama,
    terisi nilai plan saat ini). Sukses → toast `Plan diperbarui.` + reload.
  - `Hapus` (`btn-outline-danger`) → konfirmasi `Hapus plan`, teks
    `` `Hapus plan "${name}"? Pengguna yang memakai plan ini jadi tanpa
    plan.` ``, label Ya `Ya, hapus`. Sukses → toast `Plan dihapus.` + reload.
  - Tabel `Plan per Pengguna` `#plan-users-body`, kolom: Pengguna (nama +
    email) | Plan Saat Ini (badge `bg-info` atau `–`) | Token Dipakai |
    Kuota (progress bar 6px + `` `${tokens} / ${plan_limit} (${pct}%)` ``;
    bila `plan_limit` 0/negatif → `` `${tokens} dipakai · tanpa batas` ``;
    warna bar: `pct >= 100` bg-danger, `>= 80` bg-warning, else bg-success;
    `pct = min(100, round(tokens / plan_limit * 100))`) | Ubah Plan
    (select `form-select-sm`, maks 200px, opsi `— Tanpa plan —` + semua plan,
    terpilih sesuai `plan_id`).
    - `change` pada select → POST plan langsung (tanpa konfirmasi) → toast
      `Plan pengguna diperbarui.` + reload; bila gagal → toast error + reload
      (mengembalikan select ke nilai server).
  - Empty state tabel plan: `Belum ada plan.` (`colspan=6`). Tabel pengguna
    tidak punya empty state.
- **Catatan / edge:**
  - **Form tambah/ubah plan TIDAK mengirim `monthlyCredits`** (jatah credit
    bulanan), padahal server mendukungnya (`POST`/`PATCH` menerima
    `monthlyCredits`; plan bawaan Gratis=100, Pro=2000). Akibatnya plan baru
    via UI selalu `monthly_credits = 0`. Lihat §3 Q7 — React harus
    memutuskan apakah menambah field ini.
  - `token_limit` plan bawaan Gratis dan Pro = 0 (tanpa batas token).

### 1.7 Kelola Credit

- **Route:** `GET /admin/credits` · judul `Kelola Credit` · loader
  `loadCredits()` + `loadCreditSettings()` + `searchCreditUsers()` +
  `loadCreditDetail(userId)`.
- **Endpoint:**
  - `GET /api/admin/credits/settings` → `{ settings, defaults }`.
    `settings`: `{ freeGrant, freeDays, freeDailyCap, minBalance,
    dailyCapFree, dailyCapPaid, maxCallsPerHour }`.
    `defaults`: `{ freeGrant: 100, freeDays: 30, freeDailyCap: 50,
    minBalance: 10, dailyCapFree: 200, dailyCapPaid: 1000,
    maxCallsPerHour: 120 }`.
  - `PUT /api/admin/credits/settings` — body ketujuh field di atas →
    `{ ok: true, settings }`. Field yang tidak disertakan dibiarkan.
    Validasi/clamp di `credits.ts` (mis. `freeDays` min 1, maks 3650).
  - `GET /api/admin/credits/users?q=` → `{ users[] }`, maks **50**,
    diurutkan `created_at ASC`. `q` kosong → 50 user pertama. Tiap user:
    `{ id, email, name, created_at, plan_id, plan_name, free_balance,
    purchased_balance, plan_credits, total }` (`total` = jumlah tiga bucket,
    dibulatkan 6 desimal). `plan_name` default `'Gratis'` bila tanpa plan.
  - `GET /api/admin/credits/users/:id` → `{ user, plan, balance, raw,
    usage, orders, transactions }`:
    - `user`: `{ id, email, name, created_at, disabled }`.
    - `plan`: `{ planId, planName, monthlyCredits }` (tanpa plan →
      `planId: null, planName: 'Gratis'`, jatah dari plan `gratis`).
    - `balance`: `{ total, free, purchased, plan, freeExpiresAt,
      purchasedExpiresAt, planExpiresAt }` (epoch ms atau `null`; saldo
      kedaluwarsa dihitung 0).
    - `raw`: `{ free_expires_at, purchased_expires_at,
      plan_credits_expires_at, plan_credits_reset_at, updated_at } | null`.
    - `usage[]` (maks 50, terbaru dulu): `{ model, prompt_tokens,
      completion_tokens, cost_usd, credit, shortfall_credit, created_at }`.
      UI hanya memakai `created_at, model, credit, shortfall_credit`.
    - `orders[]` (maks 20): `{ order_id, package, amount_idr, credits,
      status, created_at, paid_at }`. UI memakai `order_id, amount_idr,
      credits, status`.
    - `transactions[]` (maks 100): `{ kind, bucket, amount, balance_after,
      reason, order_id, created_at }`. UI memakai `created_at, kind, bucket,
      amount, balance_after, reason`.
    - Error 404 `Pengguna tidak ditemukan.`
  - `POST /api/admin/credits/users/:id/adjust` — body
    `{ bucket, amount, reason }` → `{ ok: true, balance, applied }`.
    `bucket` wajib `free` | `purchased` | `plan`. Error: 404 pengguna;
    400 `Bucket tidak dikenal (free / purchased / plan).`; 400 dari
    `adjustCredit`: `Jumlah penyesuaian wajib bukan nol.`,
    `Jumlah penyesuaian terlalu besar.` (>1.000.000),
    saldo tidak boleh negatif (pesan dari `credits.ts`).
    `reason` default server `Penyesuaian manual admin` bila kosong,
    dipotong 200 karakter.
- **Inventaris UI:**
  - Header `Kelola Credit` + sub-teks statis: `Saldo pengguna, penyesuaian
    manual, dan pengaturan angka credit. Jatah plan (Gratis 100/bln, Pro
    2.000/bln) diperbarui tiap awal bulan — sisa bulan lalu hangus, tidak
    menumpuk.`
  - Kartu `Cari Pengguna`: input `#credit-search` (placeholder
    `Cari email atau nama…`, `type=search`, `data-search-input`) + tombol
    `#credit-search-btn` `Cari`. Enter di input = klik Cari. Tabel
    `#credit-users-body`, kolom: Pengguna | Plan | Gratis | Dibeli | Plan |
    Total (tebal) | (tombol `Lihat`). State awal (sebelum cari):
    `Ketik email/nama lalu tekan Cari.` (`colspan=7`). Tidak cocok:
    `Tidak ada pengguna yang cocok.`
    - Tombol `Lihat` → `loadCreditDetail(userId)`.
  - **Detail pengguna** (`#credit-detail`, atribut `hidden` sampai user
    dipilih; setelah dimuat, `scrollIntoView({ behavior:'smooth' })`):
    - Judul `#credit-detail-title` = `` `${name || email} (${email})` ``;
      badge `#credit-detail-plan` =
      `` `${planName} · ${monthlyCredits} credit/bln` ``.
    - 4 kartu saldo: Gratis (`#credit-bal-free` + `#credit-exp-free`),
      Dibeli (`#credit-bal-purchased` + `#credit-exp-purchased`), Jatah Plan
      (`#credit-bal-plan` + `#credit-exp-plan`), Total
      (`#credit-bal-total` + `#credit-reset`).
      Teks kedaluwarsa: bila ada → `` `berlaku s.d. ${fmtDateShort(...)}` ``
      (plan: `` `jatah s.d. ${...}` ``); bila null → `tanpa kedaluwarsa`
      (plan: `tanpa jatah`). `#credit-reset`: bila
      `raw.plan_credits_reset_at` ada → `` `reset jatah:
      ${fmtDateShort(...)}` ``, else `–`.
    - Form penyesuaian `#credit-adjust-form`: select `#credit-adjust-bucket`
      (`free` Gratis / `purchased` Dibeli / `plan` Jatah Plan), input
      `#credit-adjust-amount` (number, `step=any`, placeholder
      `cth. 50 atau -20`, required), input `#credit-adjust-reason`
      (placeholder `cth. Kompensasi gangguan`, `maxlength=200`, required),
      tombol submit `Terapkan`. Validasi klien: `!amount || !reason` →
      toast error `Isi jumlah dan alasan.` (tanpa kirim). Sukses → toast
      `` `Penyesuaian diterapkan. Saldo sekarang ${balance.total}
      credit.` ``, kosongkan jumlah+alasan, muat ulang detail.
      Catatan di bawah form: `Penyesuaian tercatat di riwayat transaksi
      (kind adjust) dan log audit. Saldo tidak bisa negatif — pengurangan
      melebihi sisa bucket ditolak.`
    - `Riwayat Pemakaian (50 terakhir)` — tabel `#credit-usage-body`,
      kolom Waktu (`fmtDate`) | Model | Credit (kanan) | Kurang (kanan,
      `shortfall_credit` atau `–`). Kosong: `Belum ada pemakaian.`
      (`colspan=4`).
    - `Riwayat Top-up` — tabel `#credit-orders-body`, kolom Order
      (monospace `order_id`) | Rp (kanan) | Credit (kanan) | Status.
      Kosong: `Belum ada top-up.` (`colspan=4`).
    - `Riwayat Transaksi (100 terakhir)` — tabel `#credit-tx-body`, kolom
      Waktu | Jenis (`kind`) | Bucket (atau `–`) | Jumlah (kanan, `+` bila
      `> 0`) | Saldo Sesudah (kanan) | Keterangan (`reason`).
      Kosong: `Belum ada transaksi.` (`colspan=6`).
  - Kartu `Pengaturan Angka Credit` — form `#credit-settings-form`
    (7 field number): `credit-set-grant` Credit gratis pengguna baru
    (min 0), `credit-set-days` Masa berlaku gratis (hari) (min 1),
    `credit-set-cap` Cap harian bucket gratis (min 0), `credit-set-min`
    Saldo minimal gate AI (min 0), `credit-set-daily-free` Cap harian total
    — Gratis (min 0), `credit-set-daily-paid` Cap harian total — Berbayar
    (min 0), `credit-set-calls-hour` Maks. panggilan AI / jam (min 0).
    Tombol `Simpan Pengaturan`. Teks penjelasan: `Berlaku untuk pendaftaran
    dan gate berikutnya — tanpa ubah kode dan tanpa restart.` dan catatan
    Fase 5 (cap harian total vs cap bucket gratis; pengguna berbayar =
    punya plan selain Gratis; 0 = tanpa batas). Sukses → toast
    `Pengaturan credit disimpan.` + muat ulang settings.
  - **Wiring sekali saja:** handler tombol cari / Enter / kedua form
    dipasang di `loadCredits()` dengan guard `searchBtn.dataset.wired`
    (karena `admin.js` dimuat sekali per halaman, guard ini praktis
    tidak pernah terpicu dua kali; di React cukup pasang sekali).
- **Edge:** `loadCredits()` hanya memuat settings + memasang handler; tabel
  pengguna KOSONG sampai admin menekan Cari. `creditUserId` (state modul)
  null sampai detail dibuka; submit adjust tanpa user terpilih = no-op
  diam-diam (`if (!creditUserId) return`).

### 1.8 Penggunaan

- **Route:** `GET /admin/usage` · judul `Penggunaan` · loader `loadUsage()`.
- **Endpoint:**
  - `GET /api/admin/usage` → `{ llm, daily, byUser, byUserTokens, totals }`:
    - `llm`: `{ requests, promptTokens, completionTokens }` (counter
      in-memory sejak server start — SAMA dengan `overview.usage`).
    - `daily[]`: 14 hari `{ date, messages, users, projects }`.
    - `byUser[]` (top 10): `{ email, name, messages }`.
    - `byUserTokens[]` (top 10): `{ email, name, tokens, prompt_tokens,
      completion_tokens }`.
    - `totals`: `{ messages, projects, builds, tokens }` (`tokens` = total
      token tercatat di `token_usage`, all-time).
- **Inventaris UI:**
  - Header `Penggunaan` + sub-teks: `Token LLM sejak server start & aktivitas
    14 hari terakhir.`
  - 4 kartu: Permintaan LLM (`#usage-requests`, sub `sejak server start`),
    Token Prompt (`#usage-prompt`), Token Completion (`#usage-completion`),
    Total Token (`#usage-total`, sub `prompt + completion`).
  - Grafik `Aktivitas Harian` — canvas `#usageChart`, line, 3 dataset:
    `Pesan` (biru, fill), `Pengguna baru` (`daily[].users`, teal),
    `Proyek baru` (`daily[].projects`, hijau); label `MM-DD`.
  - `Pesan per Pengguna` — tabel `#usage-byuser-body`, kolom Pengguna
    (nama + email) | Pesan. Kosong: `Belum ada data.` (`colspan=2`).
  - `Token per Pengguna` — teks: `Token LLM tercatat per pengguna sejak
    pencatatan aktif (riwayat sebelum itu tidak ada datanya). Total token
    tercatat: #usage-tokens-total.` Tabel `#usage-tokens-body`, kolom
    Pengguna | Token | Prompt | Completion. Kosong:
    `Belum ada token tercatat per pengguna.` (`colspan=4`).
- **Catatan:** kartu atas memakai counter in-memory (nol setelah restart),
  sedangkan "Total token tercatat" memakai `token_usage` (persisten).
  Keduanya sengaja berbeda sumber; jangan disamakan.

### 1.9 Biaya LLM

- **Route:** `GET /admin/biaya` · judul `Biaya LLM` · loader `loadCost()`
  (state modul `costDays`, default `30`; cache `costPricesCache`).
- **Endpoint:**
  - `GET /api/admin/cost?days=N` → `{ days, since, until, prices, byModel,
    byUser, totals, allTime }`:
    - `prices`: objek `{ [model]: { prompt_per_1k, completion_per_1k,
      currency: 'IDR' } }` (dari `admin_settings` key `llm_prices`).
    - `byModel[]`: `{ model, requests, prompt_tokens, completion_tokens,
      total_tokens, cost_idr, priced }`. `cost_idr` = `null` bila model
      tanpa harga; `priced` boolean.
    - `byUser[]`: `{ user_id, email, name, requests, prompt_tokens,
      completion_tokens, total_tokens, cost_idr, unpriced_tokens }`.
      `email`/`name` `null` bila user tak dikenal. `cost_idr` = `null`
      bila semua token user tanpa harga.
    - `totals`: `{ requests, prompt_tokens, completion_tokens,
      total_tokens, cost_idr, hasPriced, unpriced_tokens }`.
      `cost_idr` = `null` bila tidak ada model priced.
    - `allTime`: `{ requests, prompt_tokens, completion_tokens,
      total_tokens }` (tanpa filter hari).
    - `days`: nilai hasil `parseCostDays` (query `days`; `0` = semua riwayat;
      selain itu clamp 1–365; default/tidak valid = 30). `since` = `null`
      bila `days = 0`.
    - Rumus biaya: `round(prompt/1000 * prompt_per_1k +
      completion/1000 * completion_per_1k)` per model; biaya per pengguna
      dihitung per model lalu dijumlahkan.
  - `PUT /api/admin/cost/prices` — body `{ prices }` (SELURUH map, bukan
    delta) → `{ ok: true, prices }`. Validasi server: `prices` wajib objek;
    nama model maks 120 karakter, regex
    `^[A-Za-z0-9][A-Za-z0-9._\-/:]*$`; harga angka `>= 0`. Error: 400
    `Field prices wajib objek.` / `` `Nama model tidak valid: ${model}` `` /
    `` `Harga model ${name} tidak valid.` `` /
    `` `Harga model ${name} harus angka >= 0 (Rp per 1.000 token).` ``
  - `GET /api/admin/cost.csv?days=N` — unduhan (lihat §0.15).
- **Inventaris UI:**
  - Header `Biaya LLM` + sub-teks: `Perkiraan biaya dari token tercatat di
    token_usage, dikali harga per model yang diisi admin.` + kontrol kanan:
    select `#cost-days` (opsi `7` = `7 hari terakhir`, `30` =
    `30 hari terakhir` (selected), `0` = `Semua riwayat`) dan tautan
    `#cost-csv` `Unduh CSV` (ikon download, `download`, href awal
    `/api/admin/cost.csv?days=30`).
    - `change` select → `costDays = Number(value) || 0` → `loadCost()`.
  - 4 kartu: Total Token (`#cost-total-tokens`, sub `#cost-range-label` =
    `semua riwayat` bila days=0 else `` `${days} hari terakhir` ``),
    Permintaan LLM (`#cost-requests`, sub statis `dalam rentang yang
    dipilih`), Perkiraan Biaya (`#cost-total-cost`, `fmtRp`, sub
    `hanya model yang harganya sudah diisi`), Total Token (Semua)
    (`#cost-alltime-tokens`, sub `sama dengan halaman Penggunaan`).
  - Alert info: `Biaya = token × harga per model (Rp / 1.000 token). Harga
    diisi admin di bawah — **bukan harga resmi provider**, jadi isi sesuai
    tarif yang benar-benar ditagihkan ke akun ini. Model yang harganya belum
    diisi tampil “–” dan tidak masuk ke total biaya.`
  - Tabel `Biaya per Model` `#cost-by-model-body`, kolom: Model (monospace,
    atau `(tanpa model)`) | Permintaan | Prompt | Completion | Total |
    Biaya (Rp) (`fmtRp(cost_idr)` bila `priced`, else `–`). Kosong:
    `Belum ada token tercatat dalam rentang ini.` (`colspan=6`).
  - Tabel `Biaya per Pengguna` `#cost-by-user-body`, kolom sama; sel pengguna:
    bila `email` ada → nama + email; else `Pengguna tak dikenal` + `user_id`
    monospace. Biaya: `fmtRp` bila `cost_idr !== null`, else `–`; bila
    `unpriced_tokens > 0` tambah baris kecil
    `` `${unpriced_tokens} token tanpa harga` ``. Teks atas tabel:
    `Pengguna yang tokennya tercatat dengan ID yang tidak lagi cocok dengan
    akun mana pun tampil sebagai “Pengguna tak dikenal” beserta ID-nya.`
    Kosong: sama seperti di atas.
  - Tabel `Harga per Model (Rp / 1.000 token)` `#cost-prices-body` + tombol
    `#cost-add-price-btn` `Tambah harga`:
    - Baris untuk tiap model di `prices` (diurutkan alfabetis): Model |
      `Rp ${prompt_per_1k}` | `Rp ${completion_per_1k}` | tombol `Ubah`
      (`btn-outline-primary`) + `Hapus` (`btn-outline-danger`).
    - Baris untuk model yang ada di `byModel` tapi belum punya harga:
      Model | `Belum ada harga — biaya tampil “–”.` (colspan 2) | tombol
      `Isi harga`.
    - Kosong (tidak ada harga & tidak ada model): `Belum ada harga dan belum
      ada model tercatat.` (`colspan=4`).
    - `Ubah`/`Isi harga` → formDialog `` `Harga model ${model}` ``: field
      `prompt` (number, min 0, label `Prompt — Rp per 1.000 token`, help
      `Tarif prompt sesuai tagihan provider.`), `completion` (number, min 0,
      label `Completion — Rp per 1.000 token`, help `Tarif completion sesuai
      tagihan provider.`), terisi harga saat ini (atau 0). Simpan → PUT
      seluruh map + `{ [model]: { prompt_per_1k, completion_per_1k,
      currency: 'IDR' } }` → toast `Harga model disimpan.` + reload.
    - `Hapus` → konfirmasi `Hapus harga`, teks `` `Hapus harga model
      ${model}? Biayanya kembali tampil “–”.` ``, label Ya `Ya, hapus` →
      hapus key dari map lalu PUT → toast sama + reload.
    - `Tambah harga` → formDialog `Tambah harga model`: `model` (required,
      help `cth. cx/gpt-5.6-luna — harus sama persis dengan nama di tabel
      per model.`), `prompt` (number, min 0, value 0),
      `completion` (number, min 0, value 0). Batal bila nama kosong.
      Simpan → PUT map + entri baru → toast + reload.
  - Teks bawah kartu harga: `Harga disimpan di pengaturan admin
    (llm_prices) dan langsung dipakai menghitung biaya di atas. Kosongkan
    dengan menghapus baris bila tarif tidak diketahui — biaya model itu
    kembali tampil “–”.`

### 1.10 Provider LLM

- **Route:** `GET /admin/providers` · judul `Provider LLM` · loader
  `loadProviders()`.
- **Endpoint** (didaftarkan `registerProviderRoutes` di `providers.ts`,
  semua di bawah `requireAdmin`):
  - `GET /api/admin/llm/providers` → `{ providers[] }`, tiap provider:
    `{ id, name, baseUrl, keyEnv, active, notes?, keyConfigured, models[] }`.
    `models[]`: `{ id, name?, active, rateInUsdPer1M, rateOutUsdPer1M,
    endpoint?, notes?, messagesOnly?, toolsConfirmed?, contextLength? }`.
    `rateInUsdPer1M`/`rateOutUsdPer1M`: `number | null` (`null` = belum
    diketahui → tidak bisa dipakai; `0` = gratis). `keyConfigured` boolean
    — nilai key TIDAK PERNAH dikembalikan.
  - `PUT /api/admin/llm/providers/:providerId` — body `{ active: boolean }`
    → `{ ok: true, provider: { id, active } }`. Error 400
    `Provider tidak valid.` / `Field active wajib boolean.`; 404 bila
    provider tak dikenal.
  - `PUT /api/admin/llm/providers/:providerId/models/:modelId` — SATU
    endpoint untuk dua operasi:
    - body `{ active: boolean }` → `{ ok: true, model: { id, active } }`.
    - body `{ rateInUsdPer1M, rateOutUsdPer1M }` (salah satu boleh tidak
      disertakan; `null` = hapus tarif) → `{ ok: true, model: { id,
      rateInUsdPer1M, rateOutUsdPer1M } }`. Error 400
      `Provider/model tidak valid.` / `Field active atau tarif wajib diisi.`;
      404 `Model tidak dikenal: ${providerId}/${modelId}`.
  - `PUT /api/admin/llm/providers/:providerId/key` — body `{ key: string }`
    → `{ ok: true, keyConfigured }`. `key: ''` = hapus key panel. Error 400
    `Field key wajib string (kosongkan untuk menghapus).`; key < 8 karakter
    → 400 `API key terlalu pendek (min 8 karakter).`
  - `POST /api/admin/llm/providers/:providerId/test` (tanpa body) →
    `{ ok: true, status, models? }` (sukses, `models` = jumlah model
    upstream bila `json.data` array) atau `{ ok: false, status?, error }`.
    Selalu HTTP 200 (kecuali providerId tidak valid → 400). Timeout
    upstream 15 detik, `GET <baseUrl>/models` dengan `Bearer` key bila ada.
  - `POST /api/admin/llm/providers/:providerId/sync` (tanpa body) →
    `{ provider, upstream[], inRegistry, missing[] }`. `upstream[]` =
    `{ id, name?, contextLength?, endpoints? }`. `missing[]` = id model
    upstream yang belum ada di registry (**tidak ditambahkan otomatis**).
    Gagal upstream → 502 `{ error }`.
  - `POST /api/admin/llm/prices/sync` (tanpa body) →
    `{ ok: true, added, skipped }`. Menyalin tarif registry (USD/1jt token)
    ke `llm_prices` (Rp/1rb token, kurs `IDR_PER_USD = 18300`,
    dibulatkan 2 desimal) hanya untuk model yang tarifnya lengkap dan
    belum ada di `llm_prices`; yang sudah ada TIDAK ditimpa.
- **Inventaris UI:**
  - Header `Provider LLM` + sub-teks: `Provider + model + tarif yang dipakai
    builder. Hanya model yang **aktif**, di provider **aktif**, dan
    **punya tarif** yang bisa dipakai — model tanpa tarif tidak bisa dipakai
    (anti-rugi).` + tombol kanan: `#providers-sync-prices-btn`
    `Sinkronkan harga ke Biaya` dan `#providers-reload-btn` `Muat ulang`.
  - Alert info: `Nilai API key **tidak pernah ditampilkan** di halaman ini —
    hanya status terpasang/belum. Isi field key untuk mengganti key; simpan
    dalam keadaan kosong (dengan konfirmasi) untuk menghapus key yang
    tersimpan di panel. Key dari environment server tetap berlaku bila tidak
    ada key panel.` + `<span id="providers-prices-result">` untuk pesan
    hasil sinkron harga.
  - Daftar `#providers-list` — satu kartu per provider:
    - Header kartu: nama provider (h5) + badge status
      (`providerStatusBadges`): `Aktif` bg-success / `Nonaktif` bg-secondary;
      khusus `commandcode` tambah badge bg-danger `Terblokir paket Go`;
      bila `!keyConfigured` badge `bg-warning text-dark`
      `Key belum terpasang`; bila 0 model bertarif badge
      `Tanpa harga`; khusus `gater` badge `PRO habis 2 Des 2026`.
      Switch kanan (`form-check-switch`): label `Aktif`/`Nonaktif`
      mengikuti state.
    - Body: baris info `Base URL: <code>baseUrl</code> · env key:
      <code>keyEnv</code> (bila ada) · N model · M aktif`; alert warning
      bila `p.notes` ada; alert info `PROVIDER_NOTES[p.id]` (teks hardcoded
      di `admin.js` — lihat Catatan; berisi peringatan commandcode/gater/
      9router/sumopod, termasuk tautan eksternal commandcode.ai/billing dan
      ai.sumopod.com).
    - Baris key: label `API key` + badge `terpasang` (bg-primary) /
      `belum terpasang` (bg-secondary); input password
      `#prov-key-<id>` (`autocomplete=new-password`, placeholder
      `•••••••• (terpasang — isi untuk mengganti)` atau
      `Belum ada key — tempel API key`); help `Nilai key tidak pernah
      ditampilkan. Kosongkan lalu simpan (dengan konfirmasi) untuk menghapus
      key panel.` Tombol: `Simpan key` (primary sm), `Tes koneksi`
      (outline-secondary sm), `Sinkronkan model` (outline-secondary sm).
      Area hasil `[data-result="<id>"]` (kosong awal).
    - Baris pencarian model: input `[data-model-search="<id>"]`
      (placeholder `Cari model…`) + counter `[data-model-count="<id>"]`
      (`N model` / `M dari N model` saat mencari).
    - Tabel model (kolom: Model | In $ / 1 jt token | Out $ / 1 jt token |
      Aktif | (tombol)):
      - Sel Model: `id` monospace + `name` kecil bila beda dari id + badge
        (`modelBadges`): `/messages-only` bg-danger bila `messagesOnly`;
        `Gratis $0` bg-success bila kedua tarif 0; `Tanpa tarif — tidak bisa
        dipakai` bg-warning bila salah satu tarif null;
        `tools terkonfirmasi` bg-info / `tools belum terkonfirmasi`
        bg-secondary (bila `toolsConfirmed` true/false);
        `konteks N` bg-secondary bila `contextLength`; `-uncen` bg-info
        bila id berakhiran `-uncen`. Plus `notes` kecil bila ada.
      - Input tarif In/Out: `type=number`, `min=0`, `step=any`, value tarif
        atau kosong (placeholder `belum diketahui`).
      - Switch Aktif per model + tombol `Simpan tarif` (`btn-outline-primary` sm).
      - Baris `data-no-match` (tersembunyi default): `Tidak ada model yang
        cocok dengan pencarian.`
      - Kosong: `Belum ada model di registry provider ini.` (`colspan=5`).
    - Kaki kartu: `Tarif kosong = harga belum diketahui → model tidak bisa
      dipakai. Tarif $0 = gratis, sah dipakai. Tarif yang disimpan di sini
      juga dipakai pemotongan credit; sinkronkan ke halaman Biaya LLM dengan
      tombol di atas.`
  - **Perilaku aksi:**
    - Toggle provider (`change` switch): PUT `{ active }` → toast
      `` `Provider ${id} ${diaktifkan/dinonaktifkan}.` `` + `loadProviders()`
      (reload penuh). Gagal → toast error + reload juga (mengembalikan switch).
    - Toggle model: PUT `{ active }` → toast
      `` `Model ${id} ${diaktifkan/dinonaktifkan}.` ``. Sukses: TIDAK reload
      (switch dibiarkan). Gagal → toast error + `loadProviders()`.
    - `Simpan tarif`: baca dua input baris itu; `parseRateInput`: string
      kosong → `null`; angka `>= 0` → angka; negatif/NaN → `undefined` →
      toast error `Tarif harus angka ≥ 0, atau dikosongkan bila belum
      diketahui.` (tanpa kirim). PUT tarif → toast
      `` `Tarif ${modelId} disimpan (${in} / ${out}).` `` (nilai null
      ditulis `belum diketahui`, angka ditulis `$<n>`) + `loadProviders()`.
    - `Simpan key`: bila input kosong dan tidak ada key terpasang → toast
      `Tidak ada key tersimpan untuk provider ini.` (tanpa kirim); bila
      kosong dan ada key terpasang → konfirmasi `Hapus key`, teks
      `` `Hapus API key ${id} yang tersimpan di panel? Model provider ini
      kembali memakai key environment (bila ada) atau tidak bisa dipakai.` ``,
      label Ya `Ya, hapus key`; bila terisi dan `< 8` karakter → toast error
      `API key terlalu pendek (min 8 karakter).` PUT `{ key }` → toast
      `` `Key ${id} disimpan — terpasang.` `` atau
      `` `Key ${id} dihapus — belum terpasang.` `` (mengikuti
      `r.keyConfigured`) + reload.
    - `Tes koneksi`: tombol disable + area hasil
      `<spinner> Menghubungi GET /models provider…`; selesai → sukses:
      badge `Berhasil` + `` `GET /models balas ${status}${models !==
      undefined ? ` — ${models} model upstream` : ''}.` ``; gagal: badge
      `Gagal` + pesan error merah. Tombol diaktifkan kembali.
    - `Sinkronkan model`: tombol disable + spinner `Mengambil daftar model
      upstream…`; selesai → badge `Berhasil` + `` `Upstream: N model ·
      sudah di registry: M · belum ada: K.` `` + bila `missing.length`,
      `<details>` berisi daftar id dipisah koma (monospace, wrap) dengan
      ringkasan `Model upstream yang belum ada di registry (K) — belum
      ditambahkan otomatis`; bila tidak ada → `Semua model upstream sudah
      ada di registry.` Gagal → badge `Gagal` + pesan error.
    - `Muat ulang` → `loadProviders()`.
    - `Sinkronkan harga ke Biaya` → POST prices/sync → pesan ke
      `#providers-prices-result` DAN toast:
      `` `Harga disinkronkan ke Biaya LLM: ${added} harga baru ditambahkan,
      ${skipped} sudah ada (tidak ditimpa). Model tanpa tarif tidak diisi.` ``
  - **Pencarian model (per kartu, klien):** filter baris `tr[data-search]`
    (atribut = `(id + ' ' + name).toLowerCase()`) mengandung query lowercase;
    baris tidak cocok `display:none`; baris no-match tampil bila query ada,
    0 cocok, dan total > 0; counter diperbarui.
- **Catatan:**
  - `PROVIDER_NOTES` adalah teks HTML hardcoded di `admin.js` (bukan dari
    server) dengan tanggal kedaluwarsa PRO Gater `2 Des 2026 13:38 WIB` dan
    klaim paket commandcode. Lihat §3 Q8: React harus memutuskan apakah teks
    ini dipertahankan verbatim, dipindah ke server, atau dihapus.
  - Komentar kode: `llm.key` di Pengaturan AI mengalahkan key panel ini;
    endpoint chat efektif mengikuti `llm.url` bila diisi. (Relevan dengan
    hierarki sumber di §1.21.)
  - Tidak ada empty state global bila `providers` kosong selain
    `Belum ada provider di registry.`

### 1.11 Pembayaran (Clipku Pay)

- **Route:** `GET /admin/billing` · judul `Pembayaran` · loader `loadBilling()`.
- **Endpoint** (didaftarkan `registerBilling` di `billing.ts`; gate
  `requireAdmin` TIDAK dipakai di sini — handler memeriksa sendiri
  `currentUser` → 401 `Belum masuk.`, `isAdminUser` → 403
  `Bukan admin.`):
  - `GET /api/admin/billing` → `{ configured, apiKeyFromEnv,
    hasWebhookSecret, webhookUrl, packages, orderCounts,
    recentWebhookEvents, note }`:
    - `configured`: ada API key efektif (panel atau env).
    - `apiKeyFromEnv`: env `VB_CLIPKUPAY_API_KEY` terisi.
    - `hasWebhookSecret`: webhook secret terisi.
    - `webhookUrl`: URL webhook publik (dihitung server dari origin).
    - `packages`: `[{ id, amountIdr, credits }]` — nilai saat ini:
      `p10` Rp10.000 = 350, `p25` Rp25.000 = 1.000, `p100` Rp100.000 = 4.200,
      `p220` Rp220.000 = 10.000.
    - `orderCounts`: objek `{ [status]: jumlah }` dari `credit_orders`
      (status: mis. `pending`, `paid`, `cancelled`, `expired` — nilai apa
      pun yang ada di DB).
    - `recentWebhookEvents[]` (maks 20, terbaru dulu): `{ order_id, event,
      signature_valid, result, created_at }`.
    - `note`: teks penjelasan (tidak dipakai UI).
  - `PUT /api/admin/billing` — body `{ apiKey, webhookSecret }` →
    `{ ok: true, configured, hasWebhookSecret }`. String kosong = hapus
    nilai panel itu; field `undefined` = tidak diubah. Error 400 bila bukan
    string atau panjang > 300 karakter.
- **Inventaris UI:**
  - Header `Pembayaran` + sub-teks: `Kredensial Clipku Pay untuk top-up
    credit (QRIS). Nilai key/secret tidak pernah ditampilkan.`
  - Kartu `Kredensial Clipku Pay` — form `#billing-form`
    (`autocomplete=off`):
    - `billing-api-key` (password, monospace, `autocomplete=new-password`):
      label `Merchant API key` + badge `#billing-api-key-src` (`env`
      bg-warning bila `apiKeyFromEnv`, `panel` bg-primary bila terpasang
      dari panel, `belum` bg-secondary bila belum). Placeholder bila
      terpasang: `•••••••• (terpasang — isi untuk mengganti)`; bila belum:
      `Belum ada key — tempel merchant API key Clipku Pay`. Help: `Tempel
      merchant API key dari panel merchant Clipku Pay (regenerate bila
      perlu). Isi untuk mengganti key; kosongkan lalu simpan untuk menghapus
      nilai yang tersimpan di panel ini.`
    - `billing-webhook-secret` (password, monospace): label
      `Webhook secret` + badge `#billing-webhook-secret-src` (`panel`
      bg-primary bila terisi, `belum` bg-secondary). Placeholder:
      `•••••••• (terpasang — isi untuk mengganti)` / `Belum ada secret
      (opsional)`. Help: `Opsional. Isi hanya bila gateway terbukti
      mengirim header x-clipkupay-signature — bila terisi, webhook yang
      signaturenya salah ditolak (401). Kosongkan lalu simpan untuk
      menghapus.`
    - Alert `#billing-env-warning` (tersembunyi default): bila
      `apiKeyFromEnv`, tampil dengan teks: `Key aktif saat ini berasal dari
      environment server (env menang atas panel). Mengisi key di halaman ini
      belum berpengaruh sampai entri VB_CLIPKUPAY_API_KEY di env VPS
      dihapus/diubah.`
    - Tombol submit `Simpan` (primary). Sukses → toast
      `Kredensial pembayaran disimpan — API key terpasang.` (bila
      `r.configured`) atau `Kredensial pembayaran disimpan — API key belum
      terpasang.`; kedua input dikosongkan; `loadBilling()`.
  - Kartu `Webhook`: input readonly `#billing-webhook-url` (monospace) +
    tombol `#billing-copy-webhook` `Salin` → `navigator.clipboard.writeText`
    (fallback: select + `document.execCommand('copy')`) → toast
    `Webhook URL disalin.` Help: `Gateway memanggil URL ini sesudah
    pembayaran. Pembayaran hanya dikreditkan sesudah statusnya diverifikasi
    ulang ke provider.`
  - Kartu `Status` — daftar `#billing-status-list` (4 baris): API key
    (`Terpasang`/`Belum terpasang`), Sumber key (`Environment server` /
    `Panel ini` / `–`), Webhook secret (`Terpasang` /
    `Belum terpasang (HMAC nonaktif)`), Webhook URL (atau `–`).
  - Kartu `Paket Top-up` — daftar `#billing-packages-list`: tiap item
    `` `Rp ${amountIdr} = ${credits} credit` ``.
  - Kartu `Order & Webhook Terakhir` — `#billing-order-counts`: badge
    `bg-secondary` per status `` `${status}: ${n}` ``, atau
    `Belum ada order.` Tabel `#billing-events-body`, kolom Order (monospace)
    | Event | Signature (badge `bg-success` `Valid` bila
    `signature_valid`, else badge `bg-secondary` `–`) | Hasil (`result`
    atau `–`) | Waktu (`fmtDate`). Kosong: `Belum ada event webhook.`
    (`colspan=5`).
  - Kartu `Cara Mengganti Key` (statis, 3 langkah): buka panel merchant
    Clipku Pay & regenerate bila perlu; tempel key baru lalu Simpan; bila
    status masih "dari environment", ubah/hapus entri
    `VB_CLIPKUPAY_API_KEY` di env VPS baru isi di halaman ini.

### 1.12 Build

- **Route:** `GET /admin/builds` · judul `Build` · loader `loadBuilds()`.
- **Endpoint:**
  - `GET /api/admin/builds?limit=100` → `{ builds[] }`, tiap build:
    `{ id, project_id, ok, log, created_at, project_name, owner_email }`.
    Diurutkan `id DESC`. Server: `limit` default 50, clamp 1–200.
    `ok` = 1 berhasil / 0 gagal. `log` = teks log build (bisa panjang).
- **Inventaris UI:**
  - Header `Build` + subtitle `#builds-subtitle`:
    `` `${N} build terakhir dari semua proyek` ``.
  - Tabel `#builds-body`, kolom: # (`id`) | Proyek (nama tebal +
    `project_id` monospace) | Pemilik (`owner_email` atau `–`) | Hasil
    (badge `bg-success` `Berhasil` bila `ok`, else badge `bg-danger`
    `Gagal`) | Waktu (`fmtDate(created_at)`) | Log (tombol
    `Lihat log` `btn-outline-secondary`).
  - Tombol `Lihat log` → modal `#logModal`: judul
    `` `Log build #${id} — ${project_name}` ``, isi `#log-body` =
    `b.log || '(log kosong)'`. **Log dibawa di atribut DOM
    `data-log` (di-`esc`)** — log sangat panjang membengkak DOM; di React
    simpan di state, jangan di atribut.
  - Empty state: `Belum ada build.` (`colspan=6`).
  - Tidak ada filter/search/pagination (selain `limit=100` tetap).

### 1.13 Pesan

- **Route:** `GET /admin/messages` · judul `Pesan` · loader `loadMessages()`
  (state modul `messagesQuery`, awal `''`).
- **Endpoint:**
  - `GET /api/admin/messages?q=&limit=100` → `{ messages[] }`, tiap pesan:
    `{ id, project_id, role, excerpt, created_at, project_name,
    owner_email }`. `excerpt` = `substr(content, 1, 300)`.
    `q` dicari dengan `LIKE %q%` pada `content`. Server: `limit` default
    100, clamp 1–200. Diurutkan `id DESC`.
- **Inventaris UI:**
  - Header `Pesan` + sub-teks `Semua pesan chat di semua proyek.` +
    kotak cari (maks 320px): input `#messages-search` (placeholder
    `Cari isi pesan…`) + tombol `#messages-search-btn` (ikon cari).
    Klik tombol atau Enter → `messagesQuery = value.trim()` →
    `loadMessages()`.
  - Tabel `#messages-body`, kolom: Proyek (nama tebal + `project_id`
    monospace) | Pemilik (`owner_email` atau `–`) | Peran (badge:
    `user` bg-primary, `assistant` bg-success, lain bg-secondary; teks =
    nilai `role` mentah) | Isi (`excerpt`, `text-break`, min-width 300px) |
    Waktu (`fmtDate`).
  - Empty state: `Tidak ada pesan.` (`colspan=5`).
  - Tidak ada pagination (maks 100 baris).

### 1.14 Pengumuman

- **Route:** `GET /admin/pengumuman` · judul `Pengumuman` · loader
  `loadAnnouncements()` (cache modul `announcementsCache`).
- **Endpoint:**
  - `GET /api/admin/announcements` → `{ announcements[] }`, tiap item:
    `{ id, title, body, active, created_at, updated_at }`. Diurutkan
    `created_at DESC, id DESC`. `active` = 1/0.
  - `POST /api/admin/announcements` — body `{ title, body }` →
    `{ ok: true, id }`. Pengumuman baru selalu `active = 0`. Error 400
    `Judul wajib diisi (maks 200 karakter).` (`body` dipotong 5000 karakter).
  - `PUT /api/admin/announcements/:id` — body `{ title, body }` →
    `{ ok: true }`. Error 400 `ID tidak valid.` (id bukan integer); 404
    `Pengumuman tidak ditemukan.`; 400 `Judul wajib diisi (maks 200
    karakter).`; 400 `Tidak ada field yang diubah.`
  - `DELETE /api/admin/announcements/:id` → `{ ok: true }`. Error 400/404
    sama seperti di atas.
  - `POST /api/admin/announcements/:id/activate` — tanpa body = aktifkan
    (menonaktifkan semua pengumuman lain); body `{ active: false }` =
    nonaktifkan tanpa pengganti → `{ ok: true, active }`. Error 400/404.
- **Inventaris UI:**
  - Header `Pengumuman` + sub-teks: `Pengumuman untuk semua pengguna. Hanya
    satu pengumuman yang aktif dalam satu waktu.` + tombol
    `#announcement-add-btn` `Buat Pengumuman`.
  - Alert info: `Pengumuman aktif akan ditampilkan sebagai banner di builder
    setelah perubahan penyajian dipasang (belum tersedia — lihat catatan di
    bawah).`
  - Tabel `#announcements-body`, kolom: Judul (tebal) | Isi (kutipan maks
    120 karakter + `…` bila lebih panjang, `text-break`, min-width 240px,
    atau `–`) | Status (badge `bg-success` `Aktif` / `bg-secondary`
    `Nonaktif`) | Dibuat (`fmtDate`) | Aksi.
  - Aksi:
    - `Aktifkan` (`btn-outline-success`) bila nonaktif → konfirmasi
      `Aktifkan pengumuman`, teks `Aktifkan pengumuman ini? Pengumuman aktif
      lainnya akan dinonaktifkan.`, label Ya `Ya, aktifkan`. Sukses → toast
      `Pengumuman diaktifkan.` + reload.
    - `Nonaktifkan` (`btn-outline-warning`) bila aktif → TANPA konfirmasi,
      POST `{ active: false }`. Sukses → toast `Pengumuman dinonaktifkan.`
      + reload.
    - `Ubah` (`btn-outline-primary`) → formDialog `Ubah pengumuman`: `title`
      (required), `body` (textarea, rows 4), terisi nilai saat ini. Batal
      bila judul kosong. Sukses → toast `Pengumuman diperbarui.` + reload.
    - `Hapus` (`btn-outline-danger`) → konfirmasi `Hapus pengumuman`, teks
      `` `Hapus pengumuman "${title}"? Tindakan ini tidak bisa dibatalkan.` ``,
      label Ya `Ya, hapus`. Sukses → toast `Pengumuman dihapus.` + reload.
  - `Buat Pengumuman` → formDialog `Buat pengumuman`: `title` (required),
    `body` (textarea, rows 4, help `Isi pengumuman yang ditampilkan di
    banner builder.`). Batal bila judul kosong. Sukses → toast
    `Pengumuman dibuat (belum aktif).` + reload.
  - Empty state: `Belum ada pengumuman.` (`colspan=5`).
  - Kartu `Catatan` (statis): `Menampilkan banner di builder semua pengguna
    masih tertunda: butuh endpoint publik (mis. GET /api/announcements/active)
    di app.ts + komponen banner di platform/*. Pengumuman yang dibuat di sini
    tersimpan di database dan siap ditampilkan begitu penyajian dipasang.`
- **Catatan:** banner builder BELUM ada — pengumuman aktif saat ini tidak
  terlihat oleh pengguna mana pun. Jangan klaim sebaliknya.

### 1.15 Sesi

- **Route:** `GET /admin/sessions` · judul `Sesi` · loader `loadSessions()`.
- **Endpoint:**
  - `GET /api/admin/sessions` → `{ sessions[] }`, maks 200, diurutkan
    `created_at DESC`. Tiap sesi: `{ hash, user_id, created_at, expires_at,
    email, name, active }`. `hash` = **12 karakter pertama** `token_hash`
    (server: `substr(s.token_hash, 1, 12)`). `active` = `expires_at > now()`.
  - `DELETE /api/admin/sessions/:hash` → `{ ok: true }`. `:hash` wajib
    cocok `^[a-f0-9]{12}$` (else 400 `Hash sesi tidak valid.`); 404
    `Sesi tidak ditemukan.`; 400 `Sesi sendiri tidak boleh dicabut dari sini
    (pakai Logout).` (server membandingkan hash token cookie admin sendiri).
- **Inventaris UI:**
  - Header `Sesi` + sub-teks: `Sesi login aktif dan kedaluwarsa. Hash sesi
    hanya ditampilkan 12 karakter pertama.`
  - Tabel `#sessions-body`, kolom: Pengguna (nama atau email atau `–` +
    email kecil) | Dibuat (`fmtDate(created_at)`) | Kedaluwarsa
    (`fmtDate(expires_at)`) | Status (badge `bg-success` `Aktif` bila
    `active`, else badge `bg-secondary` `Kedaluwarsa`) | Hash (monospace)
    | Aksi.
  - Aksi: `Cabut` (`btn-outline-danger`, hanya bila `active`) → konfirmasi
    `Cabut sesi`, teks `` `Cabut sesi login milik ${email}? Pengguna harus
    masuk lagi.` ``, label Ya `Ya, cabut`. Sukses → toast `Sesi dicabut.`
    + reload. Sesi tidak aktif: sel aksi berisi `–`.
  - Empty state: `Tidak ada sesi.` (`colspan=6`).

### 1.16 Kesehatan Sistem

- **Route:** `GET /admin/health` · judul `Kesehatan Sistem` · loader
  `loadHealth()`.
- **Endpoint:**
  - `GET /api/admin/health` → `{ ok, uptimeSec, node, platform, memory,
    dbSize, model, strongModel, auditModel, llm, previews, counts }`:
    - `uptimeSec`: `Math.round(process.uptime())`.
    - `node`: `process.version`; `platform`: `process.platform`.
    - `memory`: `{ rss, heapUsed, heapTotal }` (byte).
    - `dbSize`: byte file DB aktif (0 bila gagal baca).
    - `model` / `strongModel` / `auditModel`: model efektif saat ini.
    - `llm`: `{ host, keyConfigured, reachable, status?, latencyMs,
      error? }`. `host` = host URL endpoint efektif (`-` bila tidak valid).
      `reachable` = hasil `GET` endpoint dengan timeout 3000 ms;
      `status` = status HTTP bila tercapai; `error` = pesan error (maks
      200 karakter) bila tidak tercapai. **Perhatian:** ini GET ke URL
      `chat/completions`, bukan POST — status HTTP apa pun (termasuk 4xx)
      dihitung "terjangkau".
    - `previews`: **array** `[{ projectId, port }]` (dari `runningPreviews()`
      di `workspace.ts`).
    - `counts`: `{ users, projects, messages, builds, sessions }`.
  - `GET /api/admin/alerts` — dipanggil lagi di dalam `loadHealth()` (selain
    di `fillNotifications` saat boot) untuk kartu Ambang Peringatan →
    `{ alerts[], thresholds: { buildFailCount, buildFailPct, diskPct } }`
    (default `{ 3, 50, 85 }`; dari `admin_settings` key `alert_thresholds`).
    `alerts[]`: `{ level: 'warning' | 'critical', kind, message, at }`,
    `kind` ∈ `llm_not_configured`, `llm_down`, `build_fail_spike`,
    `disk_full`. `at` = waktu penghitungan (now), bukan waktu kejadian.
    Gagal fetch → kartu ambang tetap menampilkan keadaan sebelumnya
    (catch diam-diam).
- **Inventaris UI:**
  - Header `Kesehatan Sistem` + sub-teks: `Status server, LLM, dan preview
    yang berjalan.`
  - 4 kartu stat (`#health-cards`, digenerate JS): Uptime server
    (`` `${jam} jam ${mnt} mnt` ``, sub `` `Node ${node} · ${platform}` ``),
    Memori (RSS) (`fmtBytes(rss)`, sub
    `` `Heap ${fmtBytes(heapUsed)} / ${fmtBytes(heapTotal)}` ``), Ukuran
    database (`fmtBytes(dbSize)`, sub `` `${users} pengguna ·
    ${projects} proyek` ``), Sesi aktif (`counts.sessions`, sub
    `` `${messages} pesan · ${builds} build` ``).
  - Kartu `LLM Gateway` (`#llm-status-body`, definition list): Endpoint
    (`llm.host`, monospace), Model (`model`), API key (badge `bg-success`
    `Terpasang` / `bg-danger` `Tidak ada`), Status (`llm.reachable` → badge
    `bg-success` `` `Terjangkau${status ? ` (HTTP ${status})` : ''}` `` +
    `<small>${latencyMs} ms</small>`; tidak terjangkau → badge `bg-danger`
    `Tidak terjangkau` + `<small class=text-danger>${error}</small>`).
  - Kartu `Preview Berjalan` (`#previews-body`): tabel Proyek | Port, atau
    `Tidak ada preview yang berjalan saat ini.`
    - **BUG / PERILAKU SAAT INI (wajib diperbaiki di React, lihat §3 Q3):**
      `admin.js` memakai `Object.entries(previews)` dengan asumsi `previews`
      objek `{ id: port }`, padahal server mengembalikan **array**
      `[{ projectId, port }]`. Akibatnya tabel saat ini menampilkan indeks
      array (`0`, `1`, …) sebagai "Proyek" dan `[object Object]` sebagai
      "Port". React WAJIB merender `projectId` + `port` dari tiap elemen
      array.
  - Kartu `Ambang Peringatan` (`#alert-thresholds-body`, awal `Memuat…`):
    definition list: `Build gagal (1 jam)` →
    `` `${buildFailCount} gagal atau >${buildFailPct}% gagal` ``;
    `Disk penuh` → `` `>${diskPct}% terpakai` ``; `Peringatan aktif` →
    badge per alert (`` `${kind}` ``, `bg-danger` bila `level==='critical'`,
    else `bg-warning text-dark`) atau badge `bg-success` `Tidak ada`.
    Kaki: `Ambang tersimpan di pengaturan admin (key alert_thresholds).`
    **Tidak ada UI untuk mengubah ambang** (tidak ada endpoint PUT) —
    lihat §3 Q4.
  - Efek samping: `loadHealth()` juga mengisi `#nav-health-badge` (lihat
    §0.11).

### 1.17 Cadangan & Pulihkan

- **Route:** `GET /admin/cadangan` · judul `Cadangan & Pulihkan` · loader
  `loadBackup()`.
- **Endpoint:**
  - `GET /api/admin/backup/list` → `{ dbSize, counts, files[] }`:
    - `counts`: `{ users, projects, messages, builds }`.
    - `files[]`: `{ name, size, mtime, isAutoBackup }`, diurutkan nama
      menurun. Nama yang dikenali: `vibebuilder.db.bak-<ms>`
      (`isAutoBackup: true`) dan `vibebuilder-YYYYMMDD-HHMM.db`
      (file unduhan yang disalin kembali ke direktori data).
  - `GET /api/admin/backup` — unduhan file (lihat §0.15). Nama file
    `vibebuilder-YYYYMMDD-HHMM.db`.
  - `POST /api/admin/restore` — dua varian:
    - **JSON** `{ backup: "<nama>" }` → `{ ok: true, restarting: true,
      autoBackup }`. Nama wajib cocok `^vibebuilder\.db\.bak-\d+$` (else 400
      `Nama cadangan otomatis tidak valid.`); file tidak ada → 404
      `File cadangan tidak ditemukan.`
    - **multipart/form-data** field `file` → respons sama. Validasi: file
      kosong → 400 `File unggahan kosong.`; `> 200 MB` → 400
      `File unggahan terlalu besar (maks 200 MB).`; field hilang → 400
      `Field file wajib diisi (unggah file .db).`
    - Validasi isi (kedua varian): `PRAGMA integrity_check` harus `ok` +
      tabel inti harus ada (`users, projects, messages, files, builds,
      plans, token_usage, admin_settings`); gagal → 400
      `` `Cadangan tidak valid: ${alasan} Database aktif tidak diubah.` ``
    - Sukses: DB aktif disalin dulu ke `vibebuilder.db.bak-<ms>` (cadangan
      otomatis), file kandidat menggantikan DB aktif, file `-wal`/`-shm`
      dihapus, lalu server `process.exit(0)` setelah 500 ms (supervisor
      menghidupkan ulang dengan DB baru).
- **Inventaris UI:**
  - Header `Cadangan & Pulihkan` + sub-teks: `Unduh salinan database, atau
    pulihkan dari file cadangan. Setiap pemulihan otomatis menyimpan cadangan
    database aktif terlebih dahulu.` + tombol `#backup-download-btn`
    `Unduh cadangan` (tautan ke `/api/admin/backup`).
  - 4 kartu stat (`#backup-cards`): Ukuran database (`fmtBytes(dbSize)`,
    sub `file vibebuilder.db aktif`), Pengguna (`counts.users`, sub
    `` `${counts.projects} proyek` ``), Pesan (`counts.messages`, sub
    `` `${counts.builds} build tercatat` ``), File cadangan
    (`files.length`, sub `di direktori data server`).
  - Kartu `File Cadangan di Server` — tabel `#backup-files-body`, kolom:
    Nama file (monospace + badge `bg-secondary` `otomatis` bila
    `isAutoBackup`) | Ukuran (`fmtBytes`) | Dibuat (`fmtDate(mtime)`) |
    Aksi (tombol `Pulihkan` `btn-outline-warning` HANYA bila `isAutoBackup`,
    else `–`).
    - Tombol `Pulihkan` → konfirmasi `Pulihkan dari cadangan otomatis`,
      teks `` `Ganti database aktif dengan ${name}? Database aktif saat ini
      disimpan dulu sebagai cadangan otomatis baru, lalu server restart
      sendiri.` ``, label Ya `Ya, pulihkan`. Sukses (JSON) → isi
      `#restore-result`: badge `Berhasil` +
      `Server sedang restart dengan database yang dipulihkan. Tunggu beberapa
      detik lalu muat ulang halaman ini.` + toast
      `Pemulihan diterima — server sedang restart.`
    - Kosong: `Belum ada file cadangan. Unduh cadangan dulu, atau pulihkan
      sekali — cadangan otomatis akan muncul di sini.` (`colspan=4`).
    - Kaki kartu: `File .bak-<waktu> dibuat otomatis setiap kali pemulihan
      berhasil — itu cadangan database aktif sebelum diganti. Pulihkan dari
      file itu memakai jalur validasi yang sama seperti unggahan.`
  - Kartu `Pulihkan dari File` — teks: `Unggah file .db hasil unduhan
    cadangan. File divalidasi dulu (integritas SQLite + tabel inti); bila
    tidak valid, database aktif **tidak diubah**. Bila valid, server menyimpan
    cadangan otomatis lalu restart sendiri dengan database baru.`
    Form `#restore-form`: input file `#restore-file`
    (`accept=".db,application/octet-stream"`, `required`, label
    `File cadangan (.db)`), tombol submit `#restore-submit`
    `Pulihkan database` (warning). Area hasil `#restore-result`.
    - Submit tanpa file → toast error `Pilih dulu file cadangan (.db).`
    - Submit dengan file → konfirmasi `Pulihkan database`, teks
      `Ganti database aktif dengan file yang diunggah? Database aktif saat
      ini disimpan dulu sebagai cadangan otomatis baru, lalu server restart
      sendiri.`, label Ya `Ya, pulihkan`.
    - Saat proses: tombol disable + `#restore-result` spinner
      `Memvalidasi dan memulihkan…`.
    - Sukses → `#restore-result`: badge `Berhasil` +
      `Server sedang restart dengan database yang dipulihkan. Cadangan
      otomatis: <code>${autoBackup}</code>. Tunggu beberapa detik lalu muat
      ulang halaman ini.` + toast `Pemulihan diterima — server sedang
      restart.`
    - Gagal → `#restore-result` teks error merah (bukan toast).
    - Tombol diaktifkan kembali di `finally`.
- **Catatan:** setelah restore sukses, UI TIDAK mengecek kesiapan server —
  admin harus muat ulang manual setelah beberapa detik. React harus
  mempertahankan perilaku itu (atau menanyakan perbaikan, lihat §3 Q9).

### 1.18 Pembersihan

- **Route:** `GET /admin/pembersihan` · judul `Pembersihan` · loader
  `loadCleanup()`.
- **Endpoint:**
  - `GET /api/admin/cleanup` → `{ settings, counts, lastRun }`:
    - `settings`: `{ retentionDays, auto, lastRunAt, lastRun }`
      (default `{ retentionDays: 30, auto: false, lastRunAt: null,
      lastRun: null }`; dari `admin_settings` key `cleanup_settings`).
    - `counts`: `{ builds, sessions, previewsRunning }` — `builds` = build
      lebih lama dari retensi; `sessions` = sesi kedaluwarsa;
      `previewsRunning` = jumlah preview berjalan (tidak pernah dihapus).
    - `lastRun`: `{ at, builds, sessions, previews } | null`.
  - `POST /api/admin/cleanup/run` (tanpa body) → `{ ok: true, at,
    retentionDays, deleted: { builds, sessions, previews,
    previewsRunning } }`. `previews` selalu `0`. Menghapus build lama +
    sesi kedaluwarsa, lalu menyimpan `lastRun`.
  - `PUT /api/admin/cleanup/settings` — body `{ retentionDays, auto }` →
    `{ ok: true, settings }`. Validasi: retensi 1–365 (else 400
    `Retensi harus 1–365 hari.`); `auto` wajib boolean (else 400
    `Field auto wajib boolean.`).
  - Server juga menjalankan pembersihan otomatis tiap jam (timer di
    `registerAdmin`) bila `auto` true dan ≥24 jam sejak `lastRunAt`.
- **Inventaris UI:**
  - Header `Pembersihan` + sub-teks: `Hapus data lama yang sudah tidak
    dipakai: build lama dan sesi login kedaluwarsa. Preview yang sedang
    berjalan tidak pernah dihentikan dari sini.` + tombol
    `#cleanup-run-btn` `Jalankan pembersihan sekarang`.
  - 3 kartu (`#cleanup-cards`): Build lama (`counts.builds`, sub
    `` `lebih lama dari ${retentionDays} hari` ``), Sesi kedaluwarsa
    (`counts.sessions`, sub `sesi login yang sudah lewat masa berlaku`),
    Preview berjalan (`counts.previewsRunning`, sub
    `tidak pernah dihentikan pembersihan`).
  - Kartu `Pengaturan Retensi` — form `#cleanup-settings-form`: input
    `#cleanup-retention` (number, min 1, max 365, step 1, maks lebar 200px,
    label `Simpan build selama (hari)`; help `Build yang dibuat lebih lama
    dari ini akan dihapus. Sesi login dihapus begitu kedaluwarsa, tidak
    peduli retensi.`), switch `#cleanup-auto` (label
    `Pembersihan otomatis (sekali sehari)`), tombol `Simpan pengaturan`.
    Sukses → toast `Pengaturan pembersihan disimpan.` + reload.
  - Kartu `Hasil Terakhir` (`#cleanup-last-body`): bila `lastRun` ada —
    definition list Waktu (`fmtDate(at)`) | Build dihapus | Sesi dihapus |
    Preview dihapus (`` `${previews} (tidak pernah)` ``); bila null →
    `Belum pernah ada pembersihan.`
  - Kartu `Catatan` (statis): `Preview adalah proses yang sedang berjalan —
    pembersihan tidak pernah mematikan preview. Bila ada preview yang macet,
    hentikan dari halaman proyek atau restart server.`
  - Tombol jalankan → konfirmasi `Jalankan pembersihan`, teks
    `Hapus sekarang semua build lama dan sesi kedaluwarsa sesuai retensi
    yang tersimpan? Preview yang berjalan tidak disentuh.`, label Ya
    `Ya, bersihkan`. Sukses → toast `` `Pembersihan selesai:
    ${deleted.builds} build, ${deleted.sessions} sesi dihapus.` `` + reload.

### 1.19 Log Audit

- **Route:** `GET /admin/audit` · judul `Log Audit` · loader `loadAudit()`
  (state modul `auditQuery = ''`, `auditAction = ''`,
  `auditActionsCache = []`).
- **Endpoint:**
  - `GET /api/admin/audit?q=&action=&limit=100` → `{ logs[] }`, tiap log:
    `{ id, admin_email, action, target_type, target_id, detail,
    created_at }`. Diurutkan `id DESC`. Server: `limit` default 100, clamp
    1–200. `q` dicari (`LIKE %q%`) di `admin_email`, `action`, `target_id`,
    `detail`. `action` = cocok persis.
  - Aksi yang tercatat server (`logAdmin`, detail dipotong 500 karakter):
    `user.disable`, `user.enable`, `user.delete`, `project.delete`,
    `ai_settings.update`, `plan.create`, `plan.update`, `plan.delete`,
    `user.assign_plan`, `credit.settings.update`, `credit.adjust`,
    `session.revoke`. (Aksi moderasi, pengumuman, domain, billing,
    maintenance, cleanup, restore TIDAK tercatat — lihat §3 Q10.)
- **Inventaris UI:**
  - Header `Log Audit` + subtitle `#audit-subtitle` (awal `Memuat…`, diisi
    `` `${N} entri log` `` — N = jumlah baris pada halaman ini, maks 100).
  - Kontrol kanan: select `#audit-action-filter` (opsi awal
    `Semua aksi`, maks lebar 220px) + kotak cari: input `#audit-search`
    (placeholder `Cari admin, aksi, target…`) + tombol `#audit-search-btn`.
  - Tabel `#audit-body`, kolom: Waktu (`fmtDate`, nowrap) | Admin
    (`admin_email` atau `–`) | Aksi (badge `bg-secondary`) | Target
    (`target_type` + `target_id` monospace kecil bila ada) | Detail
    (`detail` atau `–`, `text-break`, min-width 220px).
  - Empty state: `Tidak ada log yang cocok.` (`colspan=5`).
  - **Logika filter (penting):**
    - Klik Cari atau Enter → `auditQuery = search.value.trim()`,
      `auditAction = filter.value` → `loadAudit()`.
    - `change` pada select filter → langsung `loadAudit()` juga.
    - Opsi dropdown aksi dihitung dari aksi unik pada muatan saat ini,
      **tapi di-cache**: `auditActionsCache` hanya diperbarui bila
      `auditAction` kosong dan muatan punya aksi (`if (!auditAction &&
      actions.length) auditActionsCache = actions`). Tujuannya: dropdown
      tidak menyusut jadi satu opsi saat sedang memfilter per aksi.
      Bila cache kosong, pakai aksi dari muatan saat ini.
- **Catatan:** tidak ada pagination (maks 100 entri); tidak ada filter
  tanggal.

### 1.20 Pemeliharaan

- **Route:** `GET /admin/pemeliharaan` · judul `Pemeliharaan` · loader
  `loadMaintenance()`.
- **Endpoint:**
  - `GET /api/admin/maintenance` → `{ enabled, message, updated_at }`
    (dari `admin_settings` key `maintenance_mode`; rusak/tidak ada →
    `{ enabled: false, message: '', updated_at: null }`).
  - `PUT /api/admin/maintenance` — body `{ enabled, message }` →
    `{ ok: true, enabled, message, updated_at }`. `enabled` wajib boolean
    (else 400 `Field enabled wajib boolean.`); `message` dipotong 2000
    karakter.
- **Inventaris UI:**
  - Header `Pemeliharaan` + sub-teks: `Mode pemeliharaan untuk pengunjung.
    Pengaturan tersimpan di database.`
  - Alert kuning: `**Belum berlaku.** Mengaktifkan mode pemeliharaan di sini
    baru menyimpan pengaturannya. Halaman maintenance untuk pengunjung baru
    tampil setelah middleware di app.ts dipasang (tertunda).`
  - Kartu `Pengaturan Mode Pemeliharaan` — form `#maintenance-form`:
    switch `#maintenance-enabled` (label `Mode pemeliharaan aktif`),
    textarea `#maintenance-message` (rows 4, placeholder
    `cth. VibeBuilder sedang dalam pemeliharaan. Kami kembali sebentar lagi.`,
    help `Pesan yang dilihat pengunjung di halaman maintenance (maks 2000
    karakter).`), tombol `Simpan` + teks kecil `#maintenance-updated`
    (`` `Terakhir disimpan ${fmtDate(updated_at)}` `` bila ada).
    Sukses → toast `Mode pemeliharaan diaktifkan (tersimpan; halaman
    pengunjung menyusul).` (bila enabled) atau
    `Mode pemeliharaan dimatikan.` + reload.
  - Kartu `Pratinjau Pesan` (`#maintenance-preview`): ikon wrench + teks
    `#maintenance-preview-text` = isi textarea (trim) atau
    `Belum ada pesan.` — diperbarui **langsung** pada event `input`
    (`updateMaintenancePreview`). Kaki: `Pratinjau di atas mengikuti isi
    kolom pesan. Tampilan halaman maintenance sebenarnya ditentukan oleh
    middleware penyajian (belum dipasang).`
  - Kartu `Status Saat Ini` (`#maintenance-status-body`, awal `Memuat…`):
    bila `enabled` → badge `bg-warning text-dark`
    `Mode pemeliharaan AKTIF` + teks `Pengaturan tersimpan, tapi halaman
    maintenance untuk pengunjung belum tampil — middleware penyajian belum
    dipasang.`; bila tidak → badge `bg-success`
    `Mode pemeliharaan nonaktif` + teks `Situs berjalan normal.`
- **Catatan:** mode ini saat ini TIDAK berpengaruh apa pun pada pengunjung —
  hanya tersimpan. Jangan klaim sebaliknya.

### 1.21 Pengaturan AI

- **Route:** `GET /admin/ai-settings` · judul `Pengaturan AI` · loader
  `loadAiSettings()`.
- **Endpoint:**
  - `GET /api/admin/ai-settings` → `{ model, modelStrong, modelAudit,
    endpoint, keyConfigured, sources, defaults }`:
    - Nilai efektif (panel menang atas env, env menang atas default).
    - `sources`: `{ model, modelStrong, modelAudit, endpoint, key }`,
      tiap nilai `'db' | 'env' | 'default'`.
    - `defaults`: `{ model, modelStrong, modelAudit }` (konstanta kode:
      `FAST_MODEL`, `STRONG_MODEL`, `AUDIT_MODEL`).
    - `keyConfigured` boolean; nilai key TIDAK PERNAH dikembalikan.
  - `PUT /api/admin/ai-settings` — body `{ model, modelStrong, modelAudit,
    endpoint, key }` → `{ ok: true, ...aiSettingsView() }`. Aturan per field:
    field `undefined` = tidak diubah; string kosong (setelah trim) = hapus
    dari DB (kembali ke env/default); string terisi = simpan (validasi:
    model regex `^[A-Za-z0-9][A-Za-z0-9._\-/:]*$` maks 120 karakter;
    endpoint wajib URL `http(s)`; key min 8 karakter). Error 400:
    `Nama model tidak valid (maks 120 karakter).` /
    `Endpoint harus URL http(s).` / `Endpoint harus URL http(s) yang valid.`
    / `API key terlalu pendek (min 8 karakter).` /
    `` `Field ${key} harus string.` ``
    Log audit `ai_settings.update` hanya mencatat NAMA field yang diubah,
    tidak pernah nilai key.
  - `POST /api/admin/ai-settings/test` (tanpa body) →
    `{ ok: true, model, latencyMs, reply }` atau
    `{ ok: false, model, latencyMs, error }` (selalu HTTP 200; `reply`
    dipotong 500 karakter; `error` dipotong 300 karakter). Server mengirim
    prompt `Jawab singkat saja: berapa 1+1?` ke model efektif. **Tes ini
    SENGAJA tanpa userId: tidak melewati gate dan tidak memotong saldo
    admin** (komentar kode: biaya kecil ditanggung owner).
- **Inventaris UI:**
  - Header `Pengaturan AI` + sub-teks: `Model dan provider LLM yang dipakai
    server. Perubahan berlaku langsung tanpa restart.`
  - Kartu `Konfigurasi AI` — form `#ai-settings-form`
    (`autocomplete=off`):
    - `ai-model` (text, placeholder dari `defaults.model`): label
      `Model utama` + badge sumber `#ai-model-src`. Help: `Model default
      untuk chat dan agent. Kosongkan untuk kembali ke
      environment/default.`
    - `ai-model-strong`: label `Model kuat` + `#ai-model-strong-src`.
      Help: `Model untuk pekerjaan berat bila diminta klien.`
    - `ai-model-audit`: label `Model audit` + `#ai-model-audit-src`.
      Help: `Model peninjau keamanan/aksesibilitas sesudah penulisan file.`
    - `ai-endpoint` (`type=url`, placeholder dari server? — TIDAK: nilai
      input diisi `s.endpoint || ''`, placeholder TIDAK diset dari kode;
      placeholder HTML `http://127.0.0.1:20128/v1/chat/completions`):
      label `Endpoint LLM` + `#ai-endpoint-src`. Help: `URL lengkap endpoint
      OpenAI-compatible (chat/completions).`
    - `ai-key` (password, `autocomplete=new-password`): label `API key` +
      `#ai-key-src`. Nilai input SELALU dikosongkan saat load; placeholder
      `•••••••• (terpasang — isi untuk mengganti)` bila `keyConfigured`,
      else `Belum ada key`. Help: `Isi untuk mengganti key, atau kosongkan
      untuk memakai yang sudah tersimpan / environment. Nilai key tidak
      pernah ditampilkan.`
    - Badge sumber (`srcBadge`): `db` → badge `bg-primary` `panel`;
      `env` → badge `bg-warning text-dark` `env`; else badge
      `bg-secondary` `default`.
    - Tombol: submit `Simpan Pengaturan AI` (primary) + `#ai-test-btn`
      `Tes Koneksi` (outline-secondary). Submit: kirim keempat field teks
      (trim; string kosong ikut terkirim = hapus dari DB) + `key` HANYA
      bila terisi. Sukses → toast
      `Pengaturan AI disimpan — berlaku langsung tanpa restart.`,
      kosongkan input key, `loadAiSettings()`.
  - Kartu `Konfigurasi Efektif` — definition list `#ai-effective-list`
    (5 baris): Model utama (`model`), Model kuat (`modelStrong`), Model
    audit (`modelAudit`), Endpoint (`endpoint`), API key
    (`Terpasang` / `Tidak ada`).
  - Kartu `Hasil Tes Koneksi` (`#ai-test-result`, awal
    `Belum ada tes. Tekan "Tes Koneksi" untuk mengirim satu prompt kecil ke
    LLM dengan konfigurasi saat ini.`): saat tes → spinner
    `Mengirim prompt tes ke LLM…`; sukses → badge `Berhasil` +
    `<small>${latencyMs} ms · model <code>${model}</code></small>` +
    `Balasan: <strong>${reply}</strong>`; gagal → badge `Gagal` + pesan
    error merah.
  - Kartu `Sumber Nilai` (statis): `panel` (bg-primary) `diubah dari panel
    admin ini (tersimpan di database).` `env` (bg-warning)
    `berasal dari environment server.` `default` (bg-secondary)
    `nilai bawaan kode. Nilai panel selalu menang atas env.`

### 1.22 Pengaturan

- **Route:** `GET /admin/settings` · judul `Pengaturan` · loader
  `loadSettings()`. **Halaman ini hanya tampil (read-only)** — tidak ada
  form, tidak ada tombol simpan.
- **Endpoint:**
  - `GET /api/admin/settings` → `{ ...aiSettingsView(), llmHost,
    publicSuffix, publicOrigin, dbPath, dbSize, signupOpen, admin, note }`:
    - `llmHost`: host URL endpoint efektif (`-` bila tidak valid).
    - `publicSuffix` / `publicOrigin`: env `VB_PUBLIC_SUFFIX` /
      `VB_PUBLIC_ORIGIN` atau `'none'`.
    - `dbPath`: env `VB_DB` atau `<ROOT>/data/vibebuilder.db`.
    - `dbSize`: byte (0 bila gagal baca).
    - `signupOpen`: `true` bila belum ada pengguna sama sekali.
    - `admin`: `{ email, via } | null` (`via`: `'env'` bila
      `VB_ADMIN_EMAIL`, else `'first-account'`).
    - `note`: teks penjelasan (tidak dipakai UI).
    - `...aiSettingsView()`: `model, modelStrong, modelAudit, endpoint,
      keyConfigured, sources, defaults` (sama §1.21).
- **Inventaris UI:**
  - Header `Pengaturan` + sub-teks: `Konfigurasi server saat ini (tampilan
    saja).`
  - Kartu `Konfigurasi` — definition list `#settings-list` (8 baris):
    Model utama (`model`), Model kuat (`modelStrong`), Model audit
    (`modelAudit`), LLM host (`llmHost`), API key LLM
    (`Terpasang` / `Tidak ada`), Domain publik
    (`` `${publicSuffix} (${publicOrigin})` ``), Database
    (`` `${dbPath} (${fmtBytes(dbSize)})` ``), Pendaftaran
    (`Terbuka (belum ada pengguna)` bila `signupOpen`, else
    `Tertutup (sudah ada pengguna)`).
  - Kartu `Admin` (`#admin-identity-body`): bila `admin` ada →
    email tebal + teks `Ditentukan lewat environment VB_ADMIN_EMAIL`
    (bila `via === 'env'`) atau `akun pertama yang dibuat (pemilik
    instalasi)`; bila null → `Belum ada pengguna, jadi belum ada admin.`
  - Kartu `Catatan` (statis): `Model dan provider LLM bisa diubah dari
    halaman **Pengaturan AI** (tersimpan di database, berlaku tanpa restart).
    Akun admin adalah akun pertama yang dibuat, kecuali VB_ADMIN_EMAIL
    diset.`

---

## 2) Tabel kontrak API

Semua endpoint di bawah memakai `Content-Type: application/json` (kecuali
unduhan CSV/backup dan upload restore). Semua `/api/admin/*` di-gate
`requireAdmin` (401 `Belum masuk.` / 403 `Bukan admin.`) — pengecualian
`GET`/`PUT /api/admin/billing` memeriksa sendiri (401/403 sama).
Bentuk error umum: `{ error: "<pesan>" }` dengan status HTTP di kolom
"Error". `n/a` = tidak ada body khusus.

### 2.1 Auth (dipakai panel)

| Method | Path | Tujuan | Param | Respons sukses | Error |
|---|---|---|---|---|---|
| GET | `/api/auth/me` | Identitas sesi saat ini (boot) | — | `{ user: { id, email, name, created_at, disabled? } \| null, signupOpen: boolean }` | — |
| POST | `/api/auth/logout` | Hapus sesi + clear cookie | — | `{ ok: true }` | — |

### 2.2 Overview, pengguna, proyek

| Method | Path | Tujuan | Param | Respons sukses | Error |
|---|---|---|---|---|---|
| GET | `/api/admin/overview` | Angka ringkasan + aktivitas + top user (boot, badge nav, notifikasi, dashboard) | — | `{ users: { total, new7d, disabled }, projects: { total, published, new7d, byStatus }, messages: { total, today, last7d }, builds: { total, ok, fail }, usage: { requests, promptTokens, completionTokens }, plans: { total }, tokenUsage: { totalTokens, usersTracked }, recent: [{ kind, text, at }], topUsers: [{ id, email, name, projects, messages }] }` | 403 bila bukan admin |
| GET | `/api/admin/users` | Daftar semua pengguna | — | `{ adminEmail, users: [{ id, email, name, created_at, disabled, projects, messages, tokens, last_seen, plan_id, plan_name, plan_limit, isAdmin }] }` | — |
| PATCH | `/api/admin/users/:id` | Aktif/nonaktifkan akun | body `{ disabled: boolean }` | `{ ok: true, id, disabled }` | 404 `Pengguna tidak ditemukan.`; 400 `Akun sendiri tidak boleh diubah dari sini.`; 400 `Field disabled wajib boolean.` |
| DELETE | `/api/admin/users/:id` | Hapus akun + semua proyeknya | — | `{ ok: true, deletedProjects }` | 404; 400 `Akun sendiri tidak boleh dihapus.` |
| POST | `/api/admin/users/:id/plan` | Tetapkan/lepas plan pengguna | body `{ planId: string \| null }` | `{ ok: true, planId }` | 404 `Pengguna tidak ditemukan.` / `Plan tidak ditemukan.` |
| GET | `/api/admin/projects` | Daftar semua proyek | — | `{ projects: [{ id, name, status, slug, created_at, updated_at, owner_id, owner_email, owner_name, messages, files, last_build_ok }] }` | — |
| DELETE | `/api/admin/projects/:id` | Hapus proyek | — | `{ ok: true }` | 404 `Proyek tidak ditemukan.` |

### 2.3 Penggunaan & biaya

| Method | Path | Tujuan | Param | Respons sukses | Error |
|---|---|---|---|---|---|
| GET | `/api/admin/usage` | Statistik LLM + deret 14 hari + top user | — | `{ llm: { requests, promptTokens, completionTokens }, daily: [{ date, messages, users, projects }], byUser: [{ email, name, messages }], byUserTokens: [{ email, name, tokens, prompt_tokens, completion_tokens }], totals: { messages, projects, builds, tokens } }` | — |
| GET | `/api/admin/cost` | Laporan biaya per model & per pengguna | query `days` (0 = semua, default 30, clamp 1–365) | `{ days, since, until, prices: { [model]: { prompt_per_1k, completion_per_1k, currency } }, byModel: [{ model, requests, prompt_tokens, completion_tokens, total_tokens, cost_idr, priced }], byUser: [{ user_id, email, name, requests, prompt_tokens, completion_tokens, total_tokens, cost_idr, unpriced_tokens }], totals: { requests, prompt_tokens, completion_tokens, total_tokens, cost_idr, hasPriced, unpriced_tokens }, allTime: { requests, prompt_tokens, completion_tokens, total_tokens } }` | — |
| GET | `/api/admin/cost.csv` | Unduh laporan biaya (CSV) | query `days` (sama) | File `text/csv`, `attachment; filename="biaya-llm-{semua\|Nd}hari.csv"`; kolom `bagian,model_atau_pengguna,permintaan,prompt_tokens,completion_tokens,total_tokens,biaya_idr` | — |
| PUT | `/api/admin/cost/prices` | Simpan SELURUH map harga model | body `{ prices: { [model]: { prompt_per_1k, completion_per_1k, currency: 'IDR' } } }` | `{ ok: true, prices }` | 400 `Field prices wajib objek.`; 400 `Nama model tidak valid: …`; 400 `Harga model … tidak valid.`; 400 `Harga model … harus angka >= 0 (Rp per 1.000 token).` |

### 2.4 Kesehatan, pengaturan, AI

| Method | Path | Tujuan | Param | Respons sukses | Error |
|---|---|---|---|---|---|
| GET | `/api/admin/health` | Status server + LLM + preview | — | `{ ok: true, uptimeSec, node, platform, memory: { rss, heapUsed, heapTotal }, dbSize, model, strongModel, auditModel, llm: { host, keyConfigured, reachable, status?, latencyMs, error? }, previews: [{ projectId, port }], counts: { users, projects, messages, builds, sessions } }` | — |
| GET | `/api/admin/alerts` | Peringatan aktif + ambang | — | `{ alerts: [{ level: 'warning' \| 'critical', kind, message, at }], thresholds: { buildFailCount, buildFailPct, diskPct } }` | — |
| GET | `/api/admin/settings` | Konfigurasi server (read-only) | — | `{ model, modelStrong, modelAudit, endpoint, keyConfigured, sources, defaults, llmHost, publicSuffix, publicOrigin, dbPath, dbSize, signupOpen, admin: { email, via } \| null, note }` | — |
| GET | `/api/admin/ai-settings` | Konfigurasi AI efektif + sumber | — | `{ model, modelStrong, modelAudit, endpoint, keyConfigured, sources: { model, modelStrong, modelAudit, endpoint, key }, defaults: { model, modelStrong, modelAudit } }` | — |
| PUT | `/api/admin/ai-settings` | Ubah model/endpoint/key | body `{ model?, modelStrong?, modelAudit?, endpoint?, key? }` (string kosong = hapus dari DB) | `{ ok: true, ...aiSettingsView() }` | 400 `Nama model tidak valid (maks 120 karakter).`; 400 `Endpoint harus URL http(s).` / `…yang valid.`; 400 `API key terlalu pendek (min 8 karakter).`; 400 `Field … harus string.` |
| POST | `/api/admin/ai-settings/test` | Tes prompt kecil ke LLM efektif | — | `{ ok: true, model, latencyMs, reply }` atau `{ ok: false, model, latencyMs, error }` (HTTP 200) | — |

### 2.5 Plan & credit

| Method | Path | Tujuan | Param | Respons sukses | Error |
|---|---|---|---|---|---|
| GET | `/api/admin/plans` | Daftar plan + jumlah pengguna | — | `{ plans: [{ id, name, token_limit, price_idr, description, monthly_credits, created_at, updated_at, users }] }` | — |
| POST | `/api/admin/plans` | Buat plan | body `{ name, tokenLimit?, priceIdr?, description?, monthlyCredits? }` | `{ ok: true, id }` (`id` = `plan_<random>`) | 400 `Nama plan wajib diisi (maks 80 karakter).` |
| PATCH | `/api/admin/plans/:id` | Ubah plan | body `{ name?, tokenLimit?, priceIdr?, description?, monthlyCredits? }` | `{ ok: true }` | 404 `Plan tidak ditemukan.`; 400 nama; 400 `Tidak ada field yang diubah.` |
| DELETE | `/api/admin/plans/:id` | Hapus plan | — | `{ ok: true }` | 404 `Plan tidak ditemukan.` |
| GET | `/api/admin/credits/settings` | Pengaturan angka credit | — | `{ settings: { freeGrant, freeDays, freeDailyCap, minBalance, dailyCapFree, dailyCapPaid, maxCallsPerHour }, defaults: { freeGrant: 100, freeDays: 30, freeDailyCap: 50, minBalance: 10, dailyCapFree: 200, dailyCapPaid: 1000, maxCallsPerHour: 120 } }` | — |
| PUT | `/api/admin/credits/settings` | Simpan pengaturan angka credit | body ketujuh field di atas (parsial OK) | `{ ok: true, settings }` | — |
| GET | `/api/admin/credits/users` | Cari pengguna + saldo ringkas | query `q` (email/nama, substring, case-insensitive); maks 50 | `{ users: [{ id, email, name, created_at, plan_id, plan_name, free_balance, purchased_balance, plan_credits, total }] }` | — |
| GET | `/api/admin/credits/users/:id` | Detail saldo + riwayat user | — | `{ user: { id, email, name, created_at, disabled }, plan: { planId, planName, monthlyCredits }, balance: { total, free, purchased, plan, freeExpiresAt, purchasedExpiresAt, planExpiresAt }, raw: { free_expires_at, purchased_expires_at, plan_credits_expires_at, plan_credits_reset_at, updated_at } \| null, usage: [{ model, prompt_tokens, completion_tokens, cost_usd, credit, shortfall_credit, created_at }] (50), orders: [{ order_id, package, amount_idr, credits, status, created_at, paid_at }] (20), transactions: [{ kind, bucket, amount, balance_after, reason, order_id, created_at }] (100) }` | 404 `Pengguna tidak ditemukan.` |
| POST | `/api/admin/credits/users/:id/adjust` | Tambah/kurangi credit manual | body `{ bucket: 'free' \| 'purchased' \| 'plan', amount, reason }` | `{ ok: true, balance, applied }` | 404; 400 `Bucket tidak dikenal (free / purchased / plan).`; 400 dari `adjustCredit` (jumlah nol / >1.000.000 / saldo negatif) |

### 2.6 Pembayaran (Clipku Pay)

| Method | Path | Tujuan | Param | Respons sukses | Error |
|---|---|---|---|---|---|
| GET | `/api/admin/billing` | Status + kredensial Clipku Pay (tanpa nilai rahasia) | — | `{ configured, apiKeyFromEnv, hasWebhookSecret, webhookUrl, packages: [{ id, amountIdr, credits }], orderCounts: { [status]: n }, recentWebhookEvents: [{ order_id, event, signature_valid, result, created_at }], note }` | 401/403 (cek manual di handler) |
| PUT | `/api/admin/billing` | Simpan/hapus key & webhook secret panel | body `{ apiKey?, webhookSecret? }` (string kosong = hapus) | `{ ok: true, configured, hasWebhookSecret }` | 400 bila bukan string / panjang > 300 |

### 2.7 Provider LLM

| Method | Path | Tujuan | Param | Respons sukses | Error |
|---|---|---|---|---|---|
| GET | `/api/admin/llm/providers` | Registry provider + model + tarif | — | `{ providers: [{ id, name, baseUrl, keyEnv, active, notes?, keyConfigured, models: [{ id, name?, active, rateInUsdPer1M, rateOutUsdPer1M, endpoint?, notes?, messagesOnly?, toolsConfirmed?, contextLength? }] }] }` | — |
| PUT | `/api/admin/llm/providers/:providerId` | Aktif/nonaktifkan provider | body `{ active: boolean }` | `{ ok: true, provider: { id, active } }` | 400 `Provider tidak valid.` / `Field active wajib boolean.`; 404 provider tak dikenal |
| PUT | `/api/admin/llm/providers/:providerId/models/:modelId` | Toggle model ATAU set tarif | body `{ active: boolean }` atau `{ rateInUsdPer1M?, rateOutUsdPer1M? }` (`null` = hapus tarif) | `{ ok: true, model: { id, active } }` atau `{ ok: true, model: { id, rateInUsdPer1M, rateOutUsdPer1M } }` | 400 `Provider/model tidak valid.`; 400 `Field active atau tarif wajib diisi.`; 404 `Model tidak dikenal: …` |
| PUT | `/api/admin/llm/providers/:providerId/key` | Simpan/hapus key panel provider | body `{ key: string }` (`''` = hapus) | `{ ok: true, keyConfigured }` | 400 `Field key wajib string (kosongkan untuk menghapus).`; 400 `API key terlalu pendek (min 8 karakter).` |
| POST | `/api/admin/llm/providers/:providerId/test` | Tes `GET /models` upstream | — | `{ ok: true, status, models? }` atau `{ ok: false, status?, error }` (HTTP 200) | 400 provider tidak valid |
| POST | `/api/admin/llm/providers/:providerId/sync` | Ambil daftar model upstream | — | `{ provider, upstream: [{ id, name?, contextLength?, endpoints? }], inRegistry, missing: [id] }` | 502 `{ error }` bila upstream gagal |
| POST | `/api/admin/llm/prices/sync` | Salin tarif registry → `llm_prices` | — | `{ ok: true, added, skipped }` | — |

### 2.8 Moderasi, domain, pengumuman, pemeliharaan

| Method | Path | Tujuan | Param | Respons sukses | Error |
|---|---|---|---|---|---|
| GET | `/api/admin/moderation` | Daftar proyek + status flag/suspend | — | `{ projects: [{ id, name, status, slug, created_at, updated_at, owner_id, suspended, owner_email, owner_name, flag_reason, flag_by, flagged_at, flagged }] }` | — |
| POST | `/api/admin/projects/:id/flag` | Tandai proyek (ganti flag lama) | body `{ reason }` | `{ ok: true, flagId }` | 404 `Proyek tidak ditemukan.`; 400 `Alasan penandaan wajib diisi.`; 400 `Alasan maksimal 500 karakter.` |
| DELETE | `/api/admin/projects/:id/flag` | Hapus tanda | — | `{ ok: true }` | 404 `Proyek tidak ditemukan.` / `Proyek ini tidak ditandai.` |
| POST | `/api/admin/projects/:id/suspend` | Tangguhkan proyek + hentikan preview | — | `{ ok: true, suspended: true }` | 404 `Proyek tidak ditemukan.` |
| POST | `/api/admin/projects/:id/unsuspend` | Buka penangguhan | — | `{ ok: true, suspended: false }` | 404 `Proyek tidak ditemukan.` |
| GET | `/api/admin/domains` | Daftar domain + target CNAME | — | `{ domains: [{ id, project_id, domain, status, created_at, verified_at, project_name, project_slug }], expectedCname: 'clidi.net', ssl: 'belum dipasang' }` | — |
| POST | `/api/admin/domains` | Tambah domain | body `{ projectId, domain }` | `{ ok: true, id }` | 400 `Proyek wajib dipilih.`; 404 `Proyek tidak ditemukan.`; 400 `Format domain tidak valid.`; 400 `Domain sudah terdaftar.` |
| DELETE | `/api/admin/domains/:id` | Hapus domain | — | `{ ok: true }` | 404 `Domain tidak ditemukan.` |
| POST | `/api/admin/domains/:id/verify` | Periksa DNS domain | — | `{ ok: true, domain, expectedCname, cnames, addresses, cnameError, aError, matched, status, note, ssl }` | 404 `Domain tidak ditemukan.` |
| GET | `/api/admin/announcements` | Daftar pengumuman | — | `{ announcements: [{ id, title, body, active, created_at, updated_at }] }` | — |
| POST | `/api/admin/announcements` | Buat pengumuman (nonaktif) | body `{ title, body }` | `{ ok: true, id }` | 400 `Judul wajib diisi (maks 200 karakter).` |
| PUT | `/api/admin/announcements/:id` | Ubah pengumuman | body `{ title?, body? }` | `{ ok: true }` | 400 `ID tidak valid.`; 404 `Pengumuman tidak ditemukan.`; 400 judul; 400 `Tidak ada field yang diubah.` |
| DELETE | `/api/admin/announcements/:id` | Hapus pengumuman | — | `{ ok: true }` | 400/404 |
| POST | `/api/admin/announcements/:id/activate` | Aktifkan / nonaktifkan | tanpa body = aktifkan; body `{ active: false }` = nonaktifkan | `{ ok: true, active }` | 400/404 |
| GET | `/api/admin/maintenance` | Status mode pemeliharaan | — | `{ enabled, message, updated_at }` | — |
| PUT | `/api/admin/maintenance` | Simpan mode pemeliharaan | body `{ enabled: boolean, message? }` | `{ ok: true, enabled, message, updated_at }` | 400 `Field enabled wajib boolean.` |

### 2.9 Build, pesan, sesi, audit, cadangan, pembersihan

| Method | Path | Tujuan | Param | Respons sukses | Error |
|---|---|---|---|---|---|
| GET | `/api/admin/builds` | Riwayat build (maks 200) | query `limit` (default 50, clamp 1–200); UI memakai 100 | `{ builds: [{ id, project_id, ok, log, created_at, project_name, owner_email }] }` | — |
| GET | `/api/admin/messages` | Daftar pesan chat | query `q` (LIKE isi), `limit` (default 100, clamp 1–200) | `{ messages: [{ id, project_id, role, excerpt, created_at, project_name, owner_email }] }` (`excerpt` = 300 karakter pertama) | — |
| GET | `/api/admin/sessions` | Daftar sesi (maks 200) | — | `{ sessions: [{ hash, user_id, created_at, expires_at, email, name, active }] }` (`hash` = 12 karakter pertama `token_hash`) | — |
| DELETE | `/api/admin/sessions/:hash` | Cabut sesi | `:hash` = 12 karakter heks | `{ ok: true }` | 400 `Hash sesi tidak valid.`; 404 `Sesi tidak ditemukan.`; 400 `Sesi sendiri tidak boleh dicabut dari sini (pakai Logout).` |
| GET | `/api/admin/audit` | Log audit admin | query `q` (LIKE admin_email/action/target_id/detail), `action` (cocok persis), `limit` (default 100, clamp 1–200) | `{ logs: [{ id, admin_email, action, target_type, target_id, detail, created_at }] }` | — |
| GET | `/api/admin/backup` | Unduh snapshot DB | — | File `application/octet-stream`, `attachment; filename="vibebuilder-YYYYMMDD-HHMM.db"` | 500 `{ error }` bila VACUUM INTO gagal |
| GET | `/api/admin/backup/list` | Daftar file cadangan + hitungan | — | `{ dbSize, counts: { users, projects, messages, builds }, files: [{ name, size, mtime, isAutoBackup }] }` | — |
| POST | `/api/admin/restore` | Pulihkan DB (restart server) | JSON `{ backup }` (nama auto-backup) ATAU multipart field `file` (.db, maks 200 MB) | `{ ok: true, restarting: true, autoBackup }` | 400 nama tidak valid / file kosong / >200 MB / field hilang / cadangan tidak valid; 404 file tidak ditemukan; 500 gagal pulihkan |
| GET | `/api/admin/cleanup` | Status + hitungan pembersihan | — | `{ settings: { retentionDays, auto, lastRunAt, lastRun }, counts: { builds, sessions, previewsRunning }, lastRun: { at, builds, sessions, previews } \| null }` | — |
| POST | `/api/admin/cleanup/run` | Jalankan pembersihan sekarang | — | `{ ok: true, at, retentionDays, deleted: { builds, sessions, previews, previewsRunning } }` | — |
| PUT | `/api/admin/cleanup/settings` | Simpan retensi + auto | body `{ retentionDays?, auto? }` | `{ ok: true, settings }` | 400 `Retensi harus 1–365 hari.`; 400 `Field auto wajib boolean.` |

**Total endpoint yang dipakai panel: 62 `/api/admin/*` + 2 `/api/auth/*` =
64.** Di luar cakupan (tidak dipakai panel admin): `GET /api/llm/models`
(publik, dari `providers.ts`), `GET /topup`, `/api/billing/*` (pengguna
biasa), dan semua endpoint builder di `app.ts`.

### 2.10 Route halaman & aset (GET, tanpa auth di level route — gate ada di API)

| Path | Disajikan |
|---|---|
| `GET /admin` | `server/src/admin/pages/dashboard.html` (hasil build) |
| `GET /admin/<slug>` | `server/src/admin/pages/<file>.html` untuk 21 slug lain (peta `ADMIN_PAGES` di `admin.ts`: users, projects, pemeliharaan, pengumuman, plans, credits, usage, builds, biaya, providers, billing, domain, messages, moderasi, sessions, health, cadangan, pembersihan, ai-settings, audit, settings) |
| `GET /admin/` | Redirect 302 ke `/admin` |
| `GET /admin/assets/admin.js` | `server/src/admin/admin.js` |
| `GET /admin/assets/admin-icons.css` | `server/src/admin/admin-icons.css` |
| `GET /admin/assets/*` | `server/src/admin/vendor/assets/*` (whitelist ekstensi, `..` ditolak) |

---

## 3) Pertanyaan terbuka

Jangan menebak jawaban — setiap butir di bawah ini butuh keputusan dari
pemilik/parent sebelum atau selama build. Butir bertanda **[BUG]** adalah
perilaku kode lama yang terbukti salah; rekomendasi SPEC sudah ditulis di
§1, tapi konfirmasi tetap diminta.

1. **Dashboard — `#chart-range-label` tidak pernah diisi.** Elemen badge di
   header kartu `Pesan per Hari (14 hari)` ada di `dashboard.html`, tetapi
   tidak ada satu baris pun di `admin.js` yang menulis `textContent`-nya,
   sehingga selalu kosong. Apa yang seharusnya tampil di sana (mis.
   rentang tanggal 14 hari)? Atau hapus elemennya di React?
2. **Arsitektur React — pola penyajian.** Apakah React tetap "satu halaman
   penuh per route, disajikan server" (pengganti drop-in `pages/*.html` +
   `admin.js`, route tetap `GET /admin/<slug>`) atau menjadi SPA dengan
   routing klien dan satu entry point? Ini memengaruhi §0.1, cara
   `build-pages.mjs` diganti, dan apakah `serveAdminFile`/`ADMIN_PAGES` di
   `admin.ts` ikut berubah.
3. **[BUG] Kesehatan — tabel Preview Berjalan salah render.** Server
   mengembalikan `previews` sebagai **array** `[{ projectId, port }]`
   (`workspace.ts: runningPreviews()`), tetapi `admin.js` memakai
   `Object.entries(previews)` seolah objek `{ id: port }`, sehingga tabel
   menampilkan indeks (`0`, `1`, …) dan `[object Object]`. Rekomendasi SPEC
   (§1.16): React merender `projectId` + `port` dengan benar. Konfirmasi:
   perbaiki (bukan replikasi bug)?
4. **Ambang peringatan (`alert_thresholds`) tidak bisa diubah dari UI.**
   `GET /api/admin/alerts` mengembalikan `thresholds` dari `admin_settings`
   key `alert_thresholds`, dan halaman Kesehatan menampilkannya, tetapi
   tidak ada endpoint PUT dan tidak ada form. Apakah React cukup menampilkan
   (seperti sekarang), atau perlu ada editor ambang + endpoint server baru
   (di luar cakupan rewrite penyajian)?
5. **Form Plan tidak mengirim `monthlyCredits`.** `POST`/`PATCH
   `/api/admin/plans` di server menerima `monthlyCredits` (jatah credit
   bulanan; Gratis=100, Pro=2000), tetapi form tambah/ubah di `admin.js`
   hanya mengirim `name, tokenLimit, priceIdr, description`, sehingga plan
   baru via UI selalu `monthly_credits = 0` dan jatah plan itu tidak pernah
   terisi. Apakah React menambah field `monthlyCredits` di form plan?
6. **`PROVIDER_NOTES` hardcoded di `admin.js`.** Teks peringatan per
   provider (commandcode terblokir paket Go, PRO Gater habis 2 Des 2026
   13:38 WIB, cara buat key Sumopod, catatan `llm.key` mengalahkan key
   panel) adalah string HTML di klien, bukan dari server — termasuk tanggal
   kedaluwarsa yang akan basi. Pertahankan verbatim di React, pindahkan ke
   server, atau hapus/perbarui?
7. **Refresh manual hanya ada di Dashboard.** Tombol `#refresh-btn` hanya
   ada di `dashboard.html`; 21 halaman lain tidak punya cara refresh selain
   memuat ulang halaman browser. Apakah React menambah tombol refresh di
   semua halaman, atau mempertahankan perilaku ini?
8. **Polling — tetap tidak ada?** Kode lama tidak punya auto-refresh /
   polling / SSE di panel admin (notifikasi, badge, dan semua tabel hanya
   dimuat saat navigasi/boot). Apakah React tetap tanpa polling, atau ada
   halaman yang butuh refresh berkala (mis. kesehatan, build)?
9. **Restore — tanpa pengecekan kesiapan server.** Setelah restore sukses,
   server `process.exit(0)` dan UI hanya meminta admin memuat ulang manual
   setelah beberapa detik. Apakah React mempertahankan ini, atau menambah
   pengecekan kesiapan (poll `GET /api/auth/me` sampai hidup lalu reload
   otomatis)?
10. **Cakupan log audit tidak lengkap.** Yang tercatat: user (disable/enable/
    delete), project delete, ai_settings, plan, assign plan, credit settings/
    adjust, session revoke. Yang TIDAK tercatat: moderasi (flag/suspend),
    pengumuman, domain, billing, maintenance, cleanup, restore, ubah harga
    biaya, ubah provider/key/tarif. Apakah ini sengaja (server-side, di luar
    rewrite), atau perlu dilengkapi di server bersamaan rewrite?
11. **Target visual React.** SPEC ini mengontrak perilaku + data + teks.
    Apakah tampilan React harus identik dengan template Metis/Bootstrap
    saat ini (layout, warna, ikon Bootstrap Icons, class), atau boleh
    desain baru selama perilaku sama? Bila identik, dari mana React
    mengambil CSS Metis (tetap pakai `vendor/assets/main-*.css` + Bootstrap)?
12. **Route tak dikenal.** `loadPage()` tidak punya cabang `else`: bila
    `body[data-page]` bernilai di luar 22 halaman, tidak ada yang dimuat
    (halaman kosong, tanpa error). Route server hanya melayani 22 slug, jadi
    kondisi ini tidak tercapai saat ini. Di React (bila SPA): route tak
    dikenal dialihkan ke Dashboard atau menampilkan 404?
13. **`POST /api/admin/ai-settings/test` tanpa gate/saldo.** Tes koneksi
    sengaja tanpa `userId` — tidak melewati gate credit dan tidak memotong
    saldo (komentar kode di `admin.ts`). Konfirmasi: perilaku ini dipertahankan
    apa adanya di React (tidak ada perubahan server)?
14. **`GET /api/admin/billing` tidak memakai `requireAdmin`.** Handler di
    `billing.ts` memeriksa `currentUser` + `isAdminUser` sendiri (401/403
    sama). Perilaku sama dari sisi klien; konfirmasi tidak ada yang perlu
    diubah.
15. **Model ID mengandung `/` di URL.** `PUT /api/admin/llm/providers/:id/
    models/:modelId` dipanggil dengan `encodeURIComponent(modelId)` (mis.
    `cx%2Fgpt-5.6-luna`). React WAJIB melakukan encode yang sama. (Tidak
    diverifikasi lebih dalam apakah Hono mendekode `%2F` di segmen path
    dengan benar di semua kasus — perilaku saat ini di UI lama diasumsikan
    jalan; bila React menemui 404 pada model ber-slash, laporkan.)
16. **Input number kosong di `formDialog` menjadi `0`.** `formDialog`
    mengumpulkan input number sebagai `Number(el.value)`; string kosong →
    `0` (bukan `null`/tidak dikirim). Berdampak mis. pada dialog harga biaya
    (harga kosong tersimpan sebagai 0, bukan "belum diketahui"). Apakah
    React mempertahankan semantik ini, atau membedakan kosong vs 0?
17. **Form tambah domain tanpa proyek.** Select `#domain-project` tidak
    punya opsi kosong; bila belum ada proyek sama sekali, select kosong dan
    submit gagal server (`Proyek wajib dipilih.`). Apakah React menambah
    opsi placeholder / menonaktifkan tombol bila tidak ada proyek?
18. **Pencarian credit memakai `q` kosong = 50 user pertama.** `GET
    /api/admin/credits/users` tanpa `q` mengembalikan 50 user pertama
    (`created_at ASC`). Di UI lama pencarian hanya terjadi setelah tombol
    Cari ditekan. Apakah React tetap memakai pola "cari dulu, baru tampil",
    atau memuat 50 pertama otomatis saat halaman dibuka?
19. **`overviewCache` tidak pernah dibaca ulang.** Variabel disimpan di
    `boot()`/refresh tetapi tidak dipakai di tempat lain. Apakah React
    memerlukan cache overview, atau cukup fetch ulang tiap navigasi?
20. **Dua elemen `data-search-input`.** Ctrl+K fokus ke input pertama di DOM
    (pencarian header), bukan `#credit-search` di halaman credits. Apakah
    React mempertahankan ini, atau Ctrl+K fokus ke pencarian halaman aktif
    bila ada?
21. **Field respons yang tidak dipakai UI lama.** Contoh: `overview.builds`,
    `overview.plans`, `overview.tokenUsage`, `users.adminEmail`,
    `projects.last_build_ok`, `domains.project_slug`,
    `credits detail usage.cost_usd/prompt_tokens/completion_tokens`,
    `billing.note`, `settings.note`, `health.strongModel/auditModel`
    (hanya `model` ditampilkan di kartu LLM). React boleh mengabaikan
    field-field ini (kontrak §2 menandai yang dipakai), kecuali ada yang
    diminta ditampilkan — sebutkan bila ada.
22. **Bahasa & format.** Semua teks UI berbahasa Indonesia; format angka/
    tanggal memakai locale `id-ID` (§0.16). Apakah React memakai pustaka
    i18n atau string literal Indonesia seperti sekarang (tidak ada sistem
    i18n di kode lama)?

---

## Lampiran: ringkasan hitungan (untuk laporan)

- Halaman terdokumentasi: **22** (§1.1–§1.22), urut sidebar.
- Endpoint terdaftar di §2: **64** (62 `/api/admin/*` + 2 `/api/auth/*`).
  Rincian `/api/admin/*`: overview 1, users 4 (termasuk assign plan),
  projects 2,
  usage 1, cost 3, health 1, alerts 1, settings 1, ai-settings 3, plans 4,
  credits 5, billing 2, providers 7, moderation 5, domains 4, announcements
  5, maintenance 2, builds 1, messages 1, sessions 2, audit 1, backup 2,
  restore 1, cleanup 3.
- Route halaman server: **22** (`/admin` + 21 slug) + redirect `/admin/` +
  aset.
- Pertanyaan terbuka: **22** (§3.1–§3.22).
- Modal global: 3 (konfirmasi, form generik, log build). Chart: 2 halaman.
  Unduhan: 2 (CSV biaya, backup DB). Unggahan: 1 (restore `.db`).
- Fitur yang dinyatakan BELUM berfungsi di UI lama (jangan diklaim jalan di
  React): penegakan suspend di jalur publik; routing + SSL domain otomatis;
  banner pengumuman di builder; halaman maintenance pengunjung; pengiriman
  `monthlyCredits` dari form plan.

---

*Dokumen dibuat 2026-11-26 oleh agen SPEC/AUDIT dari baca-penuh kode pada
HEAD `718a88c`. Satu-satunya file yang ditulis: `admin-react/SPEC.md`.*

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


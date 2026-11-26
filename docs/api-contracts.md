# Kontrak API (OpenAPI)

`server/openapi.yaml` adalah inventaris route HTTP WebBuilder yang
dibangkitkan dari kode — bukan ditulis tangan. Satu-satunya sumber kebenaran
adalah route Gin yang terdaftar server.

## Regenerasi

```bash
cd server && go run ./cmd/generate-openapi
```

Perintah ini juga memperbarui blok `API_ROUTES` di
`packages/types/src/index.ts` dari model route yang sama. CI trek lain
menjalankan generator lalu memeriksa tidak ada diff:

```bash
cd server && go run ./cmd/generate-openapi && git diff --exit-code server/openapi.yaml
```

Bila perintah di atas gagal setelah ada perubahan route, jalankan generator
dan commit hasilnya bersama perubahan route tersebut.

## Cara kerja

Generator (`server/cmd/generate-openapi/main.go`):

1. Membangun engine Gin yang sama dengan server: `handler.RegisterRoutes`
   ditambah 4 rute publik dari `server/main.go`
   (`/pub/:slug`, `/pub-assets/:slug/*filepath`, `/share/:token`,
   `/share-assets/:token/:filepath`).
2. Membaca `engine.Routes()` — hanya MEMBACA, tidak mengubah endpoint,
   middleware, atau perilaku apa pun.
3. Mengurutkan route (path, lalu method) dan menulis `openapi.yaml`
   secara deterministik: tanpa timestamp, tanpa iterasi map yang tidak
   terurut. Dijalankan dua kali hasilnya identik byte-per-byte
   (diverifikasi dengan `sha256sum`).
4. Mengklasifikasikan auth per route (lihat bawah) dan menurunkan tabel
   rute TypeScript ke `packages/types/src/index.ts` di antara marker
   `BEGIN GENERATED` / `END GENERATED`. Bila marker tidak ada, generator
   gagal dengan pesan jelas — jangan tulis blok itu manual.
5. Berjalan hermetic: memakai `HOME` sementara + `WEBBUILDER_KEY` dummy
   supaya tidak membaca/menulis `~/.webbuilder-key` milik developer.

Validasi spec: `python3 -c "import yaml; yaml.safe_load(open('server/openapi.yaml'))"`
harus sukses; jumlah route saat dokumen ini ditulis: 189 operasi di 147 path.

## Model auth (`x-auth`)

| Nilai | Arti | Contoh |
|---|---|---|
| `public` | Tanpa auth | `POST /api/auth/login`, `GET /api/health`, `POST /api/billing/webhook`, `GET /pub/{slug}` |
| `jwt-or-apikey` | Header `Authorization: Bearer <token>` — JWT builder (klaim `uid`, 30 hari) atau API key pribadi `wb_*` | mayoritas `GET/POST /api/...` |
| `project-session` | Header `X-Project-Session` — token sesi aplikasi hasil generate, bukan JWT builder | `POST /api/app-api/{id}/db/select` dkk |

Rute preview (`/api/projects/{id}/runtime/preview/{filepath}`, `Any`)
juga menerima token grant `pv_*` sebagai query/header khusus iframe;
di spec ia tetap `jwt-or-apikey` karena JWT juga diterima di sana.

## Yang TIDAK ada di spec (sengaja)

- **Skema request/response body.** Handler memakai struct anonim per
  endpoint, jadi generator tidak bisa menurunkan skema tanpa menebak.
  Spec ini memodelkan route + parameter path + auth saja. Bila suatu
  endpoint butuh kontrak body, dokumentasikan di sini secara eksplisit
  atau definisikan tipe request/response bernama di handler dan ajarkan
  generator membacanya — jangan ditebak.
- **Rute non-API**: `GET /` dan `NoRoute` (SPA fallback) serta `/assets`
  (file statis) tidak masuk spec.
- **Perilaku bisnis** (kuota, status pembayaran, dsb.) — lihat test di
  `server/internal/handler/*_test.go`.

## Cakupan test terkait

- `auth_test.go`: validasi register/login, lockout 5x gagal → 429,
  JWT (kedaluwarsa/secret lain/tanpa uid), API key `wb_*`, 2FA TOTP,
  reset password (token kedaluwarsa/sekali pakai), forgot-password
  tidak membocorkan keberadaan email.
- `quota_test.go`: default kuota per plan, override via settings,
  agregasi pemakaian bulanan.
- `payment_test.go`: subscription kedaluwarsa turun ke free,
  aktivasi idempoten, validasi awal webhook/checkout.
- **Tidak teruji (butuh gateway)**: jalur sukses `billingWebhook`,
  `paymentStatus`, dan `checkoutPlan` memanggil biner eksternal
  `clipkupay` (`/home/hatch/workspace/skills/clipkupay/bin/clipkupay`).
  Test hanya menutup jalur validasi sebelum pemanggilan biner. Jalur
  sukses harus diuji manual/lingkungan staging dengan gateway.

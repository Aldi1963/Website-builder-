# Deploy

Dokumen ini menjelaskan cara deploy WebBuilder, cara rollback, dan apa yang
masih placeholder. Status: **deploy otomatis BELUM AKTIF** (TREK A item 11,
15 Nov 2026) — deploy produksi hari ini masih dilakukan manual di host live
(`build.clipku.my.id`, supervisor VM), yang sengaja TIDAK diatur dari repo ini.

## Cara server berjalan (yang harus dipertahankan)

- Binary Go + frontend statis digabung: `server/main.go` serve `index.html`
  dari `../server/web/dist` dan API di port listen (default **18082**,
  override via `PORT`).
- Database default: **SQLite** `../data/webbuilder.db` (relatif ke working
  directory `server/`). `DATABASE_URL` kosong = SQLite default; bila diset
  `postgres://...` server memakai Postgres + migrasi berversi goose
  (lihat `docs/database.md`) — opt-in, bukan default.
- `JWT_SECRET` wajib: server menolak start tanpanya (baca dari env, atau
  file `../.jwt-secret`).
- `PORT` dibaca `server/main.go` sebagai port listen (default `18082`).
  Scaffold proyek mengikuti nilai ini: target proxy `/api` di vite.config
  dan `VITE_API_BASE_URL` di `.env.example` proyek hasil generate
  diturunkan dari `PORT` saat server jalan (lihat
  `server/internal/handler/runtime.go`: `serverPort`/`apiBaseURL`).
- Eksekusi tenant default **mati**; jangan hidupkan lewat deploy.

## Batasan yang memengaruhi deploy container

`server/main.go` mengikat `127.0.0.1:<PORT>` (default 18082). Di dalam container, listener itu
hanya terjangkau dari dalam container sendiri — pemetaan port Docker biasa
(`-p 18082:18082`) **tidak tembus**. Sampai `main.go` diubah agar bind
`0.0.0.0` (perlu keputusan koordinator; di luar partisi TREK A), container
harus jalan dengan **host networking** (`--network host`, atau
`network_mode: host` di `docker-compose.yml`). Compose di repo ini sudah
memakai host networking karena alasan itu. Catatan ini juga berlaku untuk
reverse proxy: proxy harus berada di host yang sama / menjangkau loopback
container host-network.

## Build image

Docker belum tersedia di VM pengerjaan saat Dockerfile ditulis, jadi image
ini **belum pernah ter-build** — jalankan verifikasi ini di mesin yang ada
Docker-nya sebelum dipakai:

```bash
docker build -t webbuilder:$(git rev-parse --short HEAD) .
docker run --rm --network host -e JWT_SECRET='<isi-dari-secret-manager>' webbuilder:<tag>
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18082/
```

`Dockerfile` (multi-stage): stage 1 build web (`pnpm build`), stage 2
build server Go (CGO aktif karena `mattn/go-sqlite3`; final stage
`debian:bookworm-slim`, bukan alpine/scratch, supaya binary glibc jalan),
stage final menyalin binary + `web/dist` ke `/app/server/web/dist` dan
memakai volume `/app/data` untuk SQLite.

## Deploy lokal via compose

```bash
cp .env.example .env   # isi JWT_SECRET (dan AI_* bila perlu); JANGAN commit .env
docker compose up --build -d
docker compose --profile optional up --build -d   # bila perlu redis
docker compose logs -f app
```

Service `postgres` di compose disediakan untuk opt-in Postgres mendatang —
**app tidak terhubung ke sana hari ini**. Service `redis` ada di profile
`optional` — server tidak memakai Redis hari ini (queue in-memory).

## Variabel environment

| Variabel | Wajib | Keterangan |
| --- | --- | --- |
| `JWT_SECRET` | Ya | Secret JWT; tanpa ini server menolak start. Isi lewat secret manager / `.env` yang tidak di-commit. |
| `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL` | Tidak | Konfigurasi provider AI; kosong = fitur AI nonaktif. |
| `DATABASE_URL` | Tidak | Kosong = SQLite default; `postgres://...` = Postgres + migrasi goose (lihat `docs/database.md`). |
| `PORT` | Tidak | Port listen server (default 18082); scaffold proyek (proxy `/api` vite.config dan `VITE_API_BASE_URL` di `.env.example`) mengikuti nilai ini. |

Tidak ada host, password, atau token yang di-hardcode di workflow maupun
compose — semua lewat environment/secret.

## Alur yang direncanakan (staging → produksi)

Workflow `.github/workflows/deploy.yml` masih **PLACEHOLDER** (manual saja,
`workflow_dispatch`): job `deploy-staging`, `deploy-production`, dan
`rollback` hanya mencetak TODO. Sebelum diaktifkan, lengkapi:

1. Target deploy + cara akses (host SSH atau registry + orchestrator).
2. Secrets GitHub: `DEPLOY_SSH_HOST`, `DEPLOY_SSH_USER`, `DEPLOY_SSH_KEY`,
   dan bila memakai registry: `REGISTRY_USER`, `REGISTRY_PASSWORD`.
3. Environment GitHub `production` dengan **required reviewers** (approval
   manusia) sebelum deploy produksi boleh jalan.
4. Perintah health-check pasca-deploy (mis. `GET /` → 200 + login smoke
   test) dan kriteria rollback.
5. Aturan: produksi hanya di-deploy dari ref yang sudah hijau di staging;
   backup database (`scripts/backup.sh`) **sebelum** deploy produksi.

Sampai kelimanya ada, JANGAN ubah workflow menjadi otomatis (trigger push).

## Rollback

Prosedur manual (otomatisasi rollback juga masih TODO di workflow):

1. Kembalikan container ke **tag image rilis sebelumnya** (tag memakai git
   SHA — jangan deploy tag `latest` yang tidak terlacak).
2. Bila deploy mengubah skema/data dan perlu dikembalikan: restore backup
   dengan `scripts/restore.sh <file-backup>` (lihat `docs/backup.md`).
   **Hati-hati:** restore database membuang data yang masuk sesudah backup
   dibuat — putuskan sadar, dan hentikan server dulu.
3. Verifikasi health-check + login, lalu umumkan ke tim.
4. Bila penyebabnya kode, perbaiki di branch + CI hijau, bukan dengan
   hotfix langsung di host live.

## Yang sengaja TIDAK diubah trek ini

- Perilaku default live (SQLite, eksekusi tenant mati, API yang ada).
- Infra live (`build.clipku.my.id`, supervisor VM, `boot-recover.sh`)
  bukan bagian repo ini dan tidak disentuh.
- `server/main.go` (bind address + PORT) — perubahan di sana butuh
  keputusan koordinator karena memengaruhi host live.

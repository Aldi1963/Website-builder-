# TREK A item 2 — Dockerfile multi-stage.
#
# Satu image gabungan yang meniru cara main.go serve sekarang:
#   binary Go + hasil build web di server/web/dist, port 18082.
#   server/main.go membaca frontend dari ../server/web/dist (relatif ke
#   working directory server/) dan database dari ../data/webbuilder.db.
#   Karena itu WORKDIR image ini /app/server, dist disalin ke
#   /app/server/web/dist, dan data tinggal di /app/data (volume).
#
# CATATAN PENTING — bind address (bukan diubah di sini):
#   main.go mengikat 127.0.0.1:18082. Di dalam container itu berarti port
#   hanya bisa dijangkau dari dalam container itu sendiri; pemetaan port
#   Docker biasa (-p 18082:18082) TIDAK akan tembus. Sampai main.go diubah
#   agar bind 0.0.0.0 (di luar partisi TREK A — perlu keputusan koordinator),
#   jalankan container ini dengan host networking (lihat docker-compose.yml)
#   atau `docker run --network host`. Jangan "memperbaiki" ini di Dockerfile
#   dengan mengubah main.go.
#
# CATATAN BUILD — belum teruji di VM ini:
#   Docker TIDAK tersedia di VM pengerjaan (15 Nov 2026: `docker: command
#   not found`), jadi `docker build` belum pernah dijalankan untuk file ini.
#   Dockerfile ditulis mengikuti layout repo yang sudah diverifikasi
#   (go.mod, package.json, pnpm workspace) — tapi anggap BELUM TERUJI
#   sampai seseorang menjalankannya di mesin yang ada Docker-nya.
#
# CGO: server memakai mattn/go-sqlite3 (CGO). Build stage memakai image
# golang berbasis Debian (ada gcc) dan CGO_ENABLED=1 (default); final stage
# memakai debian:bookworm-slim (glibc) — BUKAN alpine/scratch — supaya
# binary hasil build tetap bisa jalan.

# ---- Stage 1: build frontend (React + TS + Vite) ----
FROM node:24-bookworm-slim AS web-build
WORKDIR /build
RUN corepack enable && corepack prepare pnpm@11.28.2 --activate
# Salin hanya manifest dulu agar layer install ter-cache bila source berubah.
COPY pnpm-workspace.yaml pnpm-lock.yaml ./
COPY web/package.json web/
COPY packages/types/package.json packages/types/
COPY packages/ui/package.json packages/ui/
RUN pnpm install --frozen-lockfile
# Baru salin source lalu build. Output: web/dist.
COPY web/ web/
COPY packages/ packages/
RUN pnpm --filter web run build

# ---- Stage 2: build server Go ----
FROM golang:1.26-bookworm AS server-build
WORKDIR /build/server
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
# Dist frontend harus ada di server/web/dist saat runtime (main.go serve
# dari ../server/web/dist). web-build sudah menghasilkan web/dist.
COPY --from=web-build /build/web/dist ./web/dist
RUN CGO_ENABLED=1 go build -trimpath -o /build/webbuilder .

# ---- Stage final: runtime gabungan ----
FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates sqlite3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY --from=server-build /build/webbuilder ./webbuilder
COPY --from=web-build /build/web/dist ./web/dist
# Data SQLite tinggal di /app/data (main.go: ../data dari /app/server).
# Pasang sebagai volume supaya database tidak hilang saat container diganti.
RUN mkdir -p /app/data
VOLUME ["/app/data"]
# JWT_SECRET wajib: server menolak start tanpanya (main.go).
# Jangan pernah menulis nilai secret di Dockerfile / compose.
ENV JWT_SECRET=""
EXPOSE 18082
# Lihat catatan bind address di atas: pakai --network host saat run.
ENTRYPOINT ["./webbuilder"]

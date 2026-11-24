# VibeBuilder

App builder otonom: prompt → agent LLM dengan file tools → tulis app nyata → build → preview live.

## Stack
- **Template** — TanStack Start + React 19 + TypeScript + Tailwind v4 + Vite 8
- **Server** — Hono + `srvx`, SQLite (`node:sqlite`), SSE streaming
- **Platform UI** — React 19 + Vite 8 + Tailwind v4 (3 pane: proyek | chat | kode/preview)

## Jalankan
```bash
cd server && PORT=3000 node src/index.ts     # API + UI di http://127.0.0.1:3000
cd platform && npm run build                 # rebuild UI
```

## Endpoint
| Method | Path | Fungsi |
|---|---|---|
| GET | `/api/health` | status + preview aktif |
| GET/POST | `/api/projects` | list / buat proyek |
| GET | `/api/projects/:id` | proyek + messages + files + port |
| POST | `/api/projects/:id/chat` | SSE agent run |
| GET | `/api/projects/:id/files` | daftar file |
| POST | `/api/projects/:id/install` | npm install |
| POST | `/api/projects/:id/build` | vite build |
| POST | `/api/projects/:id/preview` | start preview |
| POST | `/api/projects/:id/publish` | build + preview + kunci slug (`{slug?}`) |
| DELETE | `/api/projects/:id/publish` | tarik publikasi |
| GET | `/p/:slug` | 302 ke aplikasi terbit (publik) |

## Akun

`POST /api/auth/signup` `{email,name,password}` · `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/me`.

Password disimpan sebagai scrypt (N=16384, r=8, p=1, salt 16 byte). Sesi = token 32 byte acak, yang disimpan hanya SHA-256-nya, umur 30 hari, cookie `vb_session` HttpOnly/SameSite=Lax. Semua route `/api/projects*` wajib sesi dan otomatis di-scope ke pemilik; proyek milik akun lain dijawab 404, bukan 403, supaya keberadaannya tidak bocor. `/p/:slug` tetap publik.
| GET | `/api/projects/:id/preview/status` | cek preview |

## Catatan teknis
- `template/server.mjs` menyajikan `dist/client/*` sebagai static lalu fallback ke SSR handler — tanpa ini aset preview 404 dan app tidak hydrate.
- `buildProject()` menjalankan `reconcileAssets()`: TanStack Start memberi hash CSS berbeda untuk graf client dan SSR, jadi referensi `/assets/styles-*.css` yang menggantung dipetakan ulang ke file yang benar-benar ada.
- Port preview dialokasikan deterministik per project id dengan probing slot bebas (`4100–4111`, `MAX_PREVIEWS=12`).

## Domain publik

- Platform: https://vibe.clipku.com — `A vibe` + `A *.vibe` di zona clipku.com (DNS-only, ttl 1) → 43.133.138.219.
- Aplikasi terbitan: `https://<slug>.vibe.clipku.com` — app memilih proyek dari Host (`buildHostSubdomain`), lalu meneruskan request verbatim ke port preview.
- TLS: sertifikat wildcard Let's Encrypt via DNS-01 (`certbot-dns-cloudflare`, `/root/.secrets/cloudflare.ini`), renew otomatis; HTTP di-redirect 301 ke HTTPS.
- Jalan: nginx VPS `sites-available/vibe.clipku.com` → `127.0.0.1:18090` → reverse SSH tunnel ke `127.0.0.1:3000`.
- Supervisor: `~/workspace/bin/vb-supervise.sh` (cek port 3000 + proses tunnel tiap 15 s, restart yang mati).

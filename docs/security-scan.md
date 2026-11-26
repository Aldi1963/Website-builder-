# Security Scan Sebelum Publish (Trek 3)

Sebelum proyek dipublish, server menjalankan pemindaian keamanan atas kode
hasil generate + policy database proyek. Hasilnya tampil sebagai laporan
(lolos/gagal + daftar temuan) di respons publish dan bisa dibaca ulang
lewat `GET /api/projects/:id/security-scan` — laporan terakhir tersimpan
di kolom `projects.security_scan` (JSON mentah, pola yang sama dengan
`chat_messages.verification`).

## Keputusan gating

| Temuan | Akibat |
| --- | --- |
| **Kritis** (secret bocor, SQL injection, policy berbahaya) | **Publish DIBLOKIR** — HTTP 409 `status: "blocked"` + laporan lengkap. Fail-closed: perbaiki dulu, lalu publish ulang. |
| High / medium / low | **Peringatan tegas, publish tetap jalan** — respons 200 membawa `securityWarning` + laporan `securityScan` lengkap. |

Keputusan ini disengaja: memblokir semua temuan akan membuat publish
hampir tidak pernah lolos (mis. `dangerouslySetInnerHTML` yang sah tapi
belum terbukti tersanitasi), sementara membiarkan kritis lolos akan
mempublikasikan secret dan celah injeksi. Bila bukti di lapangan
menunjukkan ambang ini salah, ubah di `scanProject`/`publishProject`
(`server/internal/handler/`), bukan di scanner.

## Yang dipindai

Paket `server/internal/securityscan/` (pola statis/regex, tanpa
menjalankan kode):

1. **Secret yang bocor di kode** (kritis): AWS key, Stripe live key,
   key `sk-…`, token GitHub/Slack, Google API key, private key,
   JWT literal, Bearer token literal, dan penugasan
   `apiKey/password/secret = "nilai"` (bukan referensi env).
   Pengecualian yang disengaja: placeholder (`YOUR_API_KEY`,
   `changeme`, `xxx`, `example`, …), nilai dari interpolasi
   (`${…}`), dan referensi env (`process.env.X`,
   `import.meta.env.VITE_X`) **tidak** ditandai.
2. **SQL injection** (kritis): SQL di template literal berisi `${…}`,
   `cloudDb.query(...)` / `.raw(...)` / `.execute(...)` dengan
   konkatenasi `+`, dan string SQL yang digabung `+` (termasuk
   klausa `WHERE … + variabel`). Query berparameter
   (`cloudDb.query("… WHERE id = $1", [id])`) **lolos**.
3. **XSS** (high/medium): `dangerouslySetInnerHTML`, `innerHTML =`
   nilai non-literal, `document.write(`, `v-html`, `outerHTML`.
4. **Code injection** (high): `eval(`, `new Function(`.
5. **Auth salah konfigurasi** (kritis/high): secret JWT literal di
   `jwt.sign(...)`, `skipAuth/bypassAuth = true`,
   `isAuthenticated = true` literal, CORS `Allow-Origin: *`.
6. **Policy database proyek** (kritis/high): dibaca dari
   `app_<id>.app_policies` (Postgres app). Yang ditandai:
   - role `member`/`viewer` boleh `select` tabel sensitif
     (`app_users`, `app_sessions`, `app_policies`) — kritis
     (password hash / token sesi bocor);
   - role `member`/`viewer` boleh operasi `query` (endpoint SQL
     mentah) — kritis;
   - role `member`/`viewer` boleh `delete`, `viewer` boleh
     `insert`/`update` — high.
   Tidak adanya baris policy **bukan** temuan: default platform
   adalah deny-by-default (`requireAppOperation`). Bila tabel
   `app_policies` belum ada (proyek belum pernah memakai database
   app), laporan mencatat itu sebagai "tidak ada policy eksplisit"
   — bukan sebagai error, dan bukan sebagai aman yang diperiksa.

Yang TIDAK dipindai: `dist/`, `node_modules/`, `package-lock.json`,
file `*.lock`/`*.map` (hasil build hanya mengulang isi `src/`).
Pola di dalam komentar baris (`//`, `#`) tidak ditandai.

## Batasan — baca sebelum percaya laporan

Scanner ini **pola statis**. Ia tidak menjalankan kode, tidak
menelusuri alur data (taint-flow), dan tidak menguji aplikasi yang
sudah berjalan. Konsekuensinya, jujur:

- **"Tidak ada temuan" ≠ "aman".** Artinya hanya: tidak ada pola yang
  dikenali. Secret yang dipecah jadi beberapa potongan string, injeksi
  lewat jalur tidak langsung, dan celah logika bisnis tidak terdeteksi.
- Scanner tidak bisa membuktikan sanitasi: `dangerouslySetInnerHTML`
  selalu ditandai high walau isinya sudah disanitasi — periksa manual.
- Policy hanya diperiksa bila database app (Postgres 5434) bisa
  dijangkau saat scan. Bila tidak, laporan mencatat
  `policyChecked: false` + alasan, dan publish **tidak** diblokir
  oleh policy — kekurangan ini terlihat di laporan, bukan disembunyikan.
- Laporan selalu membawa teks `limitations` yang sama dengan paragraf
  di atas, supaya hasil tidak pernah dibaca sebagai jaminan keamanan.

## Endpoint

| Method | Jalur | Peran | Keterangan |
| --- | --- | --- | --- |
| `POST` | `/api/projects/:id/publish` | owner | Menjalankan scan dulu; kritis → 409 + `securityScan`; lolos → 200 + `securityScan` (+ `securityWarning` bila ada temuan non-kritis). |
| `POST` | `/api/projects/:id/security-scan` | editor | Jalankan scan sekarang tanpa publish; menyimpan + mengembalikan laporan. |
| `GET` | `/api/projects/:id/security-scan` | viewer | Laporan terakhir yang tersimpan; 404 bila belum pernah dipindai. |

Di Builder, tombol **Scan** (di samping Publish, owner saja)
menjalankan scan on-demand dan menampilkan laporannya; saat publish
gagal karena scan, laporan tersimpan ikut ditampilkan supaya user
melihat daftar temuannya.

## Uji

```bash
cd server
go test ./internal/securityscan/ -v -count=1   # aturan + false positive
go test ./internal/handler/ -run 'TestPublish|TestSecurityScan' -v -count=1
```

Kasus yang dikunci test: proyek bersih lolos; secret palsu +
pola query tidak aman memblokir publish (409 + laporan tersimpan);
temuan high saja hanya jadi peringatan (200 + `securityWarning`);
placeholder, referensi env, query berparameter, dan pola di komentar
tidak ditandai; policy sensitif untuk viewer = kritis; tanpa baris
policy = tidak ada temuan (deny-by-default).

# Isolasi Runtime (Trek C — Item 5)

Eksekusi kode hasil generate (tenant) adalah permukaan serangan terbesar
WebBuilder: kode yang ditulis AI berjalan di host yang sama dengan server.
Dokumen ini menjelaskan fondasi isolasi yang disediakan paket
`server/internal/runtime/` — dan apa yang **belum** diisolasi.

## Prinsip: mati secara default

Eksekusi tenant **MATI secara default**. Menyalakannya butuh flag env
eksplisit:

```bash
WEBBUILDER_ENABLE_TENANT_EXEC=1
```

Hanya nilai persis `"1"` yang menyalakan. Nilai lain (`"true"`, `"yes"`,
`"on"`, `"01"`) **tidak** menyalakan. Tanpa flag, setiap `Executor.Run`
mengembalikan `ErrTenantExecDisabled` — fail-closed, tidak ada jalan
memutar lewat paket ini.

Flag opsional (hanya dibaca bila eksekusi sudah nyala):

| Env | Default | Keterangan |
| --- | ------- | ---------- |
| `WEBBUILDER_TENANT_EXEC_TIMEOUT_SECONDS` | `60` | Timeout default per eksekusi (detik) |
| `WEBBUILDER_TENANT_EXEC_MAX_OUTPUT_BYTES` | `1048576` (1 MiB) | Batas total byte stdout+stderr yang disimpan |

## Alat browser agent (chrome-devtools-mcp, Fase 1)

Alat browser agent (`server/internal/browser/`) menggerakkan hasil
eksekusi tenant di Chrome headless sungguhan — jadi gating-nya berlapis:
alat browser HANYA aktif bila **kedua** flag nyala:

```bash
WEBBUILDER_ENABLE_BROWSER_TOOLS=1
WEBBUILDER_ENABLE_TENANT_EXEC=1
```

Hanya nilai persis `"1"` yang menyalakan tiap flag. Bila salah satu mati,
katalog agent tidak berisi alat `browser_*` sama sekali dan panggilan
`browser_*` ditolak dengan error jelas.

Satu klien MCP + satu Chrome per agent run (dibuat saat pipeline mulai —
model harus tahu alatnya ada sebelum memanggilnya — ditutup `defer` saat
run selesai, termasuk saat run dibatalkan). Profil Chrome per run di bawah
`runtime/project-<id>/run-<id>/browser/chrome-profile/`, dihapus saat
tutup; tidak ada proses Chrome/MCP yatim.

Batas Fase 1 (lihat `docs/mcp-browser-integration-plan.md` §4):

| Env / batas | Default | Keterangan |
| --- | ------- | ---------- |
| `CHROME_DEVTOOLS_MCP_CMD` | `npx -y chrome-devtools-mcp@1.13.0` | Command server MCP (versi di-pin, bukan `@latest`) |
| `CHROME_FOR_TESTING_PATH` | kosong (auto-detect) | Path biner Chrome for Testing |
| Timeout per panggilan tool | 30 dtk | Mengikuti deadline ctx pemanggil |
| Cap hasil tool | 64 KiB | Kelebihan dipotong + marker |
| URL yang boleh dibuka | — | Hanya `http(s)://127.0.0.1/*` dan `http(s)://localhost/*` (origin preview proyek sendiri); URL luar ditolak di lapis klien |

Fail-closed: bila flag nyala tapi Chrome/MCP tidak tersedia (mis.
`CHROME_FOR_TESTING_PATH` menunjuk path tak ada, atau server MCP gagal
start), pipeline mencatat error jelas di log dan agent berjalan TANPA alat
browser — bukan diam-diam. Alat yang aktif di Fase 1 hanya
`browser_list_console_messages`; alat allowlist lain (§5 rencana) belum
diekspos sampai Fase 2.

## Interface Executor

```go
type Executor interface {
    Name() string
    Available() bool
    Run(ctx context.Context, cmd Command) (Result, error)
}
```

`Command` membawa `Name`, `Args`, `Dir` (working directory), `Env`
tambahan, dan `Timeout`. `Result` membawa `ExitCode`, `Stdout`, `Stderr`,
`Truncated`, `TimedOut`, dan `Duration`. Semua implementasi wajib
fail-closed terhadap flag di atas.

`runtime.DefaultExecutor(cfg)` memilih Docker bila daemon benar-benar ada,
kalau tidak `ProcessExecutor`. Pemilihan ini **tidak** melewati flag.

## Implementasi 1: ProcessExecutor (proses OS terisolasi)

Implementasi default, selalu tersedia. Jaminan yang diberikan:

- **Timeout via context** — `context.WithTimeout` + `exec.CommandContext`.
  Saat timeout, seluruh **grup proses** dibunuh (`Setpgid` + `SIGKILL` ke
  `-pid`), jadi cucu yang di-spawn shell/npm/vite ikut mati, bukan hanya
  proses langsung. `Result.TimedOut = true`.
- **Environment di-scrub** — proses anak TIDAK PERNAH mewarisi
  `os.Environ()`. Env dibangun dari nol dari allowlist minimal (`PATH`,
  `HOME`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`, `TMPDIR`, `TERM`, `CI`,
  `NODE_ENV`, dan beberapa `npm_config_*`). Variabel tambahan dari caller
  hanya lolos bila ada di allowlist atau cocok pola `VITE_[A-Z0-9_]+`
  (variabel Vite yang memang dirancang publik/di-embed ke bundle klien).
  Lapis defensif kedua: kunci apa pun yang cocok pola
  `SECRET|TOKEN|PASSWORD|JWT|API_KEY|AUTH|CREDENTIAL|...` **tidak pernah**
  diteruskan. Secret server (`JWT_SECRET`, AI key, DB password) tidak bisa
  bocor lewat sini.
- **Working directory terpisah** — `Dir` wajib berada di bawah
  `Config.BaseDir` (default `../runtime/sandbox`); traversal `..` dan
  escape lewat symlink ditolak. `Dir` kosong berarti dibuatkan direktori
  sementara baru di bawah `BaseDir` dan dihapus setelah selesai.
- **Capture output berbatas** — stdout dan stderr masing-masing dibatasi
  `MaxOutputBytes` (default 1 MiB); kelebihan dipotong dan `Truncated=true`.

Contoh pemakaian (dari handler, setelah flag dinyalakan):

```go
ex := runtime.DefaultExecutor(runtime.DefaultConfig().WithEnvOverrides())
res, err := ex.Run(ctx, runtime.Command{
    Name: "npm", Args: []string{"run", "build"},
    Dir: dir, Timeout: 3 * time.Minute,
})
```

## Implementasi 2: DockerExecutor (Docker/OCI)

Adapter kedua, sudah ditulis (`server/internal/runtime/docker.go`), dengan
hardening saat container dijalankan: `--network=none`, `--read-only`,
`--tmpfs /tmp`, `--memory=512m`, `--cpus=1.0`, `--pids-limit=128`,
`--user=65534:65534` (nobody), workdir di-mount dari `BaseDir`, dan env
yang di-scrub sama seperti `ProcessExecutor`.

### Status di VM ini: TIDAK TERSEDIA (jujur, bukan pura-pura)

Per 2026-11-15: binary `docker` tidak ada di VM (`docker: command not found`)
dan tidak ada daemon. Karena itu:

- `DockerExecutor.Available()` mengembalikan `false`.
- `DockerExecutor.Run()` mengembalikan `ErrDockerUnavailable` yang jelas.
- `DefaultExecutor` jatuh kembali ke `ProcessExecutor`.

### Syarat mengaktifkan DockerExecutor di host

1. Docker Engine / daemon berjalan dan user server ada di grup `docker`
   (atau `DOCKER_HOST` menunjuk daemon remote yang sudah diautentikasi).
2. Image sudah di-pull sebelumnya (default `node:20-alpine`) — container
   tidak boleh menarik image arbitrer dari registry saat eksekusi tenant.
3. Flag `WEBBUILDER_ENABLE_TENANT_EXEC=1` tetap wajib.
4. Daemon sebaiknya dikonfigurasi user namespace remapping atau rootless
   mode untuk isolasi UID yang sesungguhnya; adapter sudah memaksa
   `--user 65534:65534` sebagai pertahanan.
5. Verifikasi setelah instalasi: `docker info` berhasil, lalu jalankan
   `go test ./internal/runtime/ -run TestDockerExecutor -v` — test
   `TestDockerExecutorUnavailableWithoutDaemon` akan skip sendiri bila
   docker tersedia, dan perlu ditambah test integrasi `docker run` nyata
   (belum ada, karena belum bisa dijalankan di VM ini).

## Migrasi runtime preview (2026-11-15)

Runtime preview lama (`server/internal/handler/runtime.go`) kini memakai
paket ini untuk eksekusi tenant **satu-shot** — `runtimeRun` (dipakai
`runtimeInstall`, `runtimeBuild`, `runtimePipeline`, `runtimeVerify`, dan
bootstrap install di `runtimeDevStart`) serta tool agent `run_build`
(`server/internal/handler/agent.go`).

### Perilaku berdasarkan flag

| Flag `WEBBUILDER_ENABLE_TENANT_EXEC` | Perilaku |
| --- | --- |
| mati (default, nilai apa pun selain `"1"`) | Jalur lama persis seperti sebelum migrasi: `exec.CommandContext` dengan `os.Environ()` penuh + `CI=1` + `npm_config_*`, output `CombinedOutput` tanpa batas. Tidak ada perubahan hasil. |
| `1` | Perintah lewat adapter (`runtime.DefaultExecutor`: Docker bila daemon ada, kalau tidak `ProcessExecutor`). Env di-scrub (allowlist + proxy tanpa kredensial, lihat bawah), output tiap stream dibatasi 1 MiB, timeout diambil dari deadline ctx pemanggil (install 4 mnt, build 3 mnt, pipeline/verify 7 mnt, `run_build` 5 mnt). |

### Perbedaan hasil yang sengaja (flag nyala)

- Output = stdout + stderr digabung (jalur lama: `CombinedOutput`
  ter-interleave). Isi sama, urutan antar-stream bisa berbeda — diagnostik
  (pencocokan substring, mis. `vite: not found`) dan tampilan tidak
  terpengaruh.
- Error non-nol membawa pesan `command "npm" keluar dengan status N: ...`
  (jalur lama: `exit status N`). Pemanggil hanya memeriksa `err != nil`
  dan menampilkan pesannya.
- `BaseDir` adapter adalah `../runtime` (induk dari
  `../runtime/project-<id>`); working directory di luar itu ditolak.

### Variabel proxy (kenapa ada di scrub)

`npm`/`pnpm`/`pip` butuh proxy untuk mencapai registry di host yang
egress-nya lewat proxy (di VM ini akses langsung ke registry diblokir).
Karena itu `scrubEnv` meneruskan `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`
(+ huruf kecil) — TETAPI URL proxy diteruskan **tanpa userinfo**
(kredensial dibuang). Di VM ini proxy tidak menuntut auth dari IP host
(terverifikasi 2026-11-15: `curl` lewat proxy tanpa userinfo tetap 200),
jadi install tetap jalan tanpa membocorkan kredensial proxy ke kode tenant.
`NO_PROXY` diteruskan apa adanya (isinya hanya daftar host). Bila URL proxy
tidak bisa di-parse, variabelnya dibuang (fail-closed).

Dua jebakan yang ditemukan saat verifikasi (2026-11-15) — keduanya membuat
`npm install` cache-dingin menggantung sampai timeout, BUKAN gagal cepat:

1. **npm TIDAK membaca `HTTP_PROXY`.** Ia membaca konfigurasinya sendiri
   (`npm_config_proxy` / `npm_config_https_proxy` / `npm_config_noproxy`),
   jadi nilai proxy yang sudah di-strip juga ditulis ke ketiga variabel
   itu. Tanpa ini, `npm config list` menunjukkan `proxy = null` dan npm
   mencoba koneksi langsung yang diblokir sandbox.
2. **Proxy egress me-MITM TLS dengan CA sendiri, dan Node tidak memakai
   system CA store.** Tanpa `NODE_EXTRA_CA_CERTS`, Node/npm tidak bisa
   memverifikasi sertifikat proxy — `npm view` timeout 60 dtk (retry TLS
   gagal), dan dengan variabel ini selesai 3,7 dtk. Karena itu scrub juga
   meneruskan `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`,
   dan `CURL_CA_BUNDLE` — semuanya berupa *path* ke bundle CA, bukan
   secret, jadi aman diteruskan. (Bukti akhir: `npm install` cache-dingin
   lewat env yang di-scrub selesai 36 dtk + `vite build` 247 ms.)

### Yang sengaja TIDAK dimigrasi

- **Dev server** (`runtimeDevStart`/`runtimeDevStop`): proses long-running
  dengan restart otomatis saat crash + log di-stream ke `runtime-dev.log`.
  Adapter saat ini one-shot (`Run`) dan tidak punya `Start`/`Stop`.
  **Konsekuensi jujur: dengan flag nyala pun, proses dev server tetap
  berjalan dengan `os.Environ()` penuh (termasuk secret) — isolasi penuh
  BELUM tercapai.** Tindak lanjut: tambah kemampuan supervised-process
  (`Start`/`Stop`) ke paket runtime, lalu pindahkan dev server ke sana.
  (Install bootstrap di `runtimeDevStart` SUDAH lewat adapter bila flag
  nyala; hanya proses dev-nya yang masih jalur lama.)
- **Screenshot** (`runtimeCaptureScreenshot`) dan **browserAcceptance**:
  menjalankan skrip milik server (playwright-core), bukan kode tenant —
  tidak ada manfaat keamanan dari migrasi, dan path Chromium/playwright
  di dalamnya hardcode per host dan sudah rapuh di VM ini (lihat catatan
  PR #10: playwright-core di `/opt/webbuilder/...` tidak ada,
  Chromium di-hardcode ke `/root/.cache/...`).
- `customdomain.go` (ssh infra) dan `payment.go` (binary clipkupay):
  bukan kode tenant.

## Apa yang BELUM diisolasi (jujur)

- `ProcessExecutor` **bukan sandbox kernel**: tidak ada namespace, cgroup,
  atau seccomp. Proses anak masih berbagi kernel dan UID dengan server.
  Ia membatasi permukaan yang paling gampang dieksploitasi (secret bocor,
  proses menggantung, output membanjiri memori, akses file di luar
  workspace) — untuk isolasi yang lebih kuat, pakai `DockerExecutor` bila
  daemon tersedia, atau tambahkan gVisor/Firecracker sebagai adapter
  ketiga nanti.
- **Dev server** masih jalur lama (lihat atas) — ini permukaan tenant yang
  belum terisolasi. Screenshot/browserAcceptance sengaja tidak dimigrasi
  (skrip server, bukan kode tenant).
- Tidak ada batas CPU/memori pada `ProcessExecutor` (tidak ada cgroup);
  batas yang ada baru timeout dan batas output.

## Verifikasi

```bash
cd server
go test ./internal/runtime/ -v -count=1
```

Test mencakup: (a) eksekusi MATI tanpa flag; (b) hanya `"1"` yang
menyalakan; (c) timeout benar-benar membunuh proses **dan** grup prosesnya
(`sleep 30` dengan timeout 300ms selesai < 5 dtk); (d) secret dummy
(`JWT_SECRET`, `OPENAI_API_KEY`, `DB_PASSWORD`) tidak muncul di output
`env` proses anak; (e) variabel non-allowlist dibuang, `VITE_*` lolos;
(f) output 100 KB dengan batas 1 KB dipotong + `Truncated=true`;
(g) working directory di luar `BaseDir` ditolak; (h) Docker dilaporkan
tidak tersedia secara jujur di VM ini.

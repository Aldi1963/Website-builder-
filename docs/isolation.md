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

## Apa yang BELUM diisolasi (jujur)

- `ProcessExecutor` **bukan sandbox kernel**: tidak ada namespace, cgroup,
  atau seccomp. Proses anak masih berbagi kernel dan UID dengan server.
  Ia membatasi permukaan yang paling gampang dieksploitasi (secret bocor,
  proses menggantung, output membanjiri memori, akses file di luar
  workspace) — untuk isolasi yang lebih kuat, pakai `DockerExecutor` bila
  daemon tersedia, atau tambahkan gVisor/Firecracker sebagai adapter
  ketiga nanti.
- **Runtime dev/preview yang sudah ada** (`server/internal/handler/runtime.go`:
  `npm install`/`build`/dev server/`runtimeRun`) **TIDAK diubah dan TIDAK
  memakai paket ini** pada trek ini. Ia masih menjalankan perintah dengan
  `os.Environ()` penuh dan tanpa batas output. Memigrasikannya ke paket ini
  adalah pekerjaan lanjutan yang butuh keputusan koordinator, karena
  mengubah perilaku preview yang sedang live.
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

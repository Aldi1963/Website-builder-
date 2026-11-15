# Visual editor klik-elemen

Klik teks/gambar di preview → ubah langsung di panel → perubahan tersimpan
ke file sumber proyek (bukan hanya state sementara), lalu proyek tetap
bisa di-build dan lolos loop verifikasi MCP.

## Cara kerja

1. **Mode Pilih.** Tombol "Pilih" di toolbar preview mengaktifkan mode
   pilih. Di mode ini klik elemen di preview tidak menjalankan aksi
   aplikasi, melainkan mengirim deskripsi elemen ke Builder.
2. **Bridge preview.** Skrip bridge kecil disuntikkan ke preview:
   - Preview Sandpack: skrip sudah ada di template `/public/index.html`
     di `web/src/pages/Builder.tsx`.
   - Preview Live Runtime: skrip yang sama disuntikkan server-side oleh
     reverse proxy (`runtimeDevPreview`, lihat
     `server/internal/handler/visualeditor.go` + `injectPreviewBridge`).
     Bridge TIDAK ditulis ke file proyek dan TIDAK ikut ke build
     production. Bridge mulai dalam keadaan mati dan dihidupkan parent
     lewat `postMessage {type:"wb-set-select", enabled}`.
   - Bridge juga meneruskan console error ke parent (`wb-error`) —
     di preview Live Runtime ini perilaku baru (sebelumnya error console
     live preview tidak sampai ke loop self-test/auto-fix).
   - Proxy TIDAK meneruskan `?token=` ke Vite
     (`stripPreviewTokenQuery` di `runtime.go`): token preview hanya
     untuk auth middleware WebBuilder, dan nilai JWT yang mengandung
     `.` merusak deteksi ekstensi Vite untuk modul `.tsx` (transform
     gagal "JSX syntax is disabled"). Ditemukan saat uji E2E — modul
     yang diminta lewat proxy dengan `?token=` mengembalikan 500,
     sementara tanpa query (jalur normal preview) selalu 200.
   - Pesan klik (`wb-select`) berisi: tag, id, class, teks render
     (`innerText`, maks 120 karakter), `src` gambar (nilai atribut
     mentah — yang sama dengan yang tertulis di sumber), `alt`, plus
     gaya terhitung (`color`, `fontSize`, `backgroundColor`).
3. **Panel Edit Elemen.** Pesan `wb-select` membuka modal "Edit Elemen"
   (sebelumnya modal ini dead code — tidak pernah dibuka; handler lama
   hanya mengisi input chat). Panel berisi:
   - Edit langsung: textarea teks (atau input URL gambar + upload),
     kontrol gaya dasar (warna teks, ukuran font, warna latar).
   - Bila teks yang sama muncul di beberapa tempat: pemilih kemunculan
     (file:baris + konteks).
   - Fallback AI: aksi cepat + instruksi bebas (perilaku lama) tetap ada
     di bawah, untuk perubahan yang tidak bisa dilakukan langsung.
4. **Simpan.** Semua edit diterapkan ke map file lalu disimpan lewat
   jalur yang sudah ada — `saveFiles()` → `PUT /api/projects/:id`
   (`updateProject`, auto-version "Edit manual"). Tidak ada jalur tulis
   file kedua. Preview dimuat ulang otomatis oleh efek `files` yang
   sudah ada (debounce + `runtime/dev/sync` untuk Live Runtime).

## Keputusan desain: pemetaan DOM → file sumber

Ini bagian tersulit. Elemen DOM hasil render React **tidak membawa
jejak file sumber** (tidak ada "teks ini dari baris X file Y").

**Pendekatan yang dipilih: pencocokan literal**
(`web/src/lib/visualEditor.ts` — fungsi murni, diuji vitest).

Teks yang dirender (atau `src` gambar) dicari apa adanya di file sumber
proyek (`.tsx/.ts/.jsx/.js/.html`, plus `.css` untuk `src`). Kode hasil
AI hampir selalu me-render heading/label sebagai teks JSX atau string
literal, sehingga pencocokan ini menutup kasus umum.

- Edit teks: kemunculan yang dipilih diganti (splice berdasarkan offset,
  bukan replace global) dengan escaping sesuai konteks sumbernya
  (teks JSX: `& < > { }`; string literal: quote/backslash; atribut:
  quote). Satu pass per karakter — replace berantai sempat merusak
  hasil karena `{"{"}` yang disisipkan mengandung `}`.
- **Teks terpecah (baru):** bila literal utuh tidak ditemukan, teks
  render dicocokkan ke sekumpulan node teks di dalam SATU elemen yang
  diklik (`findSplitTextOccurrences`): teks JSX bebas, string
  expression `{"..."}`, dan elemen inline (`<br/>`, `<em>`,
  `<strong>`, `<span>`, `<b>`, `<i>`, `<u>`, `<s>`, `<small>`,
  `<mark>`, `<code>`, `<a>`, `<sub>`, `<sup>`, dan sejenisnya,
  rekursif). Whitespace dinormalisasi di kedua sisi, jadi `innerText`
  `"Kopi\nNikmat."` cocok dengan sumber `<h1>Kopi<br/><em>Nikmat.</em></h1>`,
  dan entity HTML (`&amp;`) di-decode saat membandingkan. Edit
  (`applySplitTextEdit`) MEMBAGI kata-kata teks baru ke segmen-segmen
  aslinya mengikuti jumlah kata tiap segmen (kata sisa masuk ke segmen
  terakhir) — markup dipertahankan: `<em>` tetap `<em>`, `<br/>` tetap
  ada. Segmen yang kehabisan kata dikosongkan (pembungkus inline-nya
  dibiarkan kosong, bukan dihapus). Edit gaya juga bisa: target
  `style` diambil dari tag pembuka elemen (`splitStyleTarget`). Panel
  menampilkan catatan biru saat kemunculan yang dipakai adalah
  split-text, dan peringatan "tidak ada kemunculan di dalam tag"
  tidak lagi muncul untuk kasus ini.
- Urutan default kemunculan: yang barisnya memuat tag elemen yang
  diklik (`<h1`, `<a`, …) didahulukan (`rankOccurrences`).
  Kemunculan di `<title>`/`<meta>` dibuang (`excludeHeadOccurrences`):
  tidak dirender sehingga tidak mungkin diklik — tanpa filter ini,
  klik `<h1>` pada uji E2E sempat mengubah `<title>` (perilaku lama
  yang salah, sudah diperbaiki).
- Bila tak satu pun kemunculan berada di dalam tag yang diklik, panel
  menampilkan peringatan (teks kemungkinan terpecah di sumber) alih-alih
  pilihan default yang salah (`hasTagOccurrence`).
- Edit gambar: `src` diganti dengan literal yang sama. Upload memakai
  endpoint yang sudah ada `POST /api/projects/:id/app/files` dan
  menghasilkan URL `/app-files/<pid>/<nama>` (rute publik, tanpa auth).
- Edit gaya: bila teks adalah anak langsung sebuah elemen JSX, tag
  pembukanya dicari mundur dari kemunculan teks dan diberi/digabung
  `style={{...}}` inline (patch menang atas properti lama). Offset tag
  berada sebelum teks, jadi edit teks + edit gaya bisa diterapkan
  berurutan dengan aman.

**Pendekatan yang dipertimbangkan dan ditolak**

- *Atribut data disuntikkan saat dev/preview* (`data-wb-file`,
  `data-wb-line`): butuh plugin Vite/Babel transform di proyek hasil
  generate — invasif (mengubah config build pengguna), hanya menutup
  preview Live Runtime (Sandpack mengompilasi di browser tanpa plugin
  itu), dan tetap butuh parser sumber untuk menulis balik. Ditolak
  untuk trek ini; bisa dipertimbangkan bila pencocokan literal terbukti
  kurang di pemakaian nyata.
- *Source map React DevTools-style*: terlalu kompleks untuk trek ini.

## Batasan yang diketahui (jujur)

1. Teks terpecah oleh elemen inline di dalam SATU elemen yang diklik
   (`<br/>`, `<em>`, `<strong>`, `<span>`, …) SUDAH bisa diedit
   (lihat atas). Yang masih TIDAK bisa:
   - teks yang dipecah oleh **expression/variabel** (`{nama}`,
     `{"Halo " + nama}`, template `` {`...${x}`} ``) — parser menolak
     karena nilainya tidak ada di sumber sebagai literal;
   - teks yang terpecah melewati **elemen blok** (mis. `<div>` di dalam
     heading) atau **fragment** (`<>…</>`) — parser berhenti di tag
     yang tidak dikenal;
   - teks yang dipecah melewati **dua elemen berbeda** (mis. separuh
     di `<h1>`, separuh di `<p>` berikut) — pencocokan hanya di dalam
     satu elemen yang diklik;
   - teks dari **array data / string literal di file lain yang digabung
     saat render** (mis. `items.map(...)`) — tetap tidak ditemukan.
   Semua kasus di atas: panel menampilkan pesan jelas dan mengarahkan
   ke aksi AI / edit kode. Tidak ada tebakan diam-diam.
2. Pembagian kata saat edit split-text mengikuti jumlah kata tiap
   segmen asal — jadi edit "Kopi Nikmat." → "Teh" mengosongkan
   `<em>` (`<h1>Teh<br/><em></em></h1>`, pembungkus kosong dibiarkan).
   Bila teks baru jauh lebih panjang/pendek dari aslinya, hasilnya
   tetap benar secara render tapi distribusi katanya mungkin bukan
   yang pemakai bayangkan — periksa hasil di preview, atau pakai aksi AI.
3. Teks dari string literal / array data bisa diedit teksnya, tapi
   TIDAK bisa diedit gayanya (tidak ada tag JSX pembungkus yang bisa
   diberi `style` inline).
4. Bila teks yang sama muncul berkali-kali, pemakai harus memilih
   kemunculan yang benar (file:baris + konteks ditampilkan). Pilihan
   default: kemunculan pertama.
5. Gambar hasil upload (`/app-files/…`) tampil di preview Live Runtime
   dan hasil publish, tapi TIDAK tampil di preview Sandpack (fallback)
   karena origin iframe-nya berbeda.
   - Catatan E2E 15 Nov 2026: di jaluran verifikasi browser MCP, gambar
     JUGA tampil rusak — browser verifikasi membuka server Vite dev
     langsung, dan di sana `/app-files/…` dijawab SPA-fallback HTML
     (HTTP 200 `text/html`), bukan PNG, sehingga `<img>` rusak meski
     tidak ada request yang gagal. Lewat origin API (yang dipakai
     iframe preview Live Runtime) URL yang sama mengembalikan
     `200 image/png` dengan benar. Jadi ini keterbatasan jalur
     verifikasi/preview langsung, bukan kegagalan upload — file
     tersimpan dan terbaca-balik dengan benar (lihat "Uji" di bawah).
6. Edit visual hanya untuk teks, gambar, dan tiga properti gaya dasar
   (warna teks, ukuran font, warna latar). Perubahan struktur/layout
   tetap lewat chat AI atau editor kode.
7. Bridge mengandalkan `window.parent.postMessage(..., "*")` — sama
   seperti bridge Sandpack yang sudah ada sebelumnya.

## Uji

- Unit: `web/src/lib/visualEditor.test.ts` (`pnpm test`) — 60 test
  (naik dari 46): pencocokan literal, penggantian per-offset,
  escaping, pemilih kemunculan, target gaya + gabung `style`, plus
  14 test baru teks terpecah (pemetaan `<br/>`/`<em>`/`<span>`/
  `<code>`/string expression/entity, pembagian kata saat edit,
  pengosongan segmen, penolakan expression/variabel, target gaya
  dari tag pembuka).
- Unit Go: `server/internal/handler/visualeditor_test.go`
  (`go test ./internal/handler/ -run TestInjectPreviewBridge`) —
  injeksi sebelum `</body>`, fallback tanpa `</body>`, idempotent,
  hanya untuk `text/html`.
- E2E (server uji port 18086, 15 Nov 2026, trek A — proyek uji id 1
  "Uji API 15 Nov", karena kuota proyek free user uji habis sehingga
  proyek baru tidak bisa dibuat):
  - Upload `hero.png` via `POST /api/projects/1/app/files` → 201,
    URL `/app-files/1/55d2828f14ea970b_hero.png`; baca-balik publik
    (tanpa auth) md5 identik dengan file yang diunggah; `GET
    /app/files` mencatat 1 item di DB.
  - Edit visual disimulasikan lewat fungsi `visualEditor.ts` yang
    SAMA dengan yang dipakai UI (klik `<h1>` dengan innerText
    `"Kopi\nNikmat."` → `findSplitTextOccurrences` 1 kemunculan →
    `applySplitTextEdit` jadi `"Teh Manis."`; klik `<img>` →
    `applyLiteralEdit` src ke URL upload) lalu simpan via `PUT
    /api/projects/:id` (jalur `saveFiles()` UI yang sama); baca-balik
    dari DB: `App.tsx` berisi `<h1>Teh<br/><em>Manis.</em></h1>` dan
    `src="/app-files/1/55d2828f14ea970b_hero.png"`, heading dan URL
    lama hilang.
  - Rebuild `POST /runtime/verify` → `status: success`, `phase:
    build`, exit 0 (`tsc -b && vite build`, 33 modul, 2,35 dtk).
  - Verifikasi MCP lewat chat kedua (run 15) → `verification.passed:
    true`, 0 console error, 0 request gagal, `status: completed`;
    screenshot verifikasi menampilkan heading "Teh / Manis." (miring
    dari `<em>` dipertahankan). Catatan jujur: di screenshot itu
    gambar hero tampil rusak (lihat batasan no. 5 di atas — jalur
    browser verifikasi membuka Vite dev langsung); file gambarnya
    sendiri terbukti tersimpan dan tersaji benar lewat origin API.
  - Kuota: chat verifikasi sempat 402 (token user uji 150.885/
    100.000); plan dinaikkan sementara ke pro untuk satu chat lalu
    dikembalikan ke free (pola terkontrol yang sudah didokumentasikan
    — plan sempat berayun pro/free karena trek lain memakai user uji
    yang sama secara bersamaan).

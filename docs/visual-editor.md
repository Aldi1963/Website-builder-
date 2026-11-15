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

1. Teks yang dirender dari gabungan expression (`{"Halo " + nama}`),
   dari array data yang dipecah, atau yang whitespace-nya berbeda dari
   sumber TIDAK ditemukan → panel menampilkan pesan jelas dan
   mengarahkan ke aksi AI / edit kode. Tidak ada tebakan diam-diam.
   Kasus nyata dari uji E2E: heading AI `<h1>Kopi<br /><em>Nikmat.</em></h1>`
   me-render "Kopi Nikmat." tapi literal itu tidak pernah muncul utuh
   di sumber — panel menampilkan peringatan "tidak ada kemunculan di
   dalam &lt;h1&gt;" dan tidak menawarkan pilihan default yang salah.
2. Teks dari string literal / array data bisa diedit teksnya, tapi
   TIDAK bisa diedit gayanya (tidak ada tag JSX pembungkus yang bisa
   diberi `style` inline).
2. Teks dari string literal / array data bisa diedit teksnya, tapi
   TIDAK bisa diedit gayanya (tidak ada tag JSX pembungkus yang bisa
   diberi `style` inline).
3. Bila teks yang sama muncul berkali-kali, pemakai harus memilih
   kemunculan yang benar (file:baris + konteks ditampilkan). Pilihan
   default: kemunculan pertama.
4. Gambar hasil upload (`/app-files/…`) tampil di preview Live Runtime
   dan hasil publish, tapi TIDAK tampil di preview Sandpack (fallback)
   karena origin iframe-nya berbeda.
5. Edit visual hanya untuk teks, gambar, dan tiga properti gaya dasar
   (warna teks, ukuran font, warna latar). Perubahan struktur/layout
   tetap lewat chat AI atau editor kode.
6. Bridge mengandalkan `window.parent.postMessage(..., "*")` — sama
   seperti bridge Sandpack yang sudah ada sebelumnya.

## Uji

- Unit: `web/src/lib/visualEditor.test.ts` (`pnpm test`) — 36 test:
  pencocokan literal, penggantian per-offset, escaping, pemilih
  kemunculan, target gaya + gabung `style`.
- Unit Go: `server/internal/handler/visualeditor_test.go`
  (`go test ./internal/handler/ -run TestInjectPreviewBridge`) —
  injeksi sebelum `</body>`, fallback tanpa `</body>`, idempotent,
  hanya untuk `text/html`.
- E2E (server uji port 18093, instans terpisah): buat proyek lewat chat
  LLM → klik-edit heading di preview (disimulasikan lewat fungsi
  `visualEditor` yang sama dengan yang dipakai UI, karena klik browser
  tidak bisa dijalankan dari subagent) → simpan via API → rebuild
  (`/runtime/verify`) → preview memuat teks baru + bridge tersuntik →
  loop verifikasi MCP lewat chat kedua.

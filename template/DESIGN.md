# DESIGN.md — Kontrak desain proyek

File ini adalah **sumber kebenaran visual** proyek. Agent membacanya setiap kali
bekerja dan memperbaruinya bila kamu meminta perubahan desain. Jangan menulis
desain di prompt chat saja — tulis di sini supaya konsisten antar percakapan.

## Identitas visual

- **Display font:** Fraunces (judul, angka besar). UI font: DM Sans. Keduanya sudah dimuat di `src/styles.css`.
- **Karakter:** tenang, editoral, berorientasi data. Bukan playful, bukan corporate-biru generik.
- **Palette:** netral hangat (`surface` / `ink` / `muted` / `edge`) + satu `accent`.
- **Radius:** kontrol 8px, panel 12px, area penuh tanpa radius. Jangan samakan semua.
- **Jarak:** skala 4 / 8 / 12 / 16 / 24 / 32.

## Aturan yang tidak bisa dinegosiasi

- Teks isi minimal 12px; metadata 11px. Kontras 4.5:1 di tema terang.
- Maksimal tiga warna inti + satu accent. Accent hanya untuk aksi utama & status aktif.
- Dilarang: gradien ungu-biru, glassmorphism, glow, blob blur, grid dekoratif, titik-titik hias.
- Setiap daftar kosong menjelaskan **kenapa kosong** dan **langkah berikutnya**.
- Loading menyebut apa yang dimuat; error menyebut penyebab + perbaikan.
- Angka penting rata kanan / tabular + satuan jelas.
- Mobile 360px: tidak ada scroll horizontal pada body. Target sentuh 44px.
- Bahasa UI mengikuti bahasa user (default: bahasa Indonesia).

## Component kit (pakai kelas ini, jangan Tailwind mentah berulang)

| Kebutuhan | Kelas |
|---|---|
| Konten halaman | `.container-page`, `.card`, `.card-pad` |
| Judul | `.section-title`, `.section-note`, `.font-display` |
| Tombol | `.btn`, `.btn-primary`, `.btn-ghost`, `.btn-danger` |
| Form | `.label`, `.input`, `.textarea`, `.select`, `.field-hint`, `.field-error`, `.checkbox` |
| Status | `.badge`, `.badge-accent`, `.badge-success`, `.badge-warning`, `.badge-danger` |
| Data | `.table-wrap`, `.table-data`, `.cell-null`, `.cell-number` |
| Empty/loading/error | `.empty-state`, `.loading-line`, `.loading-card`, `.notice`, `.notice-error`, `.notice-success` |
| Navigasi | `.nav-row`, `.nav-link`, `.nav-link-active`, `.tab-row`, `.tab`, `.tab-active` |
| Overlay | `.modal-backdrop`, `.modal-panel`, `.toast` |
| Responsif | `.stack-mobile`, `.mobile-list` |

## Cara mengubah desain

1. Ubah nilai token di `src/styles.css` bagian `@theme` (mis. `--color-accent`).
2. Perbarui bagian Identitas visual di atas.
3. Perbarui komponen yang memakai token — jangan menimpa file yang sudah dimodifikasi user.
4. Jalankan build, lalu lihat preview di dua lebar: desktop dan 360px.

## Riwayat keputusan

- Awal: token netral + Fraunces/DM Sans, component kit lengkap, tanpa gradient/glass.

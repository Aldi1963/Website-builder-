# Vendor: Template Metis (Bootstrap Admin Template)

Panel admin VibeBuilder memakai template ini **secara literal** — CSS hasil
build, font, ikon, dan gambar disajikan apa adanya dari template, tanpa
penulisan ulang gaya.

## Sumber

- Repo: https://github.com/puikinsh/Bootstrap-Admin-Template
- Lisensi: MIT (`template/LICENSE.md`)
- Versi: 3.7.2, commit `eb1bdb5` ("Merge pull request #113 from
  puikinsh/chore/deps-2026-11")
- Di-vendor: 25 November 2026, atas perintah eksplisit user (revisi total
  panel admin).

## Isi folder ini

- `template/` — salinan literal sumber template: `src-modern/` (halaman HTML,
  `scripts/`, `styles/scss/`), `public-assets/` (ikon/gambar), `package.json`,
  `vite.config.js`, `README.md`, `LICENSE.md`. Tidak ada yang diubah.
- `vendor/assets/` — hasil build template (`npm ci && npm run build` di
  clone template, `vite build`, outDir `dist-modern`):
  - `main-G_CDnMN9.css` — CSS hasil kompilasi SCSS template (Bootstrap 5.3.9
    + kustomisasi Metis + subset Bootstrap Icons + Inter Variable). Font
    (`inter-*.woff2`, `bootstrap-icons-*.woff2`) dan gambar (`images/`,
    `icons/`) ikut disalin apa adanya; URL relatif di CSS tetap valid karena
    semua file berada di satu direktori yang sama.
  - `bootstrap.bundle.min.js` — Bootstrap 5.3.9 (UMD) dari
    `node_modules/bootstrap/dist/js/` (dependensi yang sama dengan yang
    di-bundle template).
  - `alpine.min.js` — Alpine.js 3.17.5 (`node_modules/alpinejs/dist/cdn.min.js`).
  - `chart.umd.min.js` — Chart.js 4.6.1 (`node_modules/chart.js/dist/`).

## Yang sengaja TIDAK dipakai dari template

Entry JS template (`src-modern/scripts/main.js` + komponen per halaman)
tidak dimuat: ia berisi perilaku demo (hasil pencarian hardcode, penghitung
statistik yang bertambah sendiri, notifikasi demo, chart demo). Panel admin
harus menampilkan data nyata dari `/api/admin/*`, jadi interaksi header /
sidebar / tema diimplementasikan ulang di `admin.js` mengikuti perilaku
template yang sama (selector, class, dan kunci localStorage yang sama:
`theme`, `sidebar-collapsed`), tanpa data mock.

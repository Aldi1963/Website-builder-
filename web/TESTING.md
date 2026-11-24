# Testing frontend

```bash
pnpm test        # vitest run — semua test di src/**/*.test.{ts,tsx}
pnpm typecheck   # tsc -b
pnpm lint        # = typecheck (lihat bawah)
pnpm build       # tsc -b && vite build
```

## Setup

Vitest 3 dengan environment `node` (lihat blok `test` di `vite.config.ts`).
Sengaja **tanpa jsdom / testing-library**: smoke render memakai
`react-dom/server` (`renderToString`) dan test util memakai fungsi murni —
cukup untuk kebutuhan saat ini dan jauh lebih ringan. Bila nanti butuh
interaksi DOM (klik, form), tambahkan `jsdom` + `@testing-library/react`
dan ubah environment per file (`// @vitest-environment jsdom`).

Test yang ada:

- `src/lib/api.test.ts` — `jwtPayload` (decode base64url, token rusak → `{}`),
  round-trip `getToken`/`setToken` (dengan stub `localStorage` in-memory).
- `src/lib/queryClient.test.ts` — default query client
  (`staleTime` 15 detik, tanpa refetch saat fokus, retry 1x).
- `src/pages/LandingV2.test.tsx` — smoke render landing: hero + 6 kartu
  fitur tampil, `onStart` tidak terpanggil saat render.

## Kenapa `lint` = typecheck

Repo ini tidak punya konfigurasi ESLint, dan codebase `web/src` besar
dengan banyak pola yang belum rapi (`any`, import tak terpakai, dsb.).
Memasang ESLint flat config minimal sekarang berarti salah satu dari:

1. config yang langsung merah di ratusan file (script `lint` gagal sejak
   hari pertama — tidak berguna), atau
2. config yang mematikan hampir semua rule sampai lolos (linter pura-pura).

Keduanya lebih buruk daripada jujur: `pnpm lint` menjalankan `tsc -b`,
yang sudah menangkap kesalahan tipe — kelas bug paling mahal di
codebase ini. Bila suatu saat ESLint dipasang, jalankan dulu
`eslint --init`-style dengan baseline per file yang ada, dan ubah script
ini menjadi `eslint . && tsc -b --pretty false`.

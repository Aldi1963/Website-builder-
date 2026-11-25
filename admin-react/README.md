# Admin VibeBuilder — React

Rewrite panel admin VibeBuilder (dulu: halaman server-render + `admin.js`
vanilla) menjadi SPA React 19 + Vite 8 + Tailwind v4 + TypeScript. Repo ini
hanya kerangka (scaffold): layout, router, auth, komponen bersama, dan stub
22 halaman. Halaman asli ditulis oleh agen halaman di `src/pages/<slug>.tsx`.

## Menjalankan

```bash
npm install
npm run dev      # http://127.0.0.1:5174, proxy /api -> http://127.0.0.1:3000
npm run build    # tsc --noEmit + vite build -> dist/ (base '/admin-app/')
npm run preview
```

Server VibeBuilder harus jalan di port 3000 agar `/api` ter-proxy.

## Mengganti stub dengan halaman asli

1. Buka `src/pages/<slug>.tsx`, hapus isi stub, tulis komponen halaman
   (default export). Nama file dan slug TIDAK boleh diubah — tabel route di
   `src/routes.ts` mengimpor `./pages/<slug>`.
2. Judul halaman tetap lewat `<PageHeader title="…" description="…" />`.
3. Ambil data lewat `api` (lihat bawah). Jangan `fetch` mentah.
4. Tampilkan error API dengan `useToast().error(...)`, bukan `alert()`.
5. Aksi destruktif (hapus, cabut, pulihkan) wajib lewat `<ConfirmDialog>`.
6. Daftar data pakai `<Table>` (+ `<Th>`/`<Td>`). **Tabel tetap tabel di
   mobile** — jangan diubah jadi kartu; pembungkus sudah `overflow-x-auto`.
7. Copy Bahasa Indonesia. Tanpa gradasi di mana pun (permukaan solid).

Contoh kerangka halaman:

```tsx
import { useEffect, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { useToast } from '../lib/toast'
import { PageHeader } from '../components/PageHeader'
import { Card } from '../components/Card'
import { Table, Th, Td } from '../components/Table'
import { Spinner } from '../components/Spinner'
import { EmptyState } from '../components/EmptyState'

export default function UsersPage() {
  const toast = useToast()
  const [rows, setRows] = useState<Row[] | null>(null)

  useEffect(() => {
    api.get<Row[]>('/api/admin/users')
      .then(setRows)
      .catch((e) => toast.error(e instanceof ApiError ? e.message : 'Gagal memuat.'))
  }, [toast])

  return (
    <div className="space-y-4">
      <PageHeader title="Pengguna" description="Kelola akun pengguna." />
      {rows === null ? <Spinner /> : rows.length === 0 ? <EmptyState title="Belum ada pengguna" /> : (
        <Table>
          <thead><tr><th>Email</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.id}><td>{r.email}</td></tr>)}</tbody>
        </Table>
      )}
    </div>
  )
}
```

## API router (`src/lib/router.tsx`)

Router history minimal, basename `/admin`, tanpa dependensi luar.

```tsx
import { navigate, NavLink, useRoute } from '../lib/router'

// Pindah halaman (tanpa reload):
navigate('/admin/users')

// Tautan internal (className boleh fungsi (active) => string):
<NavLink to="/admin/users" className={(a) => (a ? 'aktif' : '')}>Pengguna</NavLink>

// Route aktif + param (mendukung pola :param di routes.ts):
const { path, route, params } = useRoute() // params.id untuk /admin/users/:id
```

Menambah route baru: tambah entri di `ROUTES` (`src/routes.ts`) +
file `src/pages/<slug>.tsx`. Judul, ikon, dan urutan sidebar ikut tabel ini.

## API client (`src/lib/api.ts`)

```tsx
import { api, ApiError, downloadFile } from '../lib/api'

const data = await api.get<T>('/api/admin/overview')
await api.post('/api/admin/users', { email, name })
await api.put('/api/admin/ai-settings', { model })
await api.patch('/api/admin/users/12', { disabled: true })
await api.del('/api/admin/projects/abc')
await downloadFile('/api/admin/cost.csv', 'biaya.csv')
// Upload: body FormData otomatis dikirim tanpa header content-type JSON.
await api.post('/api/admin/cadangan/restore', formData)

// Error: ApiError { status, message }. Pesan diambil dari { error } server.
try { await api.get('/api/admin/x') } catch (e) {
  if (e instanceof ApiError && e.status === 403) { /* bukan admin */ }
}
```

Semua request memakai `credentials: 'include'` (cookie sesi). Tidak ada
token di localStorage.

## Auth (`src/lib/auth.tsx`)

```tsx
const { status, user, refresh, logout } = useAuth()
// status: 'loading' | 'unauthenticated' | 'non-admin' | 'admin'
```

Deteksi admin: skema `users` tidak punya kolom role — admin = email cocok
`VB_ADMIN_EMAIL` atau akun pertama (`server/src/admin.ts`). `/api/auth/me`
tidak memberi flag admin, jadi scaffold memverifikasi dengan memanggil
`GET /api/admin/overview` dan membaca 401/403 dari `requireAdmin`.
Login lewat SPA builder di `/` (`LOGIN_URL`).

## Komponen bersama (`src/components/`)

| Komponen | Pakai untuk |
| --- | --- |
| `Modal` | Dialog umum (`open`, `onClose`, `title`, `footer`, `size="md"\|"lg"`) |
| `ConfirmDialog` | Konfirmasi Ya/Batal (`title`, `message`, `confirmLabel`, `danger`, `loading`, `onConfirm`, `onCancel`) |
| `Card` | Kartu permukaan (`title`, `description`, `actions`) |
| `StatCard` | Statistik (`label`, `value`, `sub`, `icon`) |
| `Table`, `Th`, `Td` | Tabel data (overflow-x-auto, tetap tabel di mobile) |
| `Pagination` | `page`, `totalPages`, `onPage`, `total` |
| `SearchInput` | Input cari terkontrol (`value`, `onChange`, `placeholder`) |
| `Badge` | Label kecil (`tone`: default/success/danger/warning/info/accent) |
| `Spinner` | Indikator muat (`label`) |
| `Field` (+ `inputClass`) | Label + hint/error di sekitar input |
| `Select` | Select native bergaya panel |
| `Textarea` | Textarea bergaya panel |
| `Toggle` | Sakelar on/off (`checked`, `onChange`, `label`) |
| `PageHeader` | Judul halaman (`title`, `description`, `actions`) |
| `EmptyState` | Daftar kosong (`title`, `description`, `icon`, `action`) |
| `Alert` | Pesan inline (`tone`: info/success/warning/error, `title`, `onClose`) |

Toast (`src/lib/toast.tsx`): `const toast = useToast()` lalu
`toast.success('…')` / `toast.error('…')` / `toast.info('…')`.
Tampil pojok kanan atas, hilang sendiri setelah 4 detik.

## Tema

- Token di `src/index.css`: aksen navy `#243370`, permukaan/teks/border
  untuk light + dark. Dark mode via class `dark` di `<html>` (bukan
  `prefers-color-scheme`); Tailwind v4: `@custom-variant dark`.
- Tema tersimpan di `localStorage 'theme'` (fallback `'vb-admin-theme'`,
  lalu `prefers-color-scheme`) — skrip init di `index.html` menerapkan
  sebelum paint, tombol di topbar menggantinya.
- Pakai token (`bg-surface`, `text-ink`, `text-muted`, `border-border`,
  `bg-accent`, `bg-accent-soft`, `bg-bg`, …), jangan hardcode warna.
  **Tanpa gradasi.**
- Dark mode: aksen navy dibuat lebih terang (`#8fa1e0`) agar kontras tetap
  terbaca; di light tetap `#243370`.

## Layout (`src/layout.tsx`)

`AdminLayout`: sidebar 22 menu (urutan/label = `shell.html` lama, ikon
Phosphor), bisa di-scroll, di HP jadi off-canvas (hamburger + backdrop);
topbar dengan toggle tema, lonceng notifikasi, menu pengguna.

Sumber data layout (sama seperti `admin.js` lama):

- Badge nav Pengguna/Proyek: `GET /api/admin/overview`
  (`users.total`, `projects.total`).
- Badge Kesehatan: `GET /api/admin/health` → `llm.reachable`
  ("OK" hijau / "LLM mati" merah).
- Lonceng: `GET /api/admin/alerts` (`alerts[]`) + `overview.recent`
  (5 aktivitas terakhir); badge = jumlah alert + aktivitas.
- Semua pemanggilan best-effort: gagal memuat hanya menyembunyikan badge,
  tidak merusak layout.

## Konvensi

- Copy Bahasa Indonesia; format angka/tanggal `id-ID`.
- Tanpa gradasi; tanpa emoji di UI (ikon Phosphor).
- Tabel tetap tabel di mobile; select menempel di bawah field-nya
  (dropdown native, bukan popup layar penuh).
- Jangan commit dari sini — koordinator yang commit.

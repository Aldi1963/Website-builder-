# Starter Event & Tiket

Aplikasi tiketing lengkap berbasis TanStack Start + Postgres terkelola.

## Alur yang sudah jalan
- Katalog event publik (`/`) — hanya event `published`.
- Detail event + checkout (`/event/$slug`) — pilih jenis tiket, kode promo, pesanan dibuat dalam transaksi.
- Masuk/daftar (`/masuk`) — pendaftaran publik selalu role `user`.
- Dashboard (`/dashboard`) — pesanan pembeli; untuk organizer/admin: buat event, tambah jenis tiket, publikasikan, check-in tiket.

## Data model
`shared/schema.ts` berisi definisi Drizzle ORM untuk 8 tabel: `users`, `events`, `ticket_types`, `orders`, `order_items`, `attendees`, `ticket_scans`, `promo_codes`. `migrations/0001_tiket_schema.sql` berisi SQL idempoten yang setara. Saat aplikasi dijalankan, `ensureTiketSchema()` di `src/lib/tiket.ts` membuat tabel yang sama lewat tool `db_schema`/helper `query` — jadi skema tetapSinkron dengan database nyata.

Uang disimpan sebagai `INTEGER` sen. `formatPrice()` mengubahnya ke Rupiah saat tampil.

## Aturan keamanan
- Semua aksi kelola event memakai `requireRole(token, ['admin','organizer'])` di server + `canManageEvent()` untuk cek kepemilikan.
- `createOrder` mengunci baris event & tiket (`FOR UPDATE`), memvalidasi kuota, dan mengurangi `sold` di dalam satu transaksi.
- Check-in hanya sekali, dicatat ke `ticket_scans` dengan id petugas.
- Token sesi di cookie httpOnly; tidak ada rahasia di bundle client.

## Menjalankan
```
npm install
npm run dev     # port 3001
npm run build
npm start
```

Database diambil dari env `VB_APP_DATABASE_URL` yang disuntikkan platform. Jangan pakai SQLite/localStorage untuk data aplikasi.

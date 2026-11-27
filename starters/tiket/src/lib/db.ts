import { Pool, type QueryResultRow } from 'pg'

/**
 * Helper database untuk aplikasi hasil generate (server-side saja).
 *
 * VibeBuilder menyuntikkan koneksi database Postgres terkelola ke env
 * VB_APP_DATABASE_URL saat preview/publish. Import file ini HANYA dari
 * server function (createServerFn) atau file *.server.ts — jangan dari
 * komponen klien, karena berisi kredensial database.
 *
 * Contoh pemakaian di route:
 *   import { createServerFn } from '@tanstack/react-start'
 *   import { query } from '../lib/db'
 *
 *   const loadNotes = createServerFn({ method: 'GET' }).handler(async () => {
 *     const { rows } = await query('select id, title from notes order by id desc')
 *     return rows
 *   })
 */

let pool: Pool | null = null

export function getPgPool(): Pool {
  if (!pool) {
    const url = process.env.VB_APP_DATABASE_URL
    if (!url) {
      throw new Error('Database belum tersedia. Minta VibeBuilder membuat tabel dengan tool db_schema terlebih dahulu.')
    }
    pool = new Pool({ connectionString: url, max: 5 })
  }
  return pool
}

/** Jalankan query berparameter. Selalu pakai $1, $2 … bukan string concat. */
export async function query<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []) {
  return getPgPool().query<T>(text, params)
}

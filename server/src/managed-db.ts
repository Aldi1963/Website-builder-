import { Pool } from 'pg'
import { randomBytes } from 'node:crypto'

/**
 * Database terkelola untuk proyek hasil generate (Fase 0).
 *
 * Setiap proyek yang mengaktifkan database mendapat:
 *  - satu role Postgres bernama vb_<projectId> (password acak, hanya akses DB miliknya),
 *  - satu database Postgres bernama vb_<projectId>,
 *  - koneksi yang di-cache di server (bukan di kode user), sehingga user tidak menyentuh kredensial.
 *
 * Isolasi: role proyek hanya diberi GRANT ALL pada database-nya sendiri, tidak bisa melihat/menyentuh proyek lain.
 * Role admin (VB_PG_URL) dipakai untuk membuat/menghapus role & database proyek.
 */

const ADMIN_URL = process.env.VB_PG_URL ?? ''
const ROLE_PREFIX = 'vb_'
const poolCache = new Map<string, { pool: Pool; password: string }>()

function projectIdToSafe(projectId: string): string {
  // id proyek adalah hex pendek; jaga tetap identifier Postgres aman.
  return projectId.replace(/[^a-z0-9_]/gi, '').toLowerCase().slice(0, 32)
}

function roleName(projectId: string): string {
  return `${ROLE_PREFIX}${projectIdToSafe(projectId)}`
}
function dbName(projectId: string): string {
  return `${ROLE_PREFIX}${projectIdToSafe(projectId)}`
}

export function isManagedDbEnabled(): boolean {
  return Boolean(ADMIN_URL)
}

async function adminPool(): Promise<Pool> {
  if (!ADMIN_URL) throw new Error('Database terkelola belum dikonfigurasi (VB_PG_URL kosong).')
  return new Pool({ connectionString: ADMIN_URL, max: 2 })
}

/**
 * Provision database proyek sekali dan pertahankan. Password disimpan di
 * tabel platform `project_databases` (server-side). Kalau sudah ada, pakai
 * kembali yang tersimpan — jangan rotasi/drop, agar data aplikasi aman
 * melewati restart preview.
 */
export async function provisionProjectDb(projectId: string): Promise<{ role: string; database: string; password: string }> {
  const admin = await adminPool()
  try {
    const role = roleName(projectId)
    const database = dbName(projectId)

    // Sudah pernah provision? Pakai ulang.
    const existing = await admin.query(`select password from project_databases where project_id = $1`, [projectId]).catch(() => null)
    if (existing?.rowCount) {
      const password = existing.rows[0].password as string
      const roleExists = await admin.query(`select 1 from pg_roles where rolname = $1`, [role])
      const dbExists = await admin.query(`select 1 from pg_database where datname = $1`, [database])
      if (roleExists.rowCount && dbExists.rowCount) {
        return { role, database, password }
      }
      // Ada di record tapi hilang di server → buat ulang dengan password tersimpan.
      if (!roleExists.rowCount) await admin.query(`create role "${role}" with login password '${password}'`)
      if (!dbExists.rowCount) {
        await createProjectDatabase(admin, role, database)
      }
      return { role, database, password }
    }

    // Provision baru.
    const password = randomBytes(24).toString('hex')
    // Bersihkan sisa role lama (kalau ada) agar createrole_self_grant berlaku.
    const roleExists = await admin.query(`select 1 from pg_roles where rolname = $1`, [role])
    if (roleExists.rowCount) {
      await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where usename = $1`, [role])
      await admin.query(`drop role "${role}"`)
    }
    await admin.query(`create role "${role}" with login password '${password}'`)
    const dbExists = await admin.query(`select 1 from pg_database where datname = $1`, [database])
    if (!dbExists.rowCount) {
      await createProjectDatabase(admin, role, database)
    }
    // Simpan password di platform DB.
    await admin.query(
      `create table if not exists project_databases (project_id text primary key, role text, database text, password text, created_at timestamptz default now())`,
    )
    await admin.query(`insert into project_databases (project_id, role, database, password) values ($1,$2,$3,$4) on conflict (project_id) do update set role=excluded.role, database=excluded.database, password=excluded.password`, [projectId, role, database, password])
    return { role, database, password }
  } finally {
    await admin.end()
  }
}

/** Buat database proyek + beri role proyek hak DDL penuh di schema public. */
async function createProjectDatabase(admin: Pool, role: string, database: string): Promise<void> {
  await admin.query(`create database "${database}"`)
  const projUrl = withDb(adminUrlWithPassword(), database)
  const projAdmin = new Pool({ connectionString: projUrl, max: 1 })
  try {
    await projAdmin.query(`grant all on schema public to "${role}"`)
    await projAdmin.query(`alter schema public owner to "${role}"`)
    await projAdmin.query(`alter default privileges in schema public grant all on tables to "${role}"`)
    await projAdmin.query(`alter default privileges in schema public grant all on sequences to "${role}"`)
  } finally {
    await projAdmin.end()
  }
}

/** Koneksi pool untuk proyek (server-side). Cache untuk reuse. */
export async function projectDbPool(projectId: string): Promise<{ pool: Pool; database: string }> {
  const cached = poolCache.get(projectId)
  if (cached) return { pool: cached.pool, database: dbName(projectId) }
  const { role, database, password } = await provisionProjectDb(projectId)
  const url = `postgres://${encodeURIComponent(role)}:${encodeURIComponent(password)}@${dbHostPort()}/${encodeURIComponent(database)}`
  const pool = new Pool({ connectionString: url, max: 5, idleTimeoutMillis: 30_000 })
  poolCache.set(projectId, { pool, password })
  return { pool, database }
}

/**
 * Koneksi string Postgres proyek untuk disuntikkan ke proses preview/publish,
 * sehingga app hasil generate bisa memakai database terkelola tanpa mengelola
 * kredensial sendiri. Password role proyek di-provision (segar) saat dipanggil.
 */
export async function projectDbUrl(projectId: string): Promise<string | null> {
  if (!isManagedDbEnabled()) return null
  try {
    const { role, database, password } = await provisionProjectDb(projectId)
    return `postgres://${encodeURIComponent(role)}:${encodeURIComponent(password)}@${dbHostPort()}/${encodeURIComponent(database)}`
  } catch {
    return null
  }
}

function dbHostPort(): string {
  // Ambil host:port dari VB_PG_URL; fallback lokal.
  try {
    const u = new URL(ADMIN_URL)
    return `${u.hostname}:${u.port || 5432}`
  } catch {
    return '127.0.0.1:5432'
  }
}

/** ADMIN_URL lengkap (dengan password admin). */
function adminUrlWithPassword(): string {
  return ADMIN_URL
}

/** Ganti nama database pada sebuah URL koneksi Postgres. */
function withDb(url: string, database: string): string {
  const u = new URL(url)
  u.pathname = `/${encodeURIComponent(database)}`
  return u.toString()
}

/** Jalankan statement DDL/SQL tunggal dari tool agent, dengan batas aman. */
export async function execProjectSql(projectId: string, sql: string): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  if (!isManagedDbEnabled()) return { ok: false, error: 'Database terkelola belum aktif.' }
  const trimmed = sql.trim().replace(/;+\s*$/, '')
  // Larang perintah administratif berbahaya dari kode proyek.
  if (/;\s*(drop\s+database|create\s+database|alter\s+database|drop\s+role|create\s+role)/i.test(trimmed + ';')) {
    return { ok: false, error: 'Operasi administratif database tidak diizinkan dari kode proyek.' }
  }
  try {
    const { pool } = await projectDbPool(projectId)
    const res = await pool.query(trimmed)
    return { ok: true, result: { rowCount: res.rowCount ?? 0, command: res.command } }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** Hapus database + role proyek (dipakai saat proyek dihapus). */
export async function dropProjectDb(projectId: string): Promise<{ ok: boolean; error?: string }> {
  if (!ADMIN_URL) return { ok: false, error: 'VB_PG_URL kosong.' }
  const admin = await adminPool()
  try {
    const role = roleName(projectId)
    const database = dbName(projectId)
    // Tutup pool cache DULU: preview memakai koneksi lewat cache ini, dan pool pg
    // akan membuat koneksi baru bila koneksi lama dimatikan → race saat DROP.
    await poolCache.get(projectId)?.pool.end().catch(() => {})
    poolCache.delete(projectId)
    const existsDb = await admin.query(`select 1 from pg_database where datname = $1`, [database])
    if (existsDb.rowCount) {
      // putuskan semua koneksi aktif (termasuk koneksi preview app) lalu hapus, dengan
      // beberapa percobaan karena proses preview bisa membuka ulang koneksi dalam hitungan ms.
      let lastErr: unknown = null
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = $1`, [database])
          await new Promise((r) => setTimeout(r, 250))
          await admin.query(`drop database "${database}"`)
          lastErr = null
          break
        } catch (e) {
          lastErr = e
          await new Promise((r) => setTimeout(r, 500))
        }
      }
      if (lastErr) throw lastErr
    }
    const existsRole = await admin.query(`select 1 from pg_roles where rolname = $1`, [role])
    if (existsRole.rowCount) {
      // lepaskan dependensi sesi sebelum drop role.
      await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where usename = $1`, [role])
      await admin.query(`drop role "${role}"`)
    }
    // hapus catatan kredensial proyek di platform DB.
    try {
      const { db } = await import('./db.ts')
      db.prepare(`DELETE FROM project_databases WHERE project_id = ?`).run(projectId)
    } catch {
      /* tabel platform belum ada, abaikan */
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  } finally {
    await admin.end()
  }
}

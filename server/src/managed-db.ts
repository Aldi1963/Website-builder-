import { Pool } from 'pg'
import { randomBytes } from 'node:crypto'
import { isNeonConfigured, neonProvision, neonConnectionUrl, neonDropProject } from './neon-db.ts'

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
  return Boolean(ADMIN_URL) || isNeonConfigured()
}

/** Aktif Neon bila kredensial API tersedia; jika tidak, tetap Postgres lokal. */
function useNeon(): boolean {
  return isNeonConfigured()
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
  if (useNeon()) return neonProvision(projectId)
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
    // Role lama (sisa percobaan yang gagal) TIDAK di-drop: kalau database-nya
    // sudah berisi objek milik role itu, `drop role` gagal dan seluruh
    // provisioning ikut gagal. Cukup rotasi password + pastikan database ada.
    const roleExists = await admin.query(`select 1 from pg_roles where rolname = $1`, [role])
    if (roleExists.rowCount) {
      await admin.query(`alter role "${role}" with login password '${password}'`)
    } else {
      await admin.query(`create role "${role}" with login password '${password}'`)
    }
    const dbExists = await admin.query(`select 1 from pg_database where datname = $1`, [database])
    if (!dbExists.rowCount) {
      await createProjectDatabase(admin, role, database)
    } else {
      await grantProjectSchema(admin, role, database)
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

/** Beri role proyek hak DDL penuh di schema public database proyek. */
async function grantProjectSchema(admin: Pool, role: string, database: string): Promise<void> {
  const projUrl = withDb(adminUrlWithPassword(), database)
  const projAdmin = new Pool({ connectionString: projUrl, max: 1 })
  try {
    // Admin perlu membership pada role proyek untuk ALTER SCHEMA ... OWNER TO.
    await projAdmin.query(`grant "${role}" to current_user`).catch(() => {})
    await projAdmin.query(`grant all on schema public to "${role}"`)
    await projAdmin.query(`alter schema public owner to "${role}"`).catch(() => {})
    await projAdmin.query(`alter default privileges in schema public grant all on tables to "${role}"`)
    await projAdmin.query(`alter default privileges in schema public grant all on sequences to "${role}"`)
  } finally {
    await projAdmin.end()
  }
}

/** Buat database proyek + beri role proyek hak DDL penuh di schema public. */
async function createProjectDatabase(admin: Pool, role: string, database: string): Promise<void> {
  await admin.query(`create database "${database}"`)
  await grantProjectSchema(admin, role, database)
}

/** Koneksi pool untuk proyek (server-side). Cache untuk reuse. */
export async function projectDbPool(projectId: string): Promise<{ pool: Pool; database: string }> {
  const cached = poolCache.get(projectId)
  // Pool bisa berakhir (di-end) oleh pemakai lain/pemanggilan lama; pool yang sudah
  // di-end akan melempar "Cannot use a pool after calling end on the pool" ke semua
  // pemanggil berikutnya. Buang dari cache agar dibuat ulang.
  if (cached && !(cached.pool as unknown as { ended?: boolean }).ended) {
    return { pool: cached.pool, database: dbName(projectId) }
  }
  if (cached) poolCache.delete(projectId)
  const neonUrl = useNeon() ? await neonConnectionUrl(projectId) : null
  let url: string
  let database: string
  if (neonUrl) {
    const parsed = new URL(neonUrl)
    database = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
    url = neonUrl
  } else {
    const provisioned = await provisionProjectDb(projectId)
    database = provisioned.database
    url = projectConnectionUrl(provisioned.role, database, provisioned.password)
  }
  const pool = new Pool({ connectionString: url, max: 5, idleTimeoutMillis: 30_000 })
  // Error pada client idle tidak boleh menjatuhkan proses platform.
  pool.on('error', (err) => {
    console.error('[managed-db] pool error', projectId, err.message)
  })
  poolCache.set(projectId, { pool, password: '' })
  return { pool, database }
}

/**
 * Koneksi string Postgres proyek untuk disuntikkan ke proses preview/publish,
 * sehingga app hasil generate bisa memakai database terkelola tanpa mengelola
 * kredensial sendiri. Password role proyek di-provision (segar) saat dipanggil.
 */
export async function projectDbUrl(projectId: string): Promise<string | null> {
  if (useNeon()) return neonConnectionUrl(projectId)
  if (!isManagedDbEnabled()) return null
  try {
    const { role, database, password } = await provisionProjectDb(projectId)
    return projectConnectionUrl(role, database, password)
  } catch {
    return null
  }
}

function projectConnectionUrl(role: string, database: string, password: string): string {
  if (!ADMIN_URL) throw new Error('VB_PG_URL kosong dan Neon belum dikonfigurasi.')
  const url = new URL(ADMIN_URL)
  url.username = role
  url.password = password
  url.pathname = `/${database}`
  return url.toString()
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

/**
 * Allowlist SQL untuk tool agent. Dua lapis: (1) hanya satu pernyataan per panggilan,
 * (2) awalan pernyataan harus termasuk daftar operasi yang diizinkan untuk tool itu.
 * Komentar dibuang lebih dulu supaya perintah terlarang tidak bisa disembunyikan
 * di dalam komentar gaya baris maupun blok.
 */
export type SqlKind = 'schema' | 'query'

const SCHEMA_STATEMENTS: Array<{ re: RegExp; label: string }> = [
  { re: /^create\s+(?:temporary\s+|temp\s+|unlogged\s+)?table\b/i, label: 'CREATE TABLE' },
  { re: /^create\s+(?:unique\s+)?index\b/i, label: 'CREATE INDEX' },
  { re: /^alter\s+table\b/i, label: 'ALTER TABLE' },
  { re: /^comment\s+on\b/i, label: 'COMMENT ON' },
]

const QUERY_STATEMENTS: Array<{ re: RegExp; label: string }> = [
  { re: /^select\b/i, label: 'SELECT' },
  { re: /^with\b/i, label: 'WITH' },
  { re: /^insert\s+into\b/i, label: 'INSERT' },
  { re: /^update\b/i, label: 'UPDATE' },
  { re: /^delete\s+from\b/i, label: 'DELETE' },
]

const FORBIDDEN_SQL: Array<{ re: RegExp; label: string }> = [
  { re: /\bcreate\s+(?:or\s+replace\s+)?(?:database|role|user|group|tablespace|extension|foreign\s+data\s+wrapper|server|publication|subscription)\b/i, label: 'CREATE DATABASE/ROLE/EXTENSION' },
  { re: /\balter\s+(?:database|role|user|group|system|tablespace)\b/i, label: 'ALTER administratif' },
  { re: /\bdrop\s+(?:database|role|user|group|schema|tablespace|extension)\b/i, label: 'DROP administratif' },
  { re: /^(?:grant|revoke)\b/i, label: 'GRANT/REVOKE' },
  { re: /^set\s+(?:role|session\s+authorization|local\s+role)\b|^reset\s+(?:role|all|session\s+authorization)\b/i, label: 'SET ROLE' },
  { re: /^copy\b[\s\S]*\bprogram\b/i, label: 'COPY PROGRAM' },
  { re: /\b(?:pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|pg_terminate_backend|pg_cancel_backend|lo_import|lo_export|dblink|pg_execute_server_program)\s*\(/i, label: 'fungsi server terlarang' },
  { re: /^do\s+\$|^(?:listen|unlisten|notify)\b/i, label: 'DO/LISTEN/NOTIFY' },
  { re: /^(?:truncate|vacuum|reindex|cluster|analyze|refresh\s+materialized\s+view)\b/i, label: 'operasi pemeliharaan' },
]

type SqlToken = { type: 'code' | 'literal' | 'semicolon'; text: string }

/** Tokenisasi ringan: pisahkan kode, literal (string/identifier/dollar-quote), dan pemisah pernyataan. */
function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = []
  let code = ''
  let i = 0
  const n = sql.length
  const flushCode = () => {
    if (code) tokens.push({ type: 'code', text: code })
    code = ''
  }
  while (i < n) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (ch === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i++
      code += ' '
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++
      i += 2
      code += ' '
      continue
    }
    if (ch === "'" || ch === '"') {
      flushCode()
      const quote = ch
      let raw = quote
      i++
      while (i < n) {
        raw += sql[i]
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            raw += sql[i + 1]
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      tokens.push({ type: 'literal', text: raw })
      continue
    }
    if (ch === '$') {
      const tag = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i))?.[0]
      if (tag) {
        flushCode()
        const end = sql.indexOf(tag, i + tag.length)
        const stop = end === -1 ? n : end + tag.length
        tokens.push({ type: 'literal', text: sql.slice(i, stop) })
        i = stop
        continue
      }
    }
    if (ch === ';') {
      flushCode()
      tokens.push({ type: 'semicolon', text: ';' })
      i++
      continue
    }
    code += ch
    i++
  }
  flushCode()
  return tokens
}

/** Buang komentar SQL dan pecah menjadi pernyataan top-level (hormati string/identifier/dollar-quote). */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = []
  let buf = ''
  for (const tok of tokenizeSql(sql ?? '')) {
    if (tok.type === 'semicolon') {
      if (buf.trim()) out.push(buf.trim())
      buf = ''
      continue
    }
    buf += tok.text
  }
  if (buf.trim()) out.push(buf.trim())
  return out
}

/** Kode SQL dengan isi literal dikosongkan, agar kata terlarang di dalam string tidak memicu false positive. */
function maskedSql(statement: string): string {
  return tokenizeSql(statement)
    .map((tok) => (tok.type === 'literal' ? "''" : tok.text))
    .join('')
}

/** Validasi SQL dari tool agent; mengembalikan {ok:true, sql} atau {ok:false, error}. */
export function validateProjectSql(kind: SqlKind, sql: string): { ok: true; sql: string } | { ok: false; error: string } {
  const statements = splitSqlStatements(sql ?? '')
  if (statements.length === 0) return { ok: false, error: 'SQL kosong.' }
  if (statements.length > 1) {
    return { ok: false, error: `Hanya boleh satu pernyataan per panggilan (terdeteksi ${statements.length}).` }
  }
  const stmt = statements[0]
  const masked = maskedSql(stmt)
  for (const rule of FORBIDDEN_SQL) {
    if (rule.re.test(masked)) return { ok: false, error: `Operasi ${rule.label} tidak diizinkan dari tool agent.` }
  }
  const allowed = kind === 'schema' ? SCHEMA_STATEMENTS : QUERY_STATEMENTS
  if (!allowed.some((rule) => rule.re.test(stmt))) {
    const ops = allowed.map((r) => r.label).join(' / ')
    return { ok: false, error: `Pernyataan tidak diizinkan untuk ${kind === 'schema' ? 'db_schema' : 'db_query'}. Gunakan: ${ops}.` }
  }
  return { ok: true, sql: stmt }
}

/** Jalankan statement DDL/SQL tunggal dari tool agent, dengan validasi allowlist. */
export async function execProjectSql(projectId: string, sql: string, kind: SqlKind = 'query'): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const checked = validateProjectSql(kind, sql)
  if (!checked.ok) return { ok: false, error: checked.error }
  if (!isManagedDbEnabled()) return { ok: false, error: 'Database terkelola belum aktif.' }
  try {
    const { pool } = await projectDbPool(projectId)
    const res = await pool.query(checked.sql)
    return { ok: true, result: { rowCount: res.rowCount ?? 0, command: res.command } }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** Hapus database + role proyek (dipakai saat proyek dihapus). */
/** Ringkasan skema proyek untuk konteks agent: nama tabel + kolom + jumlah
    baris. Sengaja ringkas (maksimal 24 tabel, 18 kolom/tabel, 8 sampel) agar
    tidak membengkakkan system prompt. Mengembalikan null bila DB tidak aktif
    atau belum bisa dibuka — agent tetap jalan tanpa konteks ini. */
export async function projectSchemaBrief(projectId: string): Promise<string | null> {
  if (!isManagedDbEnabled()) return null
  let pool: import('pg').Pool | null = null
  try {
    const opened = await projectDbPool(projectId)
    pool = opened.pool
    const ts = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       ORDER BY table_name LIMIT 24`,
    )
    if (!ts.rows.length) return 'Belum ada tabel di database proyek.'
    const parts: string[] = []
    for (const t of ts.rows) {
      const cols = await pool.query<{ column_name: string; data_type: string }>(
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position LIMIT 18`,
        [t.table_name],
      )
      let count = '?'
      try {
        const c = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM "${t.table_name.replace(/"/g, '""')}"`)
        count = c.rows[0]?.n ?? '?'
      } catch { /* tabel baru saja berubah — biarkan count tidak diketahui */ }
      const colText = cols.rows.map((c) => `${c.column_name}:${c.data_type}`).join(', ')
      parts.push(`${t.table_name} (${count} baris): ${colText}`)
    }
    return parts.join('\n')
  } catch {
    return null
  } finally {
    try { if (pool) await pool.end() } catch { /* abaikan */ }
  }
}

export async function dropProjectDb(projectId: string): Promise<{ ok: boolean; error?: string }> {
  if (useNeon()) {
    await poolCache.get(projectId)?.pool.end().catch(() => {})
    poolCache.delete(projectId)
    return neonDropProject(projectId)
  }
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

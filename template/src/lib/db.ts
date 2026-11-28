/**
 * Helper database untuk aplikasi hasil generate (server-side saja).
 *
 * Mendukung dua driver:
 *  - Postgres  -> VB_APP_DATABASE_URL = postgres://... / postgresql://...
 *  - MySQL     -> VB_APP_DATABASE_URL = mysql://...  (juga mysql2://)
 *
 * Di VibeBuilder, URL disuntikkan otomatis per proyek. Saat di-deploy ke
 * cPanel, isi VB_APP_DATABASE_URL di Environment Variables dengan URL MySQL
 * yang dibuat di cPanel (MySQL Databases). Kredensial TIDAK pernah ditaruh
 * di kode client.
 *
 * Tulis query memakai placeholder Postgres ($1, $2, ...). Helper menerjemahkan
 * ke '?' otomatis saat driver MySQL dipakai, jadi satu sumber kode bisa jalan
 * di keduanya.
 */
import { Pool as PgPool } from 'pg'
import mysql from 'mysql2/promise'

type Row = Record<string, unknown>
type QueryResult<T> = { rows: T[]; rowCount?: number; insertId?: number }

let engine: 'postgres' | 'mysql' | null = null
let pgPool: PgPool | null = null
let myPool: mysql.Pool | null = null

function getEngine(): 'postgres' | 'mysql' {
  if (engine) return engine
  const url = process.env.VB_APP_DATABASE_URL || ''
  if (/^mysql(2)?:\/\//i.test(url)) engine = 'mysql'
  else if (/^postgres(ql)?:\/\//i.test(url)) engine = 'postgres'
  else throw new Error('Database belum tersedia. Isi VB_APP_DATABASE_URL (postgres:// atau mysql://) di pengaturan proyek.')
  return engine
}

function toMySql(sql: string, params: unknown[]): { sql: string; params: unknown[] } {
  // $1, $2, ... -> ? , berurutan. Hindari penggantian di dalam string literal.
  const parts: string[] = []
  let used = 0
  let quote: string | null = null
  for (let c = 0; c < sql.length; c++) {
    const ch = sql[c]
    if (quote) {
      parts.push(ch)
      if (ch === quote && sql[c - 1] !== '\\') quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; parts.push(ch); continue }
    if (ch === '$' && /\d/.test(sql[c + 1] || '')) {
      let num = ''
      while (/\d/.test(sql[c + 1] || '')) { num += sql[++c] }
      const idx = Number(num) - 1
      parts.push('?')
      if (params[idx] !== undefined) used = Math.max(used, idx + 1)
      continue
    }
    parts.push(ch)
  }
  return { sql: parts.join(''), params: params.slice(0, used) }
}

export function getPgPool() {
  if (getEngine() !== 'postgres') throw new Error('Pool Postgres tidak tersedia saat driver MySQL aktif.')
  if (!pgPool) pgPool = new PgPool({ connectionString: process.env.VB_APP_DATABASE_URL, max: 5 })
  return pgPool
}

export function getMysqlPool() {
  if (getEngine() !== 'mysql') throw new Error('Pool MySQL tidak tersedia saat driver Postgres aktif.')
  if (!myPool) {
    myPool = mysql.createPool({
      uri: process.env.VB_APP_DATABASE_URL,
      waitForConnections: true,
      connectionLimit: 5,
      namedPlaceholders: false,
    })
  }
  return myPool
}

/** Jalankan query berparameter. Pakai $1, $2 … (diterjemahkan ke ? untuk MySQL). */
export async function query<T = Row>(text: string, params: unknown[] = []): Promise<QueryResult<T>> {
  if (getEngine() === 'postgres') {
    const r = await getPgPool().query<T>(text, params)
    return { rows: r.rows, rowCount: r.rowCount ?? undefined }
  }
  const q = toMySql(text, params)
  const [rows] = await getMysqlPool().execute(q.sql, q.params as never[])
  if (Array.isArray(rows)) {
    const affected = (rows as unknown[]).length
    return { rows: rows as T[], rowCount: affected }
  }
  const meta = rows as unknown as { affectedRows?: number; insertId?: number }
  return { rows: [], rowCount: meta.affectedRows, insertId: meta.insertId }
}

/** DDL idempotent: CREATE TABLE IF NOT EXISTS ... (Postgres & MySQL). */
export async function ensureTable(ddl: string) {
  const sql = ddl.trim().replace(/;$/, '')
  if (getEngine() === 'postgres') return getPgPool().query(sql)
  const my = sql
    .replace(/serial\s+primary\s+key/gi, 'INT AUTO_INCREMENT PRIMARY KEY')
    .replace(/bigserial\s+primary\s+key/gi, 'BIGINT AUTO_INCREMENT PRIMARY KEY')
    .replace(/timestamptz/gi, 'DATETIME')
    .replace(/boolean/gi, 'TINYINT(1)')
    .replace(/double\s+precision/gi, 'DOUBLE')
  return getMysqlPool().query(my)
}

export function driverName() { return getEngine() }

/*
 * Rate limit untuk endpoint auth & LLM berbayar.
 *
 * Default: in-memory (cepat, reset saat restart). Bila VB_RATE_LIMIT_PERSIST=1,
 * bucket disimpan di tabel SQLite `rate_limits` pada DB yang sama dengan
 * aplikasi (VB_DB / data/vibebuilder.db) — tanpa dependency baru — sehingga
 * attempt tidak hilang saat proses di-restart. Tetap best-effort: bukan
 * satu-satunya pengaman, hanya menghentikan brute-force & pembakaran kredit.
 */
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

type Bucket = { times: number[] }

const buckets = new Map<string, Bucket>()
const WINDOW_MS_DEFAULT = 60_000
const PERSIST = process.env.VB_RATE_LIMIT_PERSIST === '1'

function persistentDb(): DatabaseSync | null {
  if (!PERSIST) return null
  try {
    const root = process.env.VB_DB_ROOT ?? join(process.cwd(), '..', 'data')
    const path = process.env.VB_DB ?? join(root, 'vibebuilder.db')
    const db = new DatabaseSync(path)
    db.exec(`CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY,
      times TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`)
    return db
  } catch {
    return null
  }
}

const store = persistentDb()

function load(key: string): number[] {
  if (!store) return buckets.get(key)?.times.slice() ?? []
  try {
    const row = store.prepare('SELECT times FROM rate_limits WHERE key = ?').get(key) as { times: string } | undefined
    return row ? (JSON.parse(row.times) as number[]) : []
  } catch {
    return buckets.get(key)?.times.slice() ?? []
  }
}

function save(key: string, times: number[]) {
  if (!store) {
    buckets.set(key, { times })
    return
  }
  try {
    if (times.length) {
      store.prepare(`INSERT INTO rate_limits (key, times, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET times = excluded.times, updated_at = excluded.updated_at`)
        .run(key, JSON.stringify(times), Date.now())
    } else {
      store.prepare('DELETE FROM rate_limits WHERE key = ?').run(key)
    }
  } catch {
    buckets.set(key, { times })
  }
}

export type RateLimitResult = { ok: boolean; retryAfter: number; remaining: number }

/* Bersihkan bucket lama supaya tabel/peta tidak tumbuh tanpa batas. */
function sweep(now: number, windowMs: number) {
  const cutoff = now - windowMs
  for (const [key, bucket] of buckets) {
    bucket.times = bucket.times.filter((t) => t > cutoff)
    if (!bucket.times.length) buckets.delete(key)
  }
}

export function rateLimit(
  key: string,
  max: number,
  windowMs = WINDOW_MS_DEFAULT,
  now = Date.now(),
): RateLimitResult {
  const cutoff = now - windowMs
  const times = load(key).filter((t) => t > cutoff)
  if (times.length >= max) {
    save(key, times)
    const retryAfter = Math.max(1, Math.ceil((times[0] + windowMs - now) / 1000))
    return { ok: false, retryAfter, remaining: 0 }
  }
  times.push(now)
  save(key, times)
  return { ok: true, retryAfter: 0, remaining: Math.max(0, max - times.length) }
}

/* Dipakai test & admin untuk isolasi antar kasus. */
export function resetRateLimits() {
  buckets.clear()
  if (store) {
    try { store.prepare('DELETE FROM rate_limits').run() } catch { /* abaikan */ }
  }
}

import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto'
import { db } from './db.ts'
import { insertWelcomeGrantIfAbsent } from './credits.ts'

const SCRYPT_N = 16384
const SCRYPT_r = 8
const SCRYPT_p = 1
const KEYLEN = 64
const SESSION_TTL = 1000 * 60 * 60 * 24 * 30
const SESSION_TTL_SHORT = 1000 * 60 * 60 * 24 * 3
const RESET_TTL = 1000 * 60 * 30
export const SESSION_COOKIE = 'vb_session'

export type User = {
  id: string
  email: string
  name: string
  created_at: number
  disabled?: number
}

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
`)

/* Akun nonaktif: tidak bisa masuk dan sesi lamanya dianggap mati. Kolom
   ditambah di tempat supaya database lama tetap jalan. */
try {
  db.exec(`ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0`)
} catch {
  /* sudah ada */
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const key = scryptSync(password, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p })
  return `scrypt$${SCRYPT_N}$${SCRYPT_r}$${SCRYPT_p}$${salt.toString('base64')}$${key.toString('base64')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, n, r, p, saltB64, keyB64] = parts
  const salt = Buffer.from(saltB64, 'base64')
  const expected = Buffer.from(keyB64, 'base64')
  const actual = scryptSync(password, salt, expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  })
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

export function tokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase()
}

export function createUser(email: string, name: string, password: string): User {
  const id = randomBytes(6).toString('hex')
  const now = Date.now()
  /* User + credit gratis 100 (30 hari) lahir dalam satu transaksi: bila
     salah satu gagal, keduanya batal. */
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)`).run(
      id,
      normalizeEmail(email),
      name.slice(0, 60),
      hashPassword(password),
      now,
    )
    insertWelcomeGrantIfAbsent(id, now)
    db.exec('COMMIT')
  } catch (e) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* abaikan */
    }
    throw e
  }
  return { id, email: normalizeEmail(email), name: name.slice(0, 60), created_at: now }
}

export function userByEmail(email: string): (User & { password_hash: string }) | undefined {
  return db.prepare(`SELECT * FROM users WHERE email = ?`).get(normalizeEmail(email)) as
    | (User & { password_hash: string })
    | undefined
}

export function userById(id: string): User | undefined {
  return db.prepare(`SELECT id, email, name, created_at, disabled FROM users WHERE id = ?`).get(id) as User | undefined
}

export function countUsers(): number {
  return (db.prepare(`SELECT count(*) AS n FROM users`).get() as { n: number }).n
}

export function createSession(userId: string, remember = true): { token: string; expiresAt: number } {
  const token = randomBytes(32).toString('base64url')
  const now = Date.now()
  const expiresAt = now + (remember ? SESSION_TTL : SESSION_TTL_SHORT)
  db.prepare(`INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`).run(
    tokenHash(token),
    userId,
    now,
    expiresAt,
  )
  return { token, expiresAt }
}

export function userByToken(token: string | undefined): User | undefined {
  if (!token) return undefined
  const row = db
    .prepare(`SELECT user_id, expires_at FROM sessions WHERE token_hash = ?`)
    .get(tokenHash(token)) as { user_id: string; expires_at: number } | undefined
  if (!row) return undefined
  if (row.expires_at < Date.now()) {
    db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(tokenHash(token))
    return undefined
  }
  const user = userById(row.user_id)
  if (!user || user.disabled) return undefined
  return user
}

export function destroySession(token: string | undefined) {
  if (!token) return
  db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(tokenHash(token))
}

export function purgeExpiredSessions() {
  db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(Date.now())
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim())
  }
  return undefined
}

export function sessionCookie(token: string, maxAgeSec: number, secure = true) {
  /* Secure hanya aktif di HTTPS; di localhost (http) browser akan menolak
     cookie Secure sehingga flag disesuaikan dengan proto yang masuk. */
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax;${secure ? ' Secure;' : ''} Max-Age=${maxAgeSec}`
}

/* Password reset: store only the hash of the emailed token. */
export function createResetToken(email: string): { token: string; userId: string } | null {
  const row = userByEmail(email)
  if (!row) return null
  const token = randomBytes(24).toString('base64url')
  const now = Date.now()
  db.prepare(`DELETE FROM password_resets WHERE user_id = ?`).run(row.id)
  db.prepare(`INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`).run(
    tokenHash(token),
    row.id,
    now,
    now + RESET_TTL,
  )
  return { token, userId: row.id }
}

export function consumeResetToken(token: string): string | null {
  if (!token) return null
  const row = db
    .prepare(`SELECT user_id, expires_at, used_at FROM password_resets WHERE token_hash = ?`)
    .get(tokenHash(token)) as { user_id: string; expires_at: number; used_at: number | null } | undefined
  if (!row) return null
  if (row.used_at !== null || row.expires_at < Date.now()) {
    db.prepare(`DELETE FROM password_resets WHERE token_hash = ?`).run(tokenHash(token))
    return null
  }
  db.prepare(`UPDATE password_resets SET used_at = ? WHERE token_hash = ?`).run(Date.now(), tokenHash(token))
  return row.user_id
}

export function clearCookie(secure = true) {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax;${secure ? ' Secure;' : ''} Max-Age=0`
}

const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

export function validateSignup(email: string, password: string): string | null {
  if (!emailRe.test(normalizeEmail(email))) return 'Format email tidak valid.'
  if (password.length < 8) return 'Password minimal 8 karakter.'
  return null
}

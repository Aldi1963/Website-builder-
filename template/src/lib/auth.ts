import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { query } from './db'

/**
 * Helper autentikasi bawaan untuk aplikasi hasil generate (server-side saja).
 *
 * Fitur:
 *  - Registrasi user (password di-hash scrypt + salt).
 *  - Login dengan verifikasi password.
 *  - Session token (cookie httpOnly) — token disimpan sebagai hash di DB.
 *  - getcurrentUser() untuk membaca user dari cookie di createServerFn.
 *
 * Jalankan sekali (idempotent) schema: panggil ensureAuthSchema() dari
 * server function bootstrap, atau buat tabelnya lewat tool db_schema.
 *
 * Pemakaian di route (server function):
 *   import { createServerFn } from '@tanstack/react-start'
 *   import { register, login, logout, getCurrentUser } from '~/lib/auth'
 *
 * JANGAN import file ini dari komponen klien (berisi logika + akses DB).
 */

const SESSION_COOKIE = 'session_token'
const SESSION_TTL_DAYS = 30

/** Hash password: scrypt + salt acak, disimpan sebagai `salt:hash`. */
function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

/** Verifikasi password terhadap hash tersimpan (constant-time). */
function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':')
  if (!salt || !hash) return false
  const candidate = scryptSync(password, salt, 64)
  const expected = Buffer.from(hash, 'hex')
  if (candidate.length !== expected.length) return false
  return timingSafeEqual(candidate, expected)
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Buat tabel users + sessions bila belum ada (idempotent). */
export async function ensureAuthSchema(): Promise<void> {
  await query(`
    create table if not exists users (
      id serial primary key,
      email text not null unique,
      name text,
      password_hash text not null,
      created_at timestamptz default now()
    )
  `)
  await query(`
    create table if not exists sessions (
      id serial primary key,
      user_id integer not null references users(id) on delete cascade,
      token_hash text not null unique,
      expires_at timestamptz not null,
      created_at timestamptz default now()
    )
  `)
  await query(`create index if not exists sessions_user_id_idx on sessions(user_id)`)
}

export type SafeUser = { id: number; email: string; name: string | null }

/** Registrasi user baru. Melempar Error bila email sudah dipakai. */
export async function register(email: string, password: string, name?: string): Promise<SafeUser> {
  await ensureAuthSchema()
  const normEmail = email.trim().toLowerCase()
  if (!normEmail.includes('@')) throw new Error('Email tidak valid.')
  if (password.length < 6) throw new Error('Password minimal 6 karakter.')
  const exists = await query(`select id from users where email = $1`, [normEmail])
  if (exists.rows.length) throw new Error('Email sudah terdaftar.')
  const hash = hashPassword(password)
  const r = await query<{ id: number; email: string; name: string | null }>(
    `insert into users (email, name, password_hash) values ($1,$2,$3) returning id, email, name`,
    [normEmail, name?.trim() || null, hash],
  )
  return r.rows[0]
}

/** Login: verifikasi kredensial, buat session, kembalikan token + user. */
export async function login(email: string, password: string): Promise<{ user: SafeUser; token: string; expiresInDays: number }> {
  await ensureAuthSchema()
  const normEmail = email.trim().toLowerCase()
  const r = await query<{ id: number; email: string; name: string | null; password_hash: string }>(
    `select id, email, name, password_hash from users where email = $1`,
    [normEmail],
  )
  const user = r.rows[0]
  if (!user || !verifyPassword(password, user.password_hash)) {
    throw new Error('Email atau password salah.')
  }
  const token = randomBytes(32).toString('hex')
  const tokenHash = hashToken(token)
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86400_000)
  await query(`insert into sessions (user_id, token_hash, expires_at) values ($1,$2,$3)`, [user.id, tokenHash, expiresAt])
  // bersihkan session kedaluwarsa milik user ini.
  await query(`delete from sessions where user_id = $1 and expires_at < now()`, [user.id])
  return { user: { id: user.id, email: user.email, name: user.name }, token, expiresInDays: SESSION_TTL_DAYS }
}

/** Logout: hapus session berdasarkan token. */
export async function logout(token: string): Promise<void> {
  if (!token) return
  await query(`delete from sessions where token_hash = $1`, [hashToken(token)])
}

/** Ambil user saat ini dari token session (panggil dari server function). */
export async function getCurrentUser(token: string | undefined | null): Promise<SafeUser | null> {
  if (!token) return null
  const r = await query<{ id: number; email: string; name: string | null; expires_at: Date }>(
    `select u.id, u.email, u.name, s.expires_at
       from sessions s join users u on u.id = s.user_id
      where s.token_hash = $1`,
    [hashToken(token)],
  )
  const row = r.rows[0]
  if (!row) return null
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await logout(token)
    return null
  }
  return { id: row.id, email: row.email, name: row.name }
}

export const AUTH_COOKIE_NAME = SESSION_COOKIE
export const AUTH_COOKIE_MAX_AGE = SESSION_TTL_DAYS * 86400 // detik

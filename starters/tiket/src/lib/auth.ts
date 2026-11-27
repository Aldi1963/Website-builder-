import { createHash, randomBytes, scryptSync } from 'node:crypto'
import { query } from './db-browser'

/**
 * Helper autentikasi bawaan untuk aplikasi hasil generate (server-side saja).
 *
 * Fitur:
 *  - Registrasi user (password di-hash scrypt + salt).
 *  - Login dengan verifikasi password.
 *  - Session token (cookie httpOnly) — token disimpan sebagai hash di DB.
 *  - Role user (`users.role`) + helper requireUser/requireRole untuk guard.
 *  - getSessionUser() untuk membaca user dari cookie di createServerFn.
 *
 * Jalankan sekali (idempotent) lewat ensureAuthSchema()/ensureTables() dari
 * server function bootstrap, atau buat tabelnya lewat tool db_schema.
 *
 * Pemakaian di route (server function):
 *   import { createServerFn } from '@tanstack/react-start'
 *   import { loginUser, logout, getSessionUser, requireUser } from '~/lib/auth'
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
  const candidate = scryptSync(password, salt, 64).toString('hex')
  // Bandingkan hex, bukan Buffer — modul ini ikut ter-bundle ke client oleh
  // TanStack Start, sehingga global Node `Buffer` tidak selalu tersedia.
  if (candidate.length !== hash.length) return false
  let diff = 0
  for (let i = 0; i < candidate.length; i++) diff |= candidate.charCodeAt(i) ^ hash.charCodeAt(i)
  return diff === 0
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Buat tabel users + sessions bila belum ada (idempotent) dan migrasikan
 * kolom `role` untuk database lama. Aman dipanggil berkali-kali.
 */
export async function ensureAuthSchema(): Promise<void> {
  await query(`
    create table if not exists users (
      id serial primary key,
      email text not null unique,
      name text,
      role text default null,
      password_hash text not null,
      created_at timestamptz default now()
    )
  `)
  // Migrasi database lama: tambah kolom role tanpa menghapus data.
  await query(`alter table users add column if not exists role text default null`)
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

/** Alias eksplisit untuk bootstrap: pastikan semua tabel auth siap. */
export async function ensureTables(): Promise<void> {
  await ensureAuthSchema()
}

export type SafeUser = { id: number; email: string; name: string | null; role: string | null }

/** Registrasi user baru. Melempar Error bila email sudah dipakai. */
export async function register(
  email: string,
  password: string,
  name?: string,
  role?: string,
): Promise<SafeUser> {
  /* Registrasi publik tidak boleh membuat akun istimewa. Role admin/guru
     harus diberikan lewat jalur internal (seed/import/by admin), bukan
     lewat input siapa pun yang bisa mengakses halaman daftar. Cek ini
     SEBELUM ensureAuthSchema() agar penolakan terjadi tanpa menyentuh DB. */
  const requestedRole = (role ?? 'siswa').trim() || 'siswa'
  if (['admin', 'guru', 'teacher', 'superadmin'].includes(requestedRole.toLowerCase())) {
    throw new Error('Role tersebut tidak dapat didaftarkan publik.')
  }
  await ensureAuthSchema()
  const normEmail = email.trim().toLowerCase()
  if (!normEmail.includes('@')) throw new Error('Email tidak valid.')
  if (password.length < 6) throw new Error('Password minimal 6 karakter.')
  const exists = await query(`select id from users where email = $1`, [normEmail])
  if (exists.rows.length) throw new Error('Email sudah terdaftar.')
  const hash = hashPassword(password)
  const r = await query<SafeUser>(
    `insert into users (email, name, role, password_hash) values ($1,$2,$3,$4) returning id, email, name, role`,
    [normEmail, name?.trim() || null, requestedRole, hash],
  )
  return r.rows[0]
}

/** Login: verifikasi kredensial, buat session, kembalikan token + user. */
export async function login(
  email: string,
  password: string,
): Promise<{ user: SafeUser; token: string; expiresInDays: number }> {
  await ensureAuthSchema()
  const normEmail = email.trim().toLowerCase()
  const r = await query<SafeUser & { password_hash: string }>(
    `select id, email, name, role, password_hash from users where email = $1`,
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
  return {
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
    token,
    expiresInDays: SESSION_TTL_DAYS,
  }
}

/** Alias semantik untuk alur login di server function. */
export const loginUser = login
/** Alias semantik untuk alur registrasi di server function. */
export const registerUser = register

/** Logout: hapus session berdasarkan token. */
export async function logout(token: string): Promise<void> {
  if (!token) return
  await query(`delete from sessions where token_hash = $1`, [hashToken(token)])
}

/** Ambil user saat ini dari token session (panggil dari server function). */
export async function getCurrentUser(token: string | undefined | null): Promise<SafeUser | null> {
  if (!token) return null
  const r = await query<SafeUser & { expires_at: Date }>(
    `select u.id, u.email, u.name, u.role, s.expires_at
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
  return { id: row.id, email: row.email, name: row.name, role: row.role }
}

/** Alias semantik: baca user dari cookie session. */
export const getSessionUser = getCurrentUser

/** Guard: wajib login. Lempar Error yang aman ditampilkan ke UI. */
export async function requireUser(token: string | undefined | null): Promise<SafeUser> {
  const user = await getCurrentUser(token)
  if (!user) throw new Error('Silakan masuk terlebih dahulu.')
  return user
}

/** Guard: wajib login DAN punya salah satu role yang diizinkan. */
export async function requireRole(
  token: string | undefined | null,
  roles: string | string[],
): Promise<SafeUser> {
  const user = await requireUser(token)
  const allowed = Array.isArray(roles) ? roles : [roles]
  if (!user.role || !allowed.includes(user.role)) {
    throw new Error('Akses ditolak: role tidak mencukupi.')
  }
  return user
}

export const AUTH_COOKIE_NAME = SESSION_COOKIE
export const AUTH_COOKIE_MAX_AGE = SESSION_TTL_DAYS * 86400 // detik

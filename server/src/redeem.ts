import { randomBytes, randomInt } from 'node:crypto'
import { db } from './db.ts'
import { getBalance, type Balance } from './credits.ts'
import { rateLimit } from './rate-limit.ts'

/* ---- Redeem code VibeBuilder (28 Nov 2026) ----
   Kode ditukar pengguna di halaman Penggunaan (/penggunaan) menjadi credit
   bucket `purchased` (kedaluwarsa 12 bulan, sama seperti top-up). Keputusan
   user 28 Nov 2026: kode bisa auto-generate DAN diketik manual; jumlah
   credit bebas; max_uses, kedaluwarsa, dan pembatasan user bisa diatur
   admin; kode tampil plaintext di panel admin; penukaran cukup tercatat
   di riwayat transaksi + log audit (tanpa kanal notifikasi khusus).

   Keamanan: pesan gagal SELALU generik ("Kode tidak valid atau sudah
   kedaluwarsa") supaya tidak bisa ditebak kode mana yang ada; percobaan
   dibatasi 5/menit/user (rate-limit in-memory); penukaran + penambahan
   saldo berjalan dalam SATU transaksi (BEGIN IMMEDIATE) — redemption
   dan credit tidak pernah terjadi setengah-setengah. */

export const REDEEM_GENERIC_ERROR = 'Kode tidak valid atau sudah kedaluwarsa.'
export const REDEEM_RATE_LIMIT_MAX = 5
export const REDEEM_RATE_LIMIT_WINDOW_MS = 60_000

const DAY_MS = 24 * 60 * 60 * 1000
const PURCHASED_CREDIT_TTL_MS = 365 * DAY_MS
const r6 = (n: number) => Math.round(n * 1e6) / 1e6

/* Alfabet Crockford: generate hanya memakai karakter tanpa ambiguitas
   (tanpa 0/O/1/I/L/U). Kode manual boleh mengandung 0/1/O/I/L — saat
   dicari, O dinormalisasi ke 0 dan I/L ke 1 (dekode Crockford), jadi
   pengguna yang salah ketik huruf mirip tetap menemukan kodenya. */
export const REDEEM_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'
const REDEEM_NORM_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function normalizeRedeemCode(input: string): string {
  return String(input ?? '')
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
}

export function isValidRedeemCodeNorm(norm: string): boolean {
  if (norm.length < 4 || norm.length > 32) return false
  for (const ch of norm) if (!REDEEM_NORM_ALPHABET.includes(ch)) return false
  return true
}

/* CLIDI-XXXX-XXXX-XXXX — 12 karakter acak dari alfabet di atas. */
export function generateRedeemCode(): string {
  const pick = () => {
    let out = ''
    for (let i = 0; i < 12; i++) out += REDEEM_ALPHABET[randomInt(REDEEM_ALPHABET.length)]
    return out
  }
  const raw = pick()
  return `CLIDI-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`
}

export type RedeemCodeRow = {
  id: string
  code: string
  code_norm: string
  credits: number
  max_uses: number
  uses: number
  per_user_limit: number
  expires_at: number | null
  active: number
  allowed_user_ids: string
  created_by: string
  note: string
  created_at: number
}

export type RedeemCodePublic = {
  id: string
  code: string
  credits: number
  maxUses: number
  uses: number
  redeemed: number
  perUserLimit: number
  expiresAt: number | null
  active: boolean
  allowedUserIds: string[]
  allowedUsers: { id: string; email: string }[]
  createdBy: string
  note: string
  createdAt: number
}

function toPublic(row: RedeemCodeRow & { redeemed?: number }): RedeemCodePublic {
  let allowedUserIds: string[] = []
  try {
    const parsed: unknown = JSON.parse(row.allowed_user_ids || '[]')
    if (Array.isArray(parsed)) allowedUserIds = parsed.filter((x): x is string => typeof x === 'string')
  } catch {
    allowedUserIds = []
  }
  const allowedUsers =
    allowedUserIds.length > 0
      ? (db
          .prepare(`SELECT id, email FROM users WHERE id IN (${allowedUserIds.map(() => '?').join(',')})`)
          .all(...allowedUserIds) as { id: string; email: string }[])
      : []
  return {
    id: row.id,
    code: row.code,
    credits: row.credits,
    maxUses: row.max_uses,
    uses: row.uses,
    redeemed: row.redeemed ?? row.uses,
    perUserLimit: row.per_user_limit,
    expiresAt: row.expires_at,
    active: row.active === 1,
    allowedUserIds,
    allowedUsers,
    createdBy: row.created_by,
    note: row.note,
    createdAt: row.created_at,
  }
}

export function listRedeemCodes(): RedeemCodePublic[] {
  const rows = db
    .prepare(
      `SELECT rc.*, (SELECT COUNT(*) FROM redeem_redemptions rr WHERE rr.code_id = rc.id) AS redeemed
       FROM redeem_codes rc ORDER BY rc.created_at DESC, rc.id DESC`,
    )
    .all() as (RedeemCodeRow & { redeemed: number })[]
  return rows.map(toPublic)
}

export function getRedeemCode(id: string): RedeemCodePublic | undefined {
  const row = db.prepare(`SELECT * FROM redeem_codes WHERE id = ?`).get(id) as RedeemCodeRow | undefined
  if (!row) return undefined
  const redeemed = (
    db.prepare(`SELECT COUNT(*) AS n FROM redeem_redemptions WHERE code_id = ?`).get(id) as { n: number }
  ).n
  return toPublic({ ...row, redeemed })
}

export type CreateRedeemInput = {
  code?: string
  credits: number
  maxUses?: number
  perUserLimit?: number
  expiresAt?: number | null
  allowedUserIds?: string[]
  note?: string
}

export function createRedeemCode(input: CreateRedeemInput, createdBy: string): RedeemCodePublic {
  const credits = r6(Number(input.credits))
  if (!Number.isFinite(credits) || credits <= 0) throw new Error('Jumlah credit wajib lebih dari 0.')
  if (credits > 1_000_000) throw new Error('Jumlah credit terlalu besar.')
  const maxUses = input.maxUses === undefined ? 1 : Math.floor(Number(input.maxUses))
  if (!Number.isFinite(maxUses) || maxUses < 1) throw new Error('Maks. pemakaian wajib minimal 1.')
  if (maxUses > 1_000_000) throw new Error('Maks. pemakaian terlalu besar.')
  const perUserLimit = Math.min(
    input.perUserLimit === undefined ? 1 : Math.floor(Number(input.perUserLimit)),
    maxUses,
  )
  if (!Number.isFinite(perUserLimit) || perUserLimit < 1) throw new Error('Batas per user wajib minimal 1.')
  const expiresAt = input.expiresAt ?? null
  if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) {
    throw new Error('Tanggal kedaluwarsa harus di masa depan.')
  }
  const allowedUserIds = Array.isArray(input.allowedUserIds) ? [...new Set(input.allowedUserIds)] : []
  for (const uid of allowedUserIds) {
    const exists = db.prepare(`SELECT 1 AS ok FROM users WHERE id = ?`).get(uid)
    if (!exists) throw new Error(`Pengguna tidak ditemukan: ${uid}`)
  }
  const note = String(input.note ?? '').trim().slice(0, 200)

  let code = String(input.code ?? '').trim()
  let norm = code ? normalizeRedeemCode(code) : ''
  if (code) {
    if (!isValidRedeemCodeNorm(norm)) {
      throw new Error('Kode hanya boleh berisi huruf/angka (A–Z, 0–9) dan tanda hubung, panjang 4–32 karakter.')
    }
    /* Tampilkan kode seperti yang diketik admin (huruf besar); yang
       dinormalisasi (O→0, I/L→1) hanya code_norm untuk pencarian. */
    code = code.toUpperCase()
  } else {
    /* Generate sampai dapat yang belum dipakai (tabrakan praktis tidak
       mungkin, tapi tetap dijaga loop-nya). */
    for (let attempt = 0; attempt < 10; attempt++) {
      const candidate = generateRedeemCode()
      const clash = db
        .prepare(`SELECT 1 AS ok FROM redeem_codes WHERE code_norm = ?`)
        .get(normalizeRedeemCode(candidate))
      if (!clash) {
        code = candidate
        norm = normalizeRedeemCode(candidate)
        break
      }
    }
    if (!norm) throw new Error('Gagal membuat kode unik, coba lagi.')
  }
  const clash = db.prepare(`SELECT 1 AS ok FROM redeem_codes WHERE code_norm = ?`).get(norm)
  if (clash) throw new Error('Kode sudah dipakai, pilih kode lain.')

  const now = Date.now()
  const id = `rc_${randomBytes(9).toString('hex')}`
  db.prepare(
    `INSERT INTO redeem_codes (id, code, code_norm, credits, max_uses, uses, per_user_limit, expires_at, active, allowed_user_ids, created_by, note, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, 1, ?, ?, ?, ?)`,
  ).run(id, code, norm, credits, maxUses, perUserLimit, expiresAt, JSON.stringify(allowedUserIds), createdBy, note, now)
  const created = getRedeemCode(id)
  if (!created) throw new Error('Kode gagal dibuat.')
  return created
}

export function deactivateRedeemCode(id: string): boolean {
  const r = db.prepare(`UPDATE redeem_codes SET active = 0 WHERE id = ? AND active = 1`).run(id)
  return Number(r.changes ?? 0) > 0
}

export function listRedemptions(codeId?: string, limit = 50): {
  id: number
  codeId: string
  code: string
  userId: string
  email: string | null
  credits: number
  createdAt: number
}[] {
  const rows = db
    .prepare(
      `SELECT rr.id, rr.code_id AS codeId, rc.code AS code, rr.user_id AS userId, u.email AS email,
              rr.credits, rr.created_at AS createdAt
       FROM redeem_redemptions rr
       JOIN redeem_codes rc ON rc.id = rr.code_id
       LEFT JOIN users u ON u.id = rr.user_id
       WHERE (? IS NULL OR rr.code_id = ?)
       ORDER BY rr.created_at DESC, rr.id DESC LIMIT ?`,
    )
    .all(codeId ?? null, codeId ?? null, Math.max(1, Math.min(200, Math.floor(limit)))) as {
    id: number
    codeId: string
    code: string
    userId: string
    email: string | null
    credits: number
    createdAt: number
  }[]
  return rows
}

type CreditRow = {
  user_id: string
  free_balance: number
  free_expires_at: number | null
  purchased_balance: number
  purchased_expires_at: number | null
  plan_credits: number
  plan_credits_expires_at: number | null
  plan_credits_reset_at: number | null
}

/* Tukar kode menjadi credit. SEMUA kegagalan validasi memakai pesan generik
   yang sama — pemanggil (route) tidak membedakan alasannya. Satu-satunya
   pengecualian: pengguna belum punya baris saldo (tidak seharusnya terjadi
   karena welcome grant, tapi jangan 500 mentah). */
export function redeemCodeForUser(
  userId: string,
  rawCode: string,
): { credits: number; balance: Balance; code: string } {
  const norm = normalizeRedeemCode(rawCode)
  if (!norm) throw new Error(REDEEM_GENERIC_ERROR)
  const now = Date.now()
  db.exec('BEGIN IMMEDIATE')
  try {
    const code = db.prepare(`SELECT * FROM redeem_codes WHERE code_norm = ?`).get(norm) as RedeemCodeRow | undefined
    if (!code || code.active !== 1) throw new Error(REDEEM_GENERIC_ERROR)
    if (code.expires_at !== null && code.expires_at <= now) throw new Error(REDEEM_GENERIC_ERROR)
    if (code.uses >= code.max_uses) throw new Error(REDEEM_GENERIC_ERROR)
    let allowedUserIds: string[] = []
    try {
      const parsed: unknown = JSON.parse(code.allowed_user_ids || '[]')
      if (Array.isArray(parsed)) allowedUserIds = parsed.filter((x): x is string => typeof x === 'string')
    } catch {
      allowedUserIds = []
    }
    if (allowedUserIds.length > 0 && !allowedUserIds.includes(userId)) throw new Error(REDEEM_GENERIC_ERROR)
    const userCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM redeem_redemptions WHERE code_id = ? AND user_id = ?`).get(code.id, userId) as {
        n: number
      }
    ).n
    if (userCount >= code.per_user_limit) throw new Error(REDEEM_GENERIC_ERROR)

    const row = db.prepare(`SELECT * FROM credits WHERE user_id = ?`).get(userId) as CreditRow | undefined
    if (!row) throw new Error('Pengguna belum punya saldo credit.')
    /* Tambah ke bucket purchased (kedaluwarsa 12 bulan bila kosong/
       kedaluwarsa) — logika yang sama seperti adjustCredit positif,
       tapi di dalam transaksi ini supaya atomik dengan redemption. */
    const credits = r6(code.credits)
    const nextPurchased = r6(row.purchased_balance + credits)
    let exp = row.purchased_expires_at
    if (!exp || exp <= now) exp = now + PURCHASED_CREDIT_TTL_MS
    const freeValid = !row.free_expires_at || row.free_expires_at > now ? row.free_balance : 0
    const planValid = !row.plan_credits_expires_at || row.plan_credits_expires_at > now ? row.plan_credits : 0
    const total = r6(freeValid + nextPurchased + planValid)
    db.prepare(`UPDATE credits SET purchased_balance = ?, purchased_expires_at = ?, updated_at = ? WHERE user_id = ?`).run(
      nextPurchased,
      exp,
      now,
      userId,
    )
    db.prepare(`INSERT INTO redeem_redemptions (code_id, user_id, credits, created_at) VALUES (?, ?, ?, ?)`).run(
      code.id,
      userId,
      credits,
      now,
    )
    db.prepare(`UPDATE redeem_codes SET uses = uses + 1 WHERE id = ?`).run(code.id)
    db.prepare(
      `INSERT INTO credit_transactions (user_id, kind, bucket, amount, balance_after, reason, created_at)
       VALUES (?, 'redeem', 'purchased', ?, ?, ?, ?)`,
    ).run(userId, credits, total, `Redeem kode ${code.code}`, now)
    db.exec('COMMIT')
    return { credits, balance: getBalance(userId), code: code.code }
  } catch (e) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* abaikan */
    }
    throw e
  }
}

/* Rate-limit percobaan redeem per user (5/menit). Dipakai route supaya
   respons 429 bisa dibedakan dari kegagalan validasi kode. */
export function redeemRateLimit(userId: string): { ok: boolean; retryAfter: number } {
  return rateLimit(`redeem:${userId}`, REDEEM_RATE_LIMIT_MAX, REDEEM_RATE_LIMIT_WINDOW_MS)
}

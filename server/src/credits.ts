import { db } from './db.ts'
import { findModel, ratesForProviderModel, type ProviderModel } from './providers.ts'

/* ---- Sistem credit VibeBuilder (fase 1) ----
   1 credit = $0,001 biaya LLM. Tarif per 1 juta token diambil dari
   REGISTRY provider (server/src/providers.ts) berdasarkan pasangan
   (provider, model) — BUKAN dari nama model. Model TANPA tarif di
   registry = TIDAK BOLEH dipakai: ratesForModel() mengembalikan null
   dan priceFor()/deduct() menolak — JANGAN fallback ke tarif luna
   (sebelumnya: nama mengandung 'review' → $2,50/$15, sisanya luna
   $1/$6 — hardcode itu yang membuat model mahal bisa dipotong murah,
   diperbaiki 25 Nov 2026). Saldo boleh pecahan (REAL, tampil 1 desimal).
   Bucket free dipotong dulu (yang paling cepat kedaluwarsa), lalu
   purchased, lalu plan_credits (jatah bulanan plan — dipakai fase 4).
   Saldo TIDAK PERNAH negatif: potongan dibatasi sisa saldo,
   kekurangannya dicatat di credit_usage. */

export const CREDIT_USD = 0.001
export const FREE_GRANT_CREDITS = 100
export const FREE_GRANT_DAYS = 30
export const FREE_DAILY_CAP = 50
export const MIN_BALANCE_TO_CALL = 10
/* ---- Anti-abuse fase 5 ----
   DAILY_CAP_FREE: total credit yang boleh dipotong per pengguna per hari
   (hari lokal server) untuk plan Gratis — default 200/hari.
   DAILY_CAP_PAID: sama untuk pengguna berbayar (punya plan selain
   Gratis) — default 1.000/hari. Cap ini MEMBATASI LAJU, bukan jatah:
   saldo tetap yang membatasi total; cap hanya mencegah satu akun
   menghabiskan saldo besar dalam sehari (mis. kunci bocor / abuse).
   MAX_CALLS_PER_HOUR: maks. panggilan complete() per pengguna per jam
   bergulir — pengaman laju yang bekerja tanpa agent.ts (dihitung dari
   credit_usage). Default 120/jam ≈ 4 run penuh 30 turn per jam. */
export const DAILY_CAP_FREE = 200
export const DAILY_CAP_PAID = 1000
export const MAX_CALLS_PER_HOUR = 120

/* ---- Angka credit yang bisa diubah admin (fase 4) ----
   Disimpan di admin_settings (key credit.*); bila belum diatur dipakai
   default yang disetujui user 25 Nov 2026 di atas. Dibaca per panggilan
   supaya perubahan dari panel admin berlaku tanpa restart server. */
export type CreditSettings = {
  freeGrant: number
  freeDays: number
  freeDailyCap: number
  minBalance: number
  dailyCapFree: number
  dailyCapPaid: number
  maxCallsPerHour: number
}

function creditSettingRaw(key: string): string | undefined {
  try {
    const row = db.prepare(`SELECT value FROM admin_settings WHERE key = ?`).get(key) as { value: string } | undefined
    return row?.value
  } catch {
    return undefined
  }
}

export function getCreditSettings(): CreditSettings {
  const num = (key: string, def: number, min: number, max: number) => {
    const n = Number(creditSettingRaw(key))
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : def
  }
  return {
    freeGrant: num('credit.free_grant', FREE_GRANT_CREDITS, 0, 100000),
    freeDays: num('credit.free_days', FREE_GRANT_DAYS, 1, 3650),
    freeDailyCap: num('credit.free_daily_cap', FREE_DAILY_CAP, 0, 100000),
    minBalance: num('credit.min_balance', MIN_BALANCE_TO_CALL, 0, 100000),
    dailyCapFree: num('credit.daily_cap_free', DAILY_CAP_FREE, 0, 100000),
    dailyCapPaid: num('credit.daily_cap_paid', DAILY_CAP_PAID, 0, 100000),
    maxCallsPerHour: num('credit.max_calls_per_hour', MAX_CALLS_PER_HOUR, 0, 100000),
  }
}

/* Validasi + simpan angka credit dari panel admin. Field yang tidak
   disertakan dibiarkan apa adanya. */
export function updateCreditSettings(patch: Partial<CreditSettings>): CreditSettings {
  const cur = getCreditSettings()
  const next: CreditSettings = {
    freeGrant: patch.freeGrant !== undefined ? Math.min(100000, Math.max(0, Math.floor(Number(patch.freeGrant) || 0))) : cur.freeGrant,
    freeDays: patch.freeDays !== undefined ? Math.min(3650, Math.max(1, Math.floor(Number(patch.freeDays) || 1))) : cur.freeDays,
    freeDailyCap: patch.freeDailyCap !== undefined ? Math.min(100000, Math.max(0, Math.floor(Number(patch.freeDailyCap) || 0))) : cur.freeDailyCap,
    minBalance: patch.minBalance !== undefined ? Math.min(100000, Math.max(0, Math.floor(Number(patch.minBalance) || 0))) : cur.minBalance,
    dailyCapFree: patch.dailyCapFree !== undefined ? Math.min(100000, Math.max(0, Math.floor(Number(patch.dailyCapFree) || 0))) : cur.dailyCapFree,
    dailyCapPaid: patch.dailyCapPaid !== undefined ? Math.min(100000, Math.max(0, Math.floor(Number(patch.dailyCapPaid) || 0))) : cur.dailyCapPaid,
    maxCallsPerHour: patch.maxCallsPerHour !== undefined ? Math.min(100000, Math.max(0, Math.floor(Number(patch.maxCallsPerHour) || 0))) : cur.maxCallsPerHour,
  }
  const now = Date.now()
  const put = (key: string, v: number) =>
    db.prepare(
      `INSERT INTO admin_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(key, String(v), now)
  put('credit.free_grant', next.freeGrant)
  put('credit.free_days', next.freeDays)
  put('credit.free_daily_cap', next.freeDailyCap)
  put('credit.min_balance', next.minBalance)
  put('credit.daily_cap_free', next.dailyCapFree)
  put('credit.daily_cap_paid', next.dailyCapPaid)
  put('credit.max_calls_per_hour', next.maxCallsPerHour)
  return next
}

/* Saldo minimal untuk memanggil AI (dipakai gate di llm.ts). */
export function minBalanceToCall(): number {
  return getCreditSettings().minBalance
}

/* ---- Cap harian total + batas laju panggilan (fase 5, anti-abuse) ----
   Cap dihitung dari credit_usage yang tercatat hari itu (kolom credit =
   yang benar-benar dipotong; shortfall tidak dihitung) dengan hari lokal
   server — konsisten dengan cap harian bucket free fase 1. Cap berbayar
   berlaku untuk pengguna yang punya plan (plan_id terisi); tanpa plan
   dianggap Gratis. Nilai 0 = cap dimatikan (tanpa batas). Gate di llm.ts
   memanggil checkDailyCap/checkCallRate SEBELUM fetch LLM, jadi
   pemakaian yang melewati cap tidak pernah memanggil LLM. */

export function usedCreditToday(userId: string, now = Date.now()): number {
  try {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(credit), 0) AS used FROM credit_usage WHERE user_id = ? AND created_at >= ?`,
      )
      .get(userId, startOfToday(now)) as { used: number }
    return Math.round((row?.used ?? 0) * 1e6) / 1e6
  } catch {
    return 0
  }
}

export function dailyCapFor(userId: string): number {
  const s = getCreditSettings()
  try {
    return getUserPlan(userId).planId ? s.dailyCapPaid : s.dailyCapFree
  } catch {
    return s.dailyCapFree
  }
}

export function dailyCapError(used: number, cap: number): Error {
  const err = new Error(
    `Batas harian credit tercapai — sudah memakai ${used.toFixed(1)} dari ${cap} credit hari ini. Batas direset besok. Top up tidak menambah batas harian; hubungi admin bila butuh batas lebih tinggi.`,
  )
  ;(err as Error & { code: string }).code = 'CREDIT_LIMIT_HARIAN'
  return err
}

/* Lempar CREDIT_LIMIT_HARIAN bila pemakaian hari ini sudah mencapai cap.
   Mengembalikan sisa cap hari ini bila masih ada. */
export function checkDailyCap(userId: string): { used: number; cap: number; remaining: number } {
  const cap = dailyCapFor(userId)
  const used = usedCreditToday(userId)
  if (cap > 0 && used >= cap) throw dailyCapError(used, cap)
  return { used, cap, remaining: cap > 0 ? Math.round((cap - used) * 1e6) / 1e6 : Infinity }
}

export function callsLastHour(userId: string, now = Date.now()): number {
  try {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM credit_usage WHERE user_id = ? AND created_at >= ?`)
      .get(userId, now - 60 * 60 * 1000) as { n: number }
    return row?.n ?? 0
  } catch {
    return 0
  }
}

export function callRateError(count: number, max: number): Error {
  const err = new Error(
    `Terlalu banyak panggilan AI — ${count} panggilan dalam satu jam terakhir (maks. ${max}/jam). Tunggu sebentar lalu coba lagi.`,
  )
  ;(err as Error & { code: string }).code = 'CREDIT_LIMIT_PANGGILAN_JAM'
  return err
}

/* Lempar CREDIT_LIMIT_PANGGILAN_JAM bila panggilan dalam 1 jam terakhir
   sudah mencapai batas. Dihitung dari credit_usage (satu baris per
   panggilan complete() yang selesai dicatat) — pengaman laju yang
   sepenuhnya bekerja tanpa agent.ts. Trade-off: panggilan yang gagal
   sebelum usage tercatat (mis. LLM error tanpa usage) tidak terhitung,
   dan batas ini menghitung PANGGILAN, bukan turn agent — satu run 30
   turn memakai ~30 panggilan. */
export function checkCallRate(userId: string): { count: number; max: number } {
  const max = getCreditSettings().maxCallsPerHour
  const count = callsLastHour(userId)
  if (max > 0 && count >= max) throw callRateError(count, max)
  return { count, max }
}

export const LUNA_RATE_IN = 1
export const LUNA_RATE_OUT = 6
export const REVIEW_RATE_IN = 2.5
export const REVIEW_RATE_OUT = 15
/* Konstanta di atas dipertahankan untuk kompatibilitas (nilai seed
   registry 9router); JANGAN dipakai sebagai fallback tarif. */

const DAY_MS = 24 * 60 * 60 * 1000

/* Bulatkan ke 6 desimal supaya pecahan REAL tidak menumpuk debu float. */
const r6 = (n: number) => Math.round(n * 1e6) / 1e6

/* Tarif registry untuk satu model. provider yang diketahui dipakai
   dulu (ID model bisa sama antar provider); tanpa provider, cari di
   semua provider (9router didahulukan). null = model tidak ada di
   registry ATAU tanpa tarif → panggilan HARUS ditolak sebelum LLM
   (llm.ts/resolveProviderModel melakukan itu). TIDAK ADA fallback. */
export function ratesForModel(
  model: string,
  provider?: string,
): { rateIn: number; rateOut: number } | null {
  if (provider) return ratesForProviderModel(provider, model)
  const found = findModel(model)
  if (!found) return null
  const m: ProviderModel = found.model
  if (m.rateInUsdPer1M === null || m.rateOutUsdPer1M === null) return null
  return { rateIn: m.rateInUsdPer1M, rateOut: m.rateOutUsdPer1M }
}

export function noRateError(model: string): Error {
  const err = new Error(
    `Model tanpa tarif — ${model} belum punya harga per token di registry provider, jadi belum bisa dipakai. Admin harus mengisi tarifnya dulu.`,
  )
  ;(err as Error & { code: string }).code = 'MODEL_TANPA_TARIF'
  return err
}

export function priceFor(
  model: string,
  promptTokens: number,
  completionTokens: number,
  provider?: string,
): { rateIn: number; rateOut: number; costUsd: number; credit: number } {
  const rates = ratesForModel(model, provider)
  if (!rates) throw noRateError(model)
  const { rateIn, rateOut } = rates
  const costUsd = (promptTokens * rateIn + completionTokens * rateOut) / 1_000_000
  return { rateIn, rateOut, costUsd, credit: costUsd / CREDIT_USD }
}

export type Balance = {
  total: number
  free: number
  purchased: number
  plan: number
  freeExpiresAt: number | null
  purchasedExpiresAt: number | null
  planExpiresAt: number | null
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

function rowToBalance(row: CreditRow | undefined, now: number): Balance {
  const free = row && (!row.free_expires_at || row.free_expires_at > now) ? row.free_balance : 0
  const purchased =
    row && (!row.purchased_expires_at || row.purchased_expires_at > now) ? row.purchased_balance : 0
  const plan = row && (!row.plan_credits_expires_at || row.plan_credits_expires_at > now) ? row.plan_credits : 0
  return {
    total: r6(free + purchased + plan),
    free: r6(free),
    purchased: r6(purchased),
    plan: r6(plan),
    freeExpiresAt: row?.free_expires_at ?? null,
    purchasedExpiresAt: row?.purchased_expires_at ?? null,
    planExpiresAt: row?.plan_credits_expires_at ?? null,
  }
}

/* ---- Jatah bulanan plan (fase 4, hybrid) ----
   Gratis Rp0/bln = 100 credit/bln; Pro Rp49.000/bln = 2.000 credit/bln.
   Jatah disimpan di kolom plan_credits + plan_credits_reset_at (fase 1)
   dan diisi ulang secara MALAS: saat getBalance/deduct, bila bulan
   berjalan sudah lewat reset_at, plan_credits diganti penuh dengan jatah
   plan yang sedang dipakai user dan reset_at dimajukan ke awal bulan
   berikutnya (UTC). Sisa bulan lalu HANGUS — jatah TIDAK menumpuk.
   plan_credits_expires_at = reset_at, jadi jatah bulan berjalan ikut
   kedaluwarsa bersama periodenya. Pengguna tanpa plan dianggap Gratis.
   Bila admin mengganti plan pengguna, reset_at dinolkan (di admin.ts)
   supaya jatah plan baru langsung masuk pada pemakaian saldo berikutnya. */

export type UserPlan = { planId: string | null; planName: string; monthlyCredits: number }

export function getUserPlan(userId: string): UserPlan {
  try {
    const assigned = db
      .prepare(
        `SELECT p.id AS plan_id, p.name AS plan_name, COALESCE(p.monthly_credits, 0) AS monthly_credits
         FROM user_plans up JOIN plans p ON p.id = up.plan_id WHERE up.user_id = ?`,
      )
      .get(userId) as { plan_id: string; plan_name: string; monthly_credits: number } | undefined
    if (assigned) return { planId: assigned.plan_id, planName: assigned.plan_name, monthlyCredits: assigned.monthly_credits }
    const gratis = db.prepare(`SELECT COALESCE(monthly_credits, 0) AS monthly_credits FROM plans WHERE id = 'gratis'`).get() as
      | { monthly_credits: number }
      | undefined
    return { planId: null, planName: 'Gratis', monthlyCredits: gratis?.monthly_credits ?? FREE_GRANT_CREDITS }
  } catch {
    return { planId: null, planName: 'Gratis', monthlyCredits: FREE_GRANT_CREDITS }
  }
}

/* Awal bulan kalender berikutnya (UTC) — batas periode jatah. */
export function nextMonthStart(now: number): number {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
}

/* Isi ulang jatah bila periode sudah lewat. Mengembalikan true bila ada
   pengisian (atau reset_at dimajukan). Aman dipanggil berulang. */
export function refillPlanCredits(userId: string): boolean {
  const now = Date.now()
  const plan = getUserPlan(userId)
  const nextReset = nextMonthStart(now)
  db.exec('BEGIN IMMEDIATE')
  try {
    let row = db.prepare(`SELECT * FROM credits WHERE user_id = ?`).get(userId) as CreditRow | undefined
    if (!row) {
      if (!userExists(userId)) {
        db.exec('COMMIT')
        return false
      }
      db.prepare(
        `INSERT INTO credits (user_id, free_balance, purchased_balance, plan_credits, created_at, updated_at)
         VALUES (?, 0, 0, 0, ?, ?)`,
      ).run(userId, now, now)
      row = db.prepare(`SELECT * FROM credits WHERE user_id = ?`).get(userId) as CreditRow
    }
    if (row.plan_credits_reset_at !== null && row.plan_credits_reset_at > now) {
      db.exec('COMMIT')
      return false
    }
    /* Bucket kedaluwarsa dinolkan (konsisten dengan deduct). */
    const freeValid = !row.free_expires_at || row.free_expires_at > now ? row.free_balance : 0
    const purchasedValid = !row.purchased_expires_at || row.purchased_expires_at > now ? row.purchased_balance : 0
    const allowance = r6(plan.monthlyCredits)
    const balanceAfter = r6(freeValid + purchasedValid + allowance)
    db.prepare(
      `UPDATE credits SET free_balance = ?, free_expires_at = ?, purchased_balance = ?, purchased_expires_at = ?,
       plan_credits = ?, plan_credits_expires_at = ?, plan_credits_reset_at = ?, updated_at = ? WHERE user_id = ?`,
    ).run(
      freeValid,
      row.free_expires_at && row.free_expires_at > now ? row.free_expires_at : null,
      purchasedValid,
      row.purchased_expires_at && row.purchased_expires_at > now ? row.purchased_expires_at : null,
      allowance,
      allowance > 0 ? nextReset : null,
      nextReset,
      now,
      userId,
    )
    if (allowance > 0) {
      const d = new Date(now)
      const label = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
      db.prepare(
        `INSERT INTO credit_transactions (user_id, kind, bucket, amount, balance_after, reason, created_at)
         VALUES (?, 'plan_refill', 'plan', ?, ?, ?, ?)`,
      ).run(userId, allowance, balanceAfter, `Jatah bulanan plan ${plan.planName} (${label}): ${allowance} credit`, now)
    }
    db.exec('COMMIT')
    return true
  } catch (e) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* abaikan */
    }
    throw e
  }
}

export function getBalance(userId: string): Balance {
  maybeMigrate()
  try {
    refillPlanCredits(userId)
  } catch (e) {
    console.error(`[credits] refill jatah gagal untuk ${userId}:`, (e as Error).message)
  }
  const row = db.prepare(`SELECT * FROM credits WHERE user_id = ?`).get(userId) as CreditRow | undefined
  return rowToBalance(row, Date.now())
}

/* ---- Credit gratis 100 (30 hari) untuk pengguna baru + migrasi sekali ----
   Pemberian hanya terjadi bila pengguna BELUM punya baris credits, jadi
   aman dipanggil berulang / tiap restart server. insertWelcomeGrantIfAbsent
   TIDAK mengelola transaksi sendiri: panggil di dalam transaksi pemanggil
   (dipakai createUser agar user + credit lahir atomik). */

export function insertWelcomeGrantIfAbsent(userId: string, now: number): boolean {
  const s = getCreditSettings()
  const r = db
    .prepare(
      `INSERT INTO credits (user_id, free_balance, free_expires_at, purchased_balance, plan_credits, created_at, updated_at)
       SELECT ?, ?, ?, 0, 0, ?, ? WHERE NOT EXISTS (SELECT 1 FROM credits WHERE user_id = ?)`,
    )
    .run(userId, s.freeGrant, now + s.freeDays * DAY_MS, now, now, userId)
  if (Number(r.changes ?? 0) === 0) return false
  db.prepare(
    `INSERT INTO credit_transactions (user_id, kind, bucket, amount, balance_after, reason, created_at)
     VALUES (?, 'grant_free', 'free', ?, ?, ?, ?)`,
  ).run(
    userId,
    s.freeGrant,
    s.freeGrant,
    `Credit gratis pengguna baru (${s.freeGrant} credit, ${s.freeDays} hari)`,
    now,
  )
  return true
}

/* Pemberian mandiri (di luar createUser): satu transaksi sendiri. */
export function grantWelcomeCredit(userId: string): boolean {
  db.exec('BEGIN IMMEDIATE')
  try {
    const ok = insertWelcomeGrantIfAbsent(userId, Date.now())
    db.exec('COMMIT')
    return ok
  } catch (e) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* abaikan */
    }
    throw e
  }
}

/* ---- Penyesuaian manual admin (fase 4) ----
   Tambah/kurangi/cabut credit per bucket. Tiap penyesuaian TERCATAT ke
   credit_transactions (kind 'adjust'); log audit ditulis pemanggil
   (admin.ts, logAdmin). Saldo TIDAK PERNAH negatif: pengurangan melebihi
   sisa bucket ditolak (bukan dijepit diam-diam). Menambah ke bucket yang
   kedaluwarsa/kosong memberi masa berlaku baru: free = freeDays dari
   pengaturan, purchased = 12 bulan, plan = sampai reset bulanan. */
export function adjustCredit(
  userId: string,
  bucket: 'free' | 'purchased' | 'plan',
  amount: number,
  reason: string,
): { balance: Balance; applied: number } {
  if (!userExists(userId)) throw new Error('Pengguna tidak ditemukan.')
  if (!Number.isFinite(amount) || amount === 0) throw new Error('Jumlah penyesuaian wajib bukan nol.')
  amount = r6(amount)
  if (Math.abs(amount) > 1_000_000) throw new Error('Jumlah penyesuaian terlalu besar.')
  refillPlanCredits(userId)
  const now = Date.now()
  const s = getCreditSettings()
  db.exec('BEGIN IMMEDIATE')
  try {
    const row = db.prepare(`SELECT * FROM credits WHERE user_id = ?`).get(userId) as CreditRow | undefined
    if (!row) throw new Error('Pengguna belum punya saldo credit.')
    const bal = rowToBalance(row, now)
    const cur = bucket === 'free' ? bal.free : bucket === 'purchased' ? bal.purchased : bal.plan
    if (amount < 0 && -amount > cur) {
      throw new Error(`Saldo bucket ${bucket} hanya ${cur} credit — tidak bisa dikurangi ${-amount}.`)
    }
    const next = r6(cur + amount)
    const total = r6(bal.total + amount)
    const col = bucket === 'free' ? 'free_balance' : bucket === 'purchased' ? 'purchased_balance' : 'plan_credits'
    const expCol =
      bucket === 'free' ? 'free_expires_at' : bucket === 'purchased' ? 'purchased_expires_at' : 'plan_credits_expires_at'
    let exp: number | null =
      bucket === 'free' ? row.free_expires_at : bucket === 'purchased' ? row.purchased_expires_at : row.plan_credits_expires_at
    if (amount > 0 && (!exp || exp <= now)) {
      exp = bucket === 'free' ? now + s.freeDays * DAY_MS : bucket === 'purchased' ? now + 365 * DAY_MS : (row.plan_credits_reset_at ?? nextMonthStart(now))
    }
    if (next <= 0) exp = null
    db.prepare(`UPDATE credits SET ${col} = ?, ${expCol} = ?, updated_at = ? WHERE user_id = ?`).run(next, exp, now, userId)
    db.prepare(
      `INSERT INTO credit_transactions (user_id, kind, bucket, amount, balance_after, reason, created_at)
       VALUES (?, 'adjust', ?, ?, ?, ?, ?)`,
    ).run(userId, bucket, amount, total, reason.slice(0, 200), now)
    db.exec('COMMIT')
    return { balance: getBalance(userId), applied: amount }
  } catch (e) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* abaikan */
    }
    throw e
  }
}
let migrated = false

export function migrateWelcomeCredits(): number {
  if (migrated) return 0
  try {
    const users = db
      .prepare(`SELECT u.id AS id FROM users u LEFT JOIN credits c ON c.user_id = u.id WHERE c.user_id IS NULL`)
      .all() as { id: string }[]
    if (!users.length) {
      migrated = true
      return 0
    }
    const now = Date.now()
    db.exec('BEGIN IMMEDIATE')
    try {
      let n = 0
      for (const u of users) if (insertWelcomeGrantIfAbsent(u.id, now)) n++
      db.exec('COMMIT')
      migrated = true
      return n
    } catch (e) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* abaikan */
      }
      throw e
    }
  } catch {
    /* Tabel users belum ada (DB baru, auth.ts belum dievaluasi) atau DB
       terkunci: biarkan percobaan malas berikutnya yang menangani. */
    return 0
  }
}

function maybeMigrate() {
  if (!migrated) migrateWelcomeCredits()
}

/* Awal hari lokal server (dipakai cap harian bucket free). */
function startOfToday(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/* Verifikasi user ada sebelum mencatat pemakaian. userById (auth.ts)
   tidak dipakai langsung di sini supaya tidak terjadi impor sirkular
   (auth.ts -> credits.ts); pemeriksaannya sama: baris di tabel users.
   Ditemukan user_id yatim di token_usage (akun sudah dihapus, baris
   pemakaian tertinggal karena tanpa FK) — credit_usage dan
   credit_transactions TIDAK BOLEH mengulanginya. */
function userExists(userId: string): boolean {
  try {
    return Boolean(db.prepare(`SELECT 1 AS ok FROM users WHERE id = ?`).get(userId))
  } catch {
    return false
  }
}

export type UsageInput = { prompt_tokens?: number; completion_tokens?: number }
export type DeductResult = {
  charged: number
  shortfall: number
  costUsd: number
  credit: number
  balance: Balance
}

/* Potong biaya SATU panggilan complete() dari saldo.
   Urutan: free (dibatasi cap 50/hari) -> purchased -> plan_credits.
   Bucket kedaluwarsa dianggap 0 dan dinolkan di DB. credit_usage +
   credit_transactions dicatat dalam SATU transaksi dengan pemotongan.
   Provider + tarif yang dipakai TERCATAT di credit_usage (kolom
   provider, rate_in, rate_out). Bila biaya melebihi sisa saldo: potong
   sisanya, catat kekurangannya (shortfall) di baris usage, saldo akhir
   0 — tidak pernah negatif. Model tanpa tarif DITOLAK di sini
   (priceFor lempar MODEL_TANPA_TARIF) — llm.ts sudah menolak lebih
   dulu sebelum panggilan, jadi ini jaring pengaman terakhir. */
export function deduct(userId: string, model: string, usage: UsageInput, provider = ''): DeductResult {
  maybeMigrate()
  const prompt = Number(usage?.prompt_tokens ?? 0)
  const completion = Number(usage?.completion_tokens ?? 0)
  const { rateIn, rateOut, costUsd, credit } = priceFor(model, prompt, completion, provider || undefined)
  const now = Date.now()

  if (credit <= 0) return { charged: 0, shortfall: 0, costUsd, credit, balance: getBalance(userId) }

  /* User tidak ada (mis. akun dihapus di tengah sesi): JANGAN catat
     pemakaian ke user tersebut — cukup log server. */
  if (!userExists(userId)) {
    console.error(`[credits] deduct dilewati: user ${userId} tidak ada (biaya ${costUsd} USD tidak dicatat)`)
    return {
      charged: 0,
      shortfall: credit,
      costUsd,
      credit,
      balance: { total: 0, free: 0, purchased: 0, plan: 0, freeExpiresAt: null, purchasedExpiresAt: null, planExpiresAt: null },
    }
  }

  /* Jatah bulanan plan diisi dulu bila periode sudah lewat, supaya
     pemotongan memakai jatah bulan berjalan. */
  try {
    refillPlanCredits(userId)
  } catch (e) {
    console.error(`[credits] refill jatah gagal untuk ${userId}:`, (e as Error).message)
  }

  db.exec('BEGIN IMMEDIATE')
  try {
    const row = db.prepare(`SELECT * FROM credits WHERE user_id = ?`).get(userId) as CreditRow | undefined
    const bal = rowToBalance(row, now)

    /* Cap harian bucket free dari pengaturan admin (default 50/hari). */
    const dailyCap = getCreditSettings().freeDailyCap
    const usedFreeToday = (
      db
        .prepare(
          `SELECT COALESCE(SUM(-amount), 0) AS used FROM credit_transactions
           WHERE user_id = ? AND bucket = 'free' AND kind = 'use' AND amount < 0 AND created_at >= ?`,
        )
        .get(userId, startOfToday(now)) as { used: number }
    ).used
    const freeAllowance = Math.max(0, dailyCap - usedFreeToday)

    let remaining = r6(credit)
    const takeFree = r6(Math.min(bal.free, freeAllowance, remaining))
    remaining = r6(remaining - takeFree)
    const takePurchased = r6(Math.min(bal.purchased, remaining))
    remaining = r6(remaining - takePurchased)
    const takePlan = r6(Math.min(bal.plan, remaining))
    remaining = r6(remaining - takePlan)
    const charged = r6(credit - remaining)
    const shortfall = r6(remaining)

    /* Simpan pemakaian (provider + tarif + cost tercatat agar repricing
       tidak menulis ulang riwayat). */
    db.prepare(
      `INSERT INTO credit_usage (user_id, model, provider, prompt_tokens, completion_tokens, rate_in, rate_out, cost_usd, credit, shortfall_credit, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(userId, model, provider, prompt, completion, rateIn, rateOut, costUsd, charged, shortfall, now)

    if (row) {
      /* Bucket kedaluwarsa dinolkan; total berjalan untuk balance_after. */
      let running = bal.total
      const takes: { bucket: string; amount: number }[] = [
        { bucket: 'free', amount: takeFree },
        { bucket: 'purchased', amount: takePurchased },
        { bucket: 'plan', amount: takePlan },
      ]
      for (const t of takes) {
        if (t.amount <= 0) continue
        running = r6(running - t.amount)
        db.prepare(
          `INSERT INTO credit_transactions (user_id, kind, bucket, amount, balance_after, reason, created_at)
           VALUES (?, 'use', ?, ?, ?, ?, ?)`,
        ).run(userId, t.bucket, -t.amount, running, `Pemakaian ${model}`, now)
      }
      db.prepare(
        `UPDATE credits SET free_balance = ?, free_expires_at = ?, purchased_balance = ?, purchased_expires_at = ?,
         plan_credits = ?, plan_credits_expires_at = ?, updated_at = ? WHERE user_id = ?`,
      ).run(
        r6(bal.free - takeFree),
        row.free_expires_at && row.free_expires_at > now ? row.free_expires_at : null,
        r6(bal.purchased - takePurchased),
        row.purchased_expires_at && row.purchased_expires_at > now ? row.purchased_expires_at : null,
        r6(bal.plan - takePlan),
        row.plan_credits_expires_at && row.plan_credits_expires_at > now ? row.plan_credits_expires_at : null,
        now,
        userId,
      )
    }

    db.exec('COMMIT')
    return { charged, shortfall, costUsd, credit, balance: getBalance(userId) }
  } catch (e) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* abaikan */
    }
    throw e
  }
}

/* Migrasi dijalankan sekali saat modul pertama dimuat (server boot).
   Best-effort: gagal (mis. tabel users belum ada di DB baru) tidak boleh
   menggagalkan boot — percobaan malas di getBalance/deduct menyusul. */
try {
  migrateWelcomeCredits()
} catch {
  /* abaikan */
}

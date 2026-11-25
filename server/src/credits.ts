import { db } from './db.ts'

/* ---- Sistem credit VibeBuilder (fase 1) ----
   1 credit = $0,001 biaya LLM. Tarif per 1 juta token:
   luna   input $1    / output $6
   review input $2,50 / output $15
   Model peninjau dikenali dari nama yang mengandung 'review'; selain itu
   tarif luna (fallback aman, juga untuk model override admin).
   Saldo boleh pecahan (REAL, tampil 1 desimal). Bucket free dipotong dulu
   (yang paling cepat kedaluwarsa), lalu purchased, lalu plan_credits
   (jatah bulanan plan — dipakai fase 4). Saldo TIDAK PERNAH negatif:
   potongan dibatasi sisa saldo, kekurangannya dicatat di credit_usage. */

export const CREDIT_USD = 0.001
export const FREE_GRANT_CREDITS = 100
export const FREE_GRANT_DAYS = 30
export const FREE_DAILY_CAP = 50
export const MIN_BALANCE_TO_CALL = 10

export const LUNA_RATE_IN = 1
export const LUNA_RATE_OUT = 6
export const REVIEW_RATE_IN = 2.5
export const REVIEW_RATE_OUT = 15

const DAY_MS = 24 * 60 * 60 * 1000

/* Bulatkan ke 6 desimal supaya pecahan REAL tidak menumpuk debu float. */
const r6 = (n: number) => Math.round(n * 1e6) / 1e6

export function ratesForModel(model: string): { rateIn: number; rateOut: number } {
  if (model.toLowerCase().includes('review')) return { rateIn: REVIEW_RATE_IN, rateOut: REVIEW_RATE_OUT }
  return { rateIn: LUNA_RATE_IN, rateOut: LUNA_RATE_OUT }
}

export function priceFor(
  model: string,
  promptTokens: number,
  completionTokens: number,
): { rateIn: number; rateOut: number; costUsd: number; credit: number } {
  const { rateIn, rateOut } = ratesForModel(model)
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

export function getBalance(userId: string): Balance {
  maybeMigrate()
  const row = db.prepare(`SELECT * FROM credits WHERE user_id = ?`).get(userId) as CreditRow | undefined
  return rowToBalance(row, Date.now())
}

/* ---- Credit gratis 100 (30 hari) untuk pengguna baru + migrasi sekali ----
   Pemberian hanya terjadi bila pengguna BELUM punya baris credits, jadi
   aman dipanggil berulang / tiap restart server. insertWelcomeGrantIfAbsent
   TIDAK mengelola transaksi sendiri: panggil di dalam transaksi pemanggil
   (dipakai createUser agar user + credit lahir atomik). */

export function insertWelcomeGrantIfAbsent(userId: string, now: number): boolean {
  const r = db
    .prepare(
      `INSERT INTO credits (user_id, free_balance, free_expires_at, purchased_balance, plan_credits, created_at, updated_at)
       SELECT ?, ?, ?, 0, 0, ?, ? WHERE NOT EXISTS (SELECT 1 FROM credits WHERE user_id = ?)`,
    )
    .run(userId, FREE_GRANT_CREDITS, now + FREE_GRANT_DAYS * DAY_MS, now, now, userId)
  if (Number(r.changes ?? 0) === 0) return false
  db.prepare(
    `INSERT INTO credit_transactions (user_id, kind, bucket, amount, balance_after, reason, created_at)
     VALUES (?, 'grant_free', 'free', ?, ?, ?, ?)`,
  ).run(
    userId,
    FREE_GRANT_CREDITS,
    FREE_GRANT_CREDITS,
    `Credit gratis pengguna baru (${FREE_GRANT_CREDITS} credit, ${FREE_GRANT_DAYS} hari)`,
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

/* Migrasi sekali: semua pengguna yang sudah ada dan belum punya baris
   credits mendapat 100 credit gratis. Dijalankan sekali per proses
   (best-effort saat modul dimuat + malas di getBalance/deduct, supaya
   urutan import — tabel users dibuat di auth.ts — tidak jadi masalah). */
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
   Bila biaya melebihi sisa saldo: potong sisanya, catat kekurangannya
   (shortfall) di baris usage, saldo akhir 0 — tidak pernah negatif. */
export function deduct(userId: string, model: string, usage: UsageInput): DeductResult {
  maybeMigrate()
  const prompt = Number(usage?.prompt_tokens ?? 0)
  const completion = Number(usage?.completion_tokens ?? 0)
  const { rateIn, rateOut, costUsd, credit } = priceFor(model, prompt, completion)
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

  db.exec('BEGIN IMMEDIATE')
  try {
    const row = db.prepare(`SELECT * FROM credits WHERE user_id = ?`).get(userId) as CreditRow | undefined
    const bal = rowToBalance(row, now)

    /* Cap harian bucket free: maks. 50 credit/hari dari saldo gratis. */
    const usedFreeToday = (
      db
        .prepare(
          `SELECT COALESCE(SUM(-amount), 0) AS used FROM credit_transactions
           WHERE user_id = ? AND bucket = 'free' AND kind = 'use' AND amount < 0 AND created_at >= ?`,
        )
        .get(userId, startOfToday(now)) as { used: number }
    ).used
    const freeAllowance = Math.max(0, FREE_DAILY_CAP - usedFreeToday)

    let remaining = r6(credit)
    const takeFree = r6(Math.min(bal.free, freeAllowance, remaining))
    remaining = r6(remaining - takeFree)
    const takePurchased = r6(Math.min(bal.purchased, remaining))
    remaining = r6(remaining - takePurchased)
    const takePlan = r6(Math.min(bal.plan, remaining))
    remaining = r6(remaining - takePlan)
    const charged = r6(credit - remaining)
    const shortfall = r6(remaining)

    /* Simpan pemakaian (tarif + cost tercatat agar repricing tidak
       menulis ulang riwayat). */
    db.prepare(
      `INSERT INTO credit_usage (user_id, model, prompt_tokens, completion_tokens, rate_in, rate_out, cost_usd, credit, shortfall_credit, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(userId, model, prompt, completion, rateIn, rateOut, costUsd, charged, shortfall, now)

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

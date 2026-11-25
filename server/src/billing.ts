import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Hono } from 'hono'
import { db } from './db.ts'
import { getBalance } from './credits.ts'
import { adminSetting } from './llm.ts'
import { SESSION_COOKIE, readCookie, userByToken, type User } from './auth.ts'

/* ---- Top-up credit VibeBuilder (fase 2) ----
   Paket disetujui user 25 Nov 2026. 1 credit = $0,001 biaya LLM.
   Alur: pengguna pilih paket -> server buat order TOP-... -> gateway
   Clipku Pay (m.clipku.com) membuat QRIS -> pengguna bayar -> gateway
   memanggil webhook -> server VERIFIKASI ULANG status ke provider
   (sumber kebenaran) lalu mengkredit purchased_balance dalam satu
   transaksi. Idempotensi dua lapis: guard status order + UNIQUE
   (user_id, order_id) di credit_transactions.

   Kontrak gateway (dari service referensi NEXORA/DuitUsaha — baca-saja):
   POST/GET https://m.clipku.com/api/?action=<action>, auth
   "Authorization: Bearer <key>", respons dibungkus { data: {...} }.
   create_transaction { order_id, amount, payment_channel: "qris",
   webhook_url? } -> data.qr_url (string payload QR EMV, BUKAN URL
   gambar), data.payment_url, data.status, data.amount.
   get_transaction?order_id=... -> data.status / data.amount / paid_at.

   KEJUJURAN VERIFIKASI WEBHOOK: service referensi TIDAK menemukan
   skema signature resmi dari Clipkupay — webhook-nya di referensi
   justru tidak memeriksa signature sama sekali dan menganggap
   verifikasi ulang ke provider sebagai satu-satunya sumber kebenaran.
   Modul ini memakai dua lapis yang sama seperti NEXORA:
    1. Bila webhook secret dikonfigurasi: header
       x-clipkupay-signature WAJIB lolos HMAC-SHA256(raw body, secret)
       — gagal = 401, tanpa mengubah apa pun (fail-closed).
       Bila secret BELUM dikonfigurasi, lapis ini nonaktif dan
       verifikasi provider yang menjadi gerbang (jangan isi secret
       sebelum terbukti gateway mengirim header tersebut).
    2. SELALU: verifikasi ulang status ke provider via get_transaction.
       Hanya status lunas terverifikasi yang mengkredit. Tanpa API key,
       webhook tidak pernah mengkredit apa pun.
   Kredensial TIDAK PERNAH dilog, dikembalikan ke frontend, atau masuk
   commit. Sumber: env VB_CLIPKUPAY_API_KEY / VB_CLIPKUPAY_WEBHOOK_SECRET
   (utama, di /etc/vibebuilder/env pada live) atau admin_settings
   clipkupay.api_key / clipkupay.webhook_secret (diatur admin dari
   PUT /api/admin/billing). VB_CLIPKUPAY_BASE_URL hanya untuk stub tes. */

export const PACKAGES = [
  { id: 'p10', amountIdr: 10000, credits: 350 },
  { id: 'p25', amountIdr: 25000, credits: 1000 },
  { id: 'p100', amountIdr: 100000, credits: 4200 },
  { id: 'p220', amountIdr: 220000, credits: 10000 },
] as const

export type PackageId = (typeof PACKAGES)[number]['id']

export function packageById(id: string) {
  return PACKAGES.find((p) => p.id === id)
}

/* Credit dibeli kedaluwarsa 12 bulan sejak pembayaran. */
export const PURCHASED_CREDIT_TTL_MS = 365 * 24 * 60 * 60 * 1000
/* Bila gateway tidak memberi masa berlaku QRIS, order lokal
   kedaluwarsa 30 menit (QRIS dinamis umumnya berumur pendek). */
export const ORDER_TTL_MS = 30 * 60 * 1000

const DAY_MS = 24 * 60 * 60 * 1000
const r6 = (n: number) => Math.round(n * 1e6) / 1e6

type BillingEnv = { Variables: { user: User } }

/* ---- Konfigurasi gateway ---- */

export function clipkupayConfig() {
  return {
    apiKey: (process.env.VB_CLIPKUPAY_API_KEY ?? adminSetting('clipkupay.api_key') ?? '').trim(),
    webhookSecret: (process.env.VB_CLIPKUPAY_WEBHOOK_SECRET ?? adminSetting('clipkupay.webhook_secret') ?? '').trim(),
    baseUrl: (process.env.VB_CLIPKUPAY_BASE_URL ?? 'https://m.clipku.com').replace(/\/+$/, ''),
  }
}

export function publicWebhookUrl(c: { req: { url: string } }): string {
  const override = (process.env.VB_CLIPKUPAY_WEBHOOK_URL ?? '').trim()
  if (override) return override.replace(/\/+$/, '')
  return `${new URL(c.req.url).origin}/api/billing/webhook`
}

/* ---- Klien gateway (defensif: terima bungkus data.* maupun datar) ---- */

export type ClipkupayStatus = 'paid' | 'pending' | 'expired' | 'failed' | 'unknown'

export function normalizeClipkupayStatus(raw: unknown): ClipkupayStatus {
  const s = String(raw ?? '').toUpperCase()
  if (/^(PAID|SUCCESS|SETTLED|COMPLETED)$/.test(s)) return 'paid'
  if (/EXPIR/.test(s)) return 'expired'
  if (/^(FAILED|FAIL|CANCELLED|CANCELED|VOID|REFUNDED)$/.test(s)) return 'failed'
  if (/PEND/.test(s)) return 'pending'
  return 'unknown'
}

function pickFirst(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (obj[k] != null && obj[k] !== '') return obj[k]
  return null
}

function numOrNull(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function unwrapGatewayData(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object') return {}
  const b = body as Record<string, unknown>
  const resp = (b.response ?? b) as Record<string, unknown>
  if (resp && typeof resp === 'object' && resp.data && typeof resp.data === 'object' && !Array.isArray(resp.data)) {
    return resp.data as Record<string, unknown>
  }
  return resp
}

/* Masa berlaku QRIS dari gateway: ISO string atau epoch (detik/ms). */
function parseGatewayExpiry(d: Record<string, unknown>): number | null {
  const raw = pickFirst(d, ['expires_at', 'expired_at', 'valid_until', 'expiry', 'expiresAt'])
  if (raw == null) return null
  if (typeof raw === 'number') return raw > 1e12 ? raw : raw > 1e9 ? raw * 1000 : raw
  const t = Date.parse(String(raw))
  return Number.isFinite(t) ? t : null
}

async function gatewayCall(
  method: string,
  action: string,
  apiKey: string,
  baseUrl: string,
  query = '',
  body: unknown = null,
): Promise<Record<string, unknown>> {
  let res: Response
  try {
    res = await fetch(`${baseUrl}/api/?action=${action}${query}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Authorization: `Bearer ${apiKey}`,
      },
      body: body !== null ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    })
  } catch (e) {
    throw new Error(`Clipku Pay tidak terjangkau (${action}): ${(e as Error).message}`)
  }
  let parsed: unknown = null
  try {
    parsed = await res.json()
  } catch {
    parsed = null
  }
  if (!res.ok) {
    const msg =
      parsed && typeof parsed === 'object'
        ? String(
            (parsed as Record<string, unknown>).message ??
              (parsed as Record<string, unknown>).error ??
              `HTTP ${res.status}`,
          )
        : `HTTP ${res.status}`
    const err = new Error(`Clipku Pay ${action} gagal (HTTP ${res.status}): ${msg}`)
    ;(err as Error & { httpStatus?: number }).httpStatus = res.status
    throw err
  }
  if (!parsed || typeof parsed !== 'object') throw new Error(`Clipku Pay ${action}: respons bukan JSON valid`)
  return parsed as Record<string, unknown>
}

export async function createQrisOnGateway(
  orderId: string,
  amountIdr: number,
  opts: { webhookUrl?: string; customerName?: string; customerEmail?: string } = {},
): Promise<{
  orderId: string
  amountIdr: number
  qrPayload: string | null
  paymentUrl: string | null
  providerStatus: ClipkupayStatus
  rawStatus: string | null
  expiresAt: number | null
}> {
  const { apiKey, baseUrl } = clipkupayConfig()
  if (!apiKey) throw new Error('Clipku Pay belum dikonfigurasi (API key kosong).')
  const body: Record<string, unknown> = {
    order_id: orderId,
    amount: Math.round(amountIdr),
    payment_channel: 'qris',
    customer_name: opts.customerName ?? '',
    customer_email: opts.customerEmail ?? '',
  }
  if (opts.webhookUrl) body.webhook_url = opts.webhookUrl
  const data = unwrapGatewayData(await gatewayCall('POST', 'create_transaction', apiKey, baseUrl, '', body))
  const rawStatus = data.status != null ? String(data.status) : null
  return {
    orderId: data.order_id != null ? String(data.order_id) : orderId,
    amountIdr: numOrNull(data.amount) ?? Math.round(amountIdr),
    qrPayload: (pickFirst(data, ['qr_url', 'qr_payload', 'qrPayload']) as string | null) ?? null,
    paymentUrl: (pickFirst(data, ['payment_url', 'paymentUrl']) as string | null) ?? null,
    providerStatus: normalizeClipkupayStatus(rawStatus),
    rawStatus,
    expiresAt: parseGatewayExpiry(data),
  }
}

export async function getStatusFromGateway(orderId: string): Promise<{
  orderId: string
  status: ClipkupayStatus
  rawStatus: string | null
  amountIdr: number | null
  paidAt: string | null
}> {
  const { apiKey, baseUrl } = clipkupayConfig()
  if (!apiKey) throw new Error('Clipku Pay belum dikonfigurasi (API key kosong).')
  const data = unwrapGatewayData(
    await gatewayCall('GET', 'get_transaction', apiKey, baseUrl, `&order_id=${encodeURIComponent(orderId)}`),
  )
  const rawStatus = data.status != null ? String(data.status) : null
  return {
    orderId: data.order_id != null ? String(data.order_id) : orderId,
    status: normalizeClipkupayStatus(rawStatus),
    rawStatus,
    amountIdr: numOrNull(data.amount),
    paidAt: (pickFirst(data, ['paid_at', 'paidAt']) as string | null) ?? null,
  }
}

/* ---- Verifikasi HMAC-SHA256 atas raw body (lapis 1 webhook) ---- */

export function verifyWebhookSignature(rawBody: Buffer, signatureHeader: string, secret: string): boolean {
  if (!rawBody || !secret) return false
  let sig = String(signatureHeader ?? '').trim()
  if (sig.toLowerCase().startsWith('sha256=')) sig = sig.slice(7)
  if (!/^[0-9a-fA-F]+$/.test(sig)) return false
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
  try {
    const a = Buffer.from(sig, 'hex')
    const b = Buffer.from(expected, 'hex')
    return a.length === b.length && timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/* ---- Order ---- */

export type CreditOrder = {
  order_id: string
  user_id: string
  package: string
  amount_idr: number
  credits: number
  status: string
  qr_payload: string | null
  payment_url: string | null
  gateway_status: string | null
  created_at: number
  paid_at: number | null
  expires_at: number
}

export function newOrderId(): string {
  return `TOP-${Date.now().toString(36).toUpperCase()}${randomBytes(3).toString('hex').toUpperCase()}`
}

/* Order pending yang lewat masa berlaku jadi expired (malas: tiap baca). */
export function sweepExpiredOrders(): number {
  const r = db
    .prepare(`UPDATE credit_orders SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?`)
    .run(Date.now())
  return Number(r.changes ?? 0)
}

export function getOrder(orderId: string): CreditOrder | undefined {
  sweepExpiredOrders()
  return db.prepare(`SELECT * FROM credit_orders WHERE order_id = ?`).get(orderId) as CreditOrder | undefined
}

export function listOrders(userId: string): CreditOrder[] {
  sweepExpiredOrders()
  return db
    .prepare(`SELECT * FROM credit_orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`)
    .all(userId) as CreditOrder[]
}

function publicOrder(o: CreditOrder) {
  return {
    orderId: o.order_id,
    package: o.package,
    amountIdr: o.amount_idr,
    credits: o.credits,
    status: o.status,
    qrPayload: o.qr_payload,
    paymentUrl: o.payment_url,
    createdAt: o.created_at,
    paidAt: o.paid_at,
    expiresAt: o.expires_at,
  }
}

function logWebhookEvent(orderId: string, event: string, signatureValid: boolean, result: string) {
  try {
    db.prepare(
      `INSERT INTO credit_webhook_events (order_id, event, signature_valid, result, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(orderId, event, signatureValid ? 1 : 0, result.slice(0, 200), Date.now())
  } catch (e) {
    console.error(`[billing] gagal mencatat webhook event: ${(e as Error).message}`)
  }
}

/* ---- Inti: kreditkan order lunas dalam SATU transaksi ----
   Dipanggil hanya setelah provider memastikan status paid + nominal cocok.
   Guard status + UNIQUE(user_id, order_id) membuat pemanggilan ganda aman:
   panggilan kedua mengembalikan duplicate:true tanpa mengubah saldo.
   Order yang sudah kedaluwarsa secara lokal TETAP dikreditkan bila provider
   memastikan uang masuk (uang sudah diterima = credit memang hak pembeli);
   order cancelled TIDAK PERNAH dikreditkan. */
export function applyPaidOrder(orderId: string): {
  ok: boolean
  duplicate?: boolean
  reason?: string
  order?: CreditOrder
  balance?: ReturnType<typeof getBalance>
} {
  const now = Date.now()
  db.exec('BEGIN IMMEDIATE')
  try {
    const order = db.prepare(`SELECT * FROM credit_orders WHERE order_id = ?`).get(orderId) as CreditOrder | undefined
    if (!order) {
      db.exec('ROLLBACK')
      return { ok: false, reason: 'order_not_found' }
    }
    if (order.status === 'paid') {
      db.exec('COMMIT')
      return { ok: true, duplicate: true, order, balance: getBalance(order.user_id) }
    }
    if (order.status === 'cancelled') {
      db.exec('ROLLBACK')
      return { ok: false, reason: 'order_cancelled' }
    }
    /* status pending / expired + provider paid -> kreditkan. */
    const row = db.prepare(`SELECT * FROM credits WHERE user_id = ?`).get(order.user_id) as
      | {
          free_balance: number
          free_expires_at: number | null
          purchased_balance: number
          purchased_expires_at: number | null
          plan_credits: number
          plan_credits_expires_at: number | null
        }
      | undefined
    if (!row) {
      /* Tidak ada baris credits (akun dihapus / belum grant): buat baris
         kosong dulu supaya INSERT transaksi punya FK yang valid. */
      db.prepare(
        `INSERT OR IGNORE INTO credits (user_id, free_balance, purchased_balance, plan_credits, created_at, updated_at)
         VALUES (?, 0, 0, 0, ?, ?)`,
      ).run(order.user_id, now, now)
    }
    const cur = row ?? {
      free_balance: 0,
      free_expires_at: null,
      purchased_balance: 0,
      purchased_expires_at: null,
      plan_credits: 0,
      plan_credits_expires_at: null,
    }
    const purchasedValid = !cur.purchased_expires_at || cur.purchased_expires_at > now ? cur.purchased_balance : 0
    const newPurchased = r6(purchasedValid + order.credits)
    const newPurchasedExpiry = Math.max(cur.purchased_expires_at ?? 0, now + PURCHASED_CREDIT_TTL_MS)
    const freeValid = !cur.free_expires_at || cur.free_expires_at > now ? cur.free_balance : 0
    const planValid = !cur.plan_credits_expires_at || cur.plan_credits_expires_at > now ? cur.plan_credits : 0
    const balanceAfter = r6(freeValid + newPurchased + planValid)

    db.prepare(
      `UPDATE credits SET purchased_balance = ?, purchased_expires_at = ?, updated_at = ? WHERE user_id = ?`,
    ).run(newPurchased, newPurchasedExpiry, now, order.user_id)
    try {
      db.prepare(
        `INSERT INTO credit_transactions (user_id, kind, bucket, amount, balance_after, reason, order_id, created_at)
         VALUES (?, 'topup', 'purchased', ?, ?, ?, ?, ?)`,
      ).run(
        order.user_id,
        order.credits,
        balanceAfter,
        `Top-up ${order.credits} credit (${order.order_id})`,
        order.order_id,
        now,
      )
    } catch (e) {
      /* UNIQUE(user_id, order_id) sudah ada = webhook ganda yang lolos
         guard status (balapan). Rollback + laporkan duplikat. */
      try {
        db.exec('ROLLBACK')
      } catch {
        /* abaikan */
      }
      console.error(`[billing] topup duplikat ditolak UNIQUE untuk ${orderId}: ${(e as Error).message}`)
      const again = db.prepare(`SELECT * FROM credit_orders WHERE order_id = ?`).get(orderId) as CreditOrder | undefined
      return { ok: true, duplicate: true, order: again, balance: getBalance(order.user_id) }
    }
    db.prepare(`UPDATE credit_orders SET status = 'paid', paid_at = ? WHERE order_id = ?`).run(now, orderId)
    db.exec('COMMIT')
    const paid = db.prepare(`SELECT * FROM credit_orders WHERE order_id = ?`).get(orderId) as CreditOrder
    return { ok: true, order: paid, balance: getBalance(order.user_id) }
  } catch (e) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* abaikan */
    }
    throw e
  }
}

/* ---- Auth lokal (disalin polanya dari app.ts; JANGAN impor app.ts) ---- */

function currentUser(c: { req: { header: (n: string) => string | undefined } }): User | undefined {
  return userByToken(readCookie(c.req.header('cookie'), SESSION_COOKIE))
}

/* Aturan admin disalin dari admin.ts (hindari impor sirkular: admin.ts
   memanggil registerBilling di bawah). Prioritas: VB_ADMIN_EMAIL, lalu
   akun pertama yang dibuat. */
function isAdminUser(user: User): boolean {
  const override = (process.env.VB_ADMIN_EMAIL ?? '').trim().toLowerCase()
  if (override) {
    const row = db.prepare(`SELECT email FROM users WHERE lower(email) = ?`).get(override) as
      | { email: string }
      | undefined
    if (row) return row.email.toLowerCase() === user.email.toLowerCase()
  }
  const first = db.prepare(`SELECT email FROM users ORDER BY created_at ASC, id ASC LIMIT 1`).get() as
    | { email: string }
    | undefined
  return !!first && first.email.toLowerCase() === user.email.toLowerCase()
}

/* ---- Halaman top-up (server-rendered, tanpa menyentuh platform/) ---- */

function topupPage(): string {
  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Top-up Credit — VibeBuilder</title>
<style>
  *{box-sizing:border-box} body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#0f172a;color:#e2e8f0}
  a{color:#93c5fd} .wrap{max-width:720px;margin:0 auto;padding:24px 16px 64px}
  h1{font-size:22px;margin:4px 0 4px} p.sub{color:#94a3b8;margin:0 0 20px}
  .card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:16px;margin-bottom:16px}
  .bal{font-size:28px;font-weight:700} .muted{color:#94a3b8;font-size:13px}
  .grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}
  @media(max-width:520px){.grid{grid-template-columns:1fr}}
  .pkg{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:16px;cursor:pointer;text-align:left;color:#e2e8f0;width:100%}
  .pkg:hover{border-color:#60a5fa} .pkg b{font-size:18px;display:block}
  .pkg .cr{font-size:22px;font-weight:700;color:#93c5fd} .pkg .per{font-size:12px;color:#94a3b8}
  button.primary{background:#2563eb;border:0;color:#fff;border-radius:8px;padding:10px 16px;cursor:pointer;font-size:15px}
  button.primary:disabled{opacity:.5;cursor:default}
  button.ghost{background:transparent;border:1px solid #475569;color:#e2e8f0;border-radius:8px;padding:8px 12px;cursor:pointer}
  .qr{text-align:center} .qr img{background:#fff;padding:8px;border-radius:8px;max-width:240px;width:100%}
  code.payload{display:block;word-break:break-all;background:#0f172a;border:1px solid #334155;border-radius:8px;padding:10px;font-size:12px;margin:10px 0}
  .pill{display:inline-block;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:600}
  .pill.pending{background:#713f12;color:#fde68a} .pill.paid{background:#14532d;color:#bbf7d0}
  .pill.expired{background:#7f1d1d;color:#fecaca} .pill.cancelled{background:#334155;color:#cbd5e1}
  table{width:100%;border-collapse:collapse;font-size:14px} td,th{padding:8px 4px;border-bottom:1px solid #334155;text-align:left}
  .err{color:#fca5a5} .ok{color:#86efac}
</style>
</head>
<body>
<div class="wrap">
  <p><a href="/">&larr; Kembali ke VibeBuilder</a></p>
  <h1>Top-up Credit</h1>
  <p class="sub">1 credit = $0,001 biaya LLM &middot; Credit dibeli berlaku 12 bulan &middot; Bayar via QRIS (Clipku Pay)</p>
  <div class="card"><div class="muted">Saldo credit kamu</div><div class="bal" id="balance">…</div><div class="muted" id="balanceDetail"></div></div>
  <div id="loginNote" class="card" style="display:none">Kamu belum masuk. <a href="/">Masuk dulu</a> untuk top-up.</div>
  <div id="main" style="display:none">
    <h2 style="font-size:16px">Pilih paket</h2>
    <div class="grid" id="packages"></div>
    <div class="card qr" id="qrCard" style="display:none">
      <h2 style="font-size:16px;text-align:left">Scan QRIS untuk membayar</h2>
      <div id="qrStatus"></div>
      <img id="qrImg" alt="Kode QRIS">
      <code class="payload" id="qrPayload"></code>
      <p><button class="ghost" id="copyBtn" type="button">Salin payload QRIS</button>
      <a id="payLink" href="#" target="_blank" rel="noopener" style="display:none"><button class="ghost" type="button">Buka halaman bayar</button></a></p>
      <p class="muted" id="qrMeta"></p>
      <p><button class="ghost" id="checkBtn" type="button">Periksa status pembayaran</button>
      <button class="ghost" id="cancelBtn" type="button">Batalkan order</button></p>
      <p id="qrMsg"></p>
    </div>
    <h2 style="font-size:16px">Riwayat top-up</h2>
    <div class="card"><table><thead><tr><th>Order</th><th>Paket</th><th>Nominal</th><th>Status</th></tr></thead><tbody id="history"><tr><td colspan="4" class="muted">Memuat…</td></tr></tbody></table></div>
  </div>
</div>
<script>
const $ = (id) => document.getElementById(id);
const fmtRp = (n) => 'Rp' + Number(n).toLocaleString('id-ID');
const fmtDate = (ms) => new Date(ms).toLocaleString('id-ID');
const PACKAGES = ${JSON.stringify(PACKAGES)};
let currentOrder = null, pollTimer = null;

async function api(path, opts) {
  const r = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts && opts.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}
function renderBalance(b) {
  $('balance').textContent = Number(b.total).toLocaleString('id-ID', { maximumFractionDigits: 1 }) + ' credit';
  $('balanceDetail').textContent = 'Gratis ' + b.free + ' · Dibeli ' + b.purchased + ' · Plan ' + b.plan +
    (b.purchasedExpiresAt ? ' · Credit dibeli kedaluwarsa ' + fmtDate(b.purchasedExpiresAt) : '');
}
async function loadBalance() {
  try {
    const j = await api('/api/billing/balance');
    renderBalance(j.balance);
    $('main').style.display = '';
    if (!j.configured) $('qrMsg') && null;
  } catch (e) {
    if (String(e.message).includes('401') || String(e.message).includes('Belum masuk')) {
      $('loginNote').style.display = '';
    } else { $('balance').textContent = 'Gagal memuat saldo'; }
  }
}
function renderHistory(orders) {
  const tb = $('history');
  if (!orders.length) { tb.innerHTML = '<tr><td colspan="4" class="muted">Belum ada top-up.</td></tr>'; return; }
  tb.innerHTML = orders.map((o) =>
    '<tr><td>' + o.orderId + '<br><span class="muted">' + fmtDate(o.createdAt) + '</span></td>' +
    '<td>' + o.credits.toLocaleString('id-ID') + ' credit</td>' +
    '<td>' + fmtRp(o.amountIdr) + '</td>' +
    '<td><span class="pill ' + o.status + '">' + o.status + '</span></td></tr>').join('');
}
async function loadHistory() {
  try { const j = await api('/api/billing/orders'); renderHistory(j.orders); } catch (e) { /* abaikan */ }
}
function showOrder(o) {
  currentOrder = o;
  $('qrCard').style.display = '';
  $('qrStatus').innerHTML = 'Order <b>' + o.orderId + '</b> · ' + fmtRp(o.amountIdr) + ' · ' + o.credits.toLocaleString('id-ID') + ' credit · <span class="pill ' + o.status + '">' + o.status + '</span>';
  if (o.qrPayload) {
    $('qrImg').src = 'https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=8&data=' + encodeURIComponent(o.qrPayload);
    $('qrImg').style.display = '';
    $('qrPayload').textContent = o.qrPayload;
    $('copyBtn').style.display = '';
  } else { $('qrImg').style.display = 'none'; $('qrPayload').textContent = ''; $('copyBtn').style.display = 'none'; }
  if (o.paymentUrl) { $('payLink').href = o.paymentUrl; $('payLink').style.display = ''; }
  else $('payLink').style.display = 'none';
  $('qrMeta').textContent = 'Berlaku sampai ' + fmtDate(o.expiresAt) + (o.status === 'pending' ? ' · Status diperbarui otomatis.' : '');
  $('qrMsg').textContent = '';
  $('checkBtn').style.display = o.status === 'pending' ? '' : 'none';
  $('cancelBtn').style.display = o.status === 'pending' ? '' : 'none';
  if (pollTimer) clearInterval(pollTimer);
  if (o.status === 'pending') pollTimer = setInterval(refreshCurrent, 5000);
}
async function refreshCurrent() {
  if (!currentOrder) return;
  try {
    const j = await api('/api/billing/orders/' + encodeURIComponent(currentOrder.orderId));
    showOrder(j.order);
    if (j.order.status === 'paid') {
      $('qrMsg').innerHTML = '<span class="ok">Pembayaran diterima — ' + j.order.credits.toLocaleString('id-ID') + ' credit masuk ke saldo kamu.</span>';
      loadBalance(); loadHistory();
    } else if (j.order.status === 'expired') {
      $('qrMsg').innerHTML = '<span class="err">Order kedaluwarsa sebelum dibayar. Buat order baru untuk top-up.</span>';
      loadHistory();
    }
  } catch (e) { /* tunggu polling berikutnya */ }
}
async function createOrder(pkgId) {
  $('qrMsg').textContent = 'Membuat order…';
  try {
    const j = await api('/api/billing/orders', { method: 'POST', body: JSON.stringify({ package: pkgId }) });
    showOrder(j.order); loadHistory();
  } catch (e) {
    $('qrMsg').innerHTML = '<span class="err">Gagal membuat order: ' + e.message + '</span>';
  }
}
$('packages').innerHTML = PACKAGES.map((p) =>
  '<button class="pkg" type="button" data-pkg="' + p.id + '"><b>' + fmtRp(p.amountIdr) + '</b>' +
  '<span class="cr">' + p.credits.toLocaleString('id-ID') + ' credit</span><br>' +
  '<span class="per">≈ Rp' + (p.amountIdr / p.credits).toLocaleString('id-ID', { maximumFractionDigits: 2 }) + ' / credit</span></button>').join('');
document.querySelectorAll('.pkg').forEach((b) => b.addEventListener('click', () => createOrder(b.dataset.pkg)));
$('copyBtn').addEventListener('click', () => {
  const t = $('qrPayload').textContent;
  if (navigator.clipboard) navigator.clipboard.writeText(t).then(() => { $('qrMsg').textContent = 'Payload disalin.'; });
});
$('checkBtn').addEventListener('click', async () => {
  if (!currentOrder) return;
  $('qrMsg').textContent = 'Memeriksa ke Clipku Pay…';
  try {
    const j = await api('/api/billing/orders/' + encodeURIComponent(currentOrder.orderId) + '/sync', { method: 'POST', body: '{}' });
    showOrder(j.order);
    $('qrMsg').textContent = j.order.status === 'paid' ? 'Pembayaran diterima.' : 'Status saat ini: ' + j.order.status + '.';
    if (j.order.status === 'paid') { loadBalance(); loadHistory(); }
  } catch (e) { $('qrMsg').innerHTML = '<span class="err">' + e.message + '</span>'; }
});
$('cancelBtn').addEventListener('click', async () => {
  if (!currentOrder) return;
  try {
    const j = await api('/api/billing/orders/' + encodeURIComponent(currentOrder.orderId) + '/cancel', { method: 'POST', body: '{}' });
    showOrder(j.order); loadHistory();
  } catch (e) { $('qrMsg').innerHTML = '<span class="err">' + e.message + '</span>'; }
});
loadBalance(); loadHistory();
</script>
</body>
</html>`
}

/* ---- Registrasi route ---- */

export function registerBilling(app: Hono<BillingEnv>) {
  /* Halaman top-up (server-rendered). */
  app.get('/topup', (c) => c.html(topupPage()))

  /* Saldo + paket + status konfigurasi (tanpa nilai rahasia apa pun). */
  app.get('/api/billing/balance', (c) => {
    const user = currentUser(c)
    if (!user) return c.json({ error: 'Belum masuk.' }, 401)
    const cfg = clipkupayConfig()
    return c.json({ balance: getBalance(user.id), packages: PACKAGES, configured: cfg.apiKey.length > 0 })
  })

  /* Buat order top-up. Paket HANYA dari daftar yang disetujui — nominal
     bebas dari client selalu ditolak. */
  app.post('/api/billing/orders', async (c) => {
    const user = currentUser(c)
    if (!user) return c.json({ error: 'Belum masuk.' }, 401)
    const body = (await c.req.json().catch(() => ({}))) as { package?: string }
    const pkg = packageById(body.package ?? '')
    if (!pkg) return c.json({ error: 'Paket tidak dikenal.' }, 400)
    const cfg = clipkupayConfig()
    if (!cfg.apiKey) return c.json({ error: 'Pembayaran belum dikonfigurasi admin.' }, 503)

    const orderId = newOrderId()
    const now = Date.now()
    const expiresAt = now + ORDER_TTL_MS
    db.prepare(
      `INSERT INTO credit_orders (order_id, user_id, package, amount_idr, credits, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).run(orderId, user.id, pkg.id, pkg.amountIdr, pkg.credits, now, expiresAt)

    let gw: Awaited<ReturnType<typeof createQrisOnGateway>>
    try {
      gw = await createQrisOnGateway(orderId, pkg.amountIdr, {
        webhookUrl: publicWebhookUrl(c),
        customerName: user.name ?? '',
        customerEmail: user.email ?? '',
      })
    } catch (e) {
      /* Gateway gagal: order lokal dihapus — pengguna tidak pernah
         melihat order setengah jadi. */
      db.prepare(`DELETE FROM credit_orders WHERE order_id = ?`).run(orderId)
      console.error(`[billing] create QRIS gagal untuk ${orderId}: ${(e as Error).message}`)
      return c.json({ error: `Gagal membuat QRIS: ${(e as Error).message}` }, 502)
    }
    if (!gw.qrPayload && !gw.paymentUrl) {
      db.prepare(`DELETE FROM credit_orders WHERE order_id = ?`).run(orderId)
      return c.json({ error: 'Gateway tidak mengembalikan QRIS maupun tautan bayar.' }, 502)
    }
    if (gw.amountIdr !== pkg.amountIdr) {
      db.prepare(`DELETE FROM credit_orders WHERE order_id = ?`).run(orderId)
      return c.json({ error: 'Nominal dari gateway tidak cocok dengan paket.' }, 502)
    }
    const finalExpiry = gw.expiresAt && gw.expiresAt > now ? gw.expiresAt : expiresAt
    db.prepare(
      `UPDATE credit_orders SET qr_payload = ?, payment_url = ?, gateway_status = ?, expires_at = ? WHERE order_id = ?`,
    ).run(gw.qrPayload, gw.paymentUrl, gw.rawStatus, finalExpiry, orderId)
    const order = db.prepare(`SELECT * FROM credit_orders WHERE order_id = ?`).get(orderId) as CreditOrder
    return c.json({ order: publicOrder(order) }, 201)
  })

  app.get('/api/billing/orders', (c) => {
    const user = currentUser(c)
    if (!user) return c.json({ error: 'Belum masuk.' }, 401)
    return c.json({ orders: listOrders(user.id).map(publicOrder) })
  })

  app.get('/api/billing/orders/:id', (c) => {
    const user = currentUser(c)
    if (!user) return c.json({ error: 'Belum masuk.' }, 401)
    const order = getOrder(c.req.param('id'))
    if (!order || order.user_id !== user.id) return c.json({ error: 'Order tidak ditemukan.' }, 404)
    return c.json({ order: publicOrder(order), balance: getBalance(user.id) })
  })

  /* Sinkronisasi manual: tanya status ke provider (tombol "Periksa
     status pembayaran" — penyelamat bila webhook terlewat). */
  app.post('/api/billing/orders/:id/sync', async (c) => {
    const user = currentUser(c)
    if (!user) return c.json({ error: 'Belum masuk.' }, 401)
    const order = getOrder(c.req.param('id'))
    if (!order || order.user_id !== user.id) return c.json({ error: 'Order tidak ditemukan.' }, 404)
    if (order.status === 'paid') return c.json({ order: publicOrder(order), balance: getBalance(user.id) })
    if (order.status === 'cancelled') return c.json({ error: 'Order sudah dibatalkan.' }, 409)
    if (!clipkupayConfig().apiKey) return c.json({ error: 'Pembayaran belum dikonfigurasi admin.' }, 503)
    let prov: Awaited<ReturnType<typeof getStatusFromGateway>>
    try {
      prov = await getStatusFromGateway(order.order_id)
    } catch (e) {
      return c.json({ error: `Gagal memeriksa ke Clipku Pay: ${(e as Error).message}` }, 502)
    }
    if (prov.status === 'paid') {
      if (prov.amountIdr !== null && prov.amountIdr !== order.amount_idr) {
        return c.json({ error: 'Nominal dari provider tidak cocok dengan order.' }, 422)
      }
      const res = applyPaidOrder(order.order_id)
      if (!res.ok) return c.json({ error: `Order tidak bisa dikreditkan: ${res.reason}` }, 422)
      return c.json({ order: publicOrder(res.order!), balance: res.balance, duplicate: res.duplicate ?? false })
    }
    if (prov.status === 'expired') {
      db.prepare(`UPDATE credit_orders SET status = 'expired' WHERE order_id = ? AND status = 'pending'`).run(
        order.order_id,
      )
    } else if (prov.status === 'failed') {
      db.prepare(`UPDATE credit_orders SET status = 'cancelled' WHERE order_id = ? AND status = 'pending'`).run(
        order.order_id,
      )
    }
    const fresh = getOrder(order.order_id)!
    return c.json({ order: publicOrder(fresh), providerStatus: prov.status, balance: getBalance(user.id) })
  })

  app.post('/api/billing/orders/:id/cancel', (c) => {
    const user = currentUser(c)
    if (!user) return c.json({ error: 'Belum masuk.' }, 401)
    const order = getOrder(c.req.param('id'))
    if (!order || order.user_id !== user.id) return c.json({ error: 'Order tidak ditemukan.' }, 404)
    if (order.status !== 'pending') return c.json({ error: `Order ${order.status} tidak bisa dibatalkan.` }, 409)
    db.prepare(`UPDATE credit_orders SET status = 'cancelled' WHERE order_id = ?`).run(order.order_id)
    return c.json({ order: publicOrder(getOrder(order.order_id)!) })
  })

  /* ---- Webhook Clipku Pay (TANPA auth sesi — yang mengesahkan adalah
     HMAC + verifikasi ulang ke provider) ---- */
  app.post('/api/billing/webhook', async (c) => {
    const rawBuf = Buffer.from(await c.req.arrayBuffer())
    let body: unknown
    try {
      body = JSON.parse(rawBuf.toString('utf8'))
    } catch {
      logWebhookEvent('', 'invalid_json', false, 'invalid_json')
      return c.json({ error: 'invalid_json' }, 400)
    }
    const b = (body ?? {}) as Record<string, unknown>
    const d =
      b.data && typeof b.data === 'object' && !Array.isArray(b.data) ? (b.data as Record<string, unknown>) : {}
    const orderId = String(pickFirst({ ...d, ...b }, ['order_id', 'orderId']) ?? '')
    if (!orderId) {
      logWebhookEvent('', 'invalid_payload', false, 'invalid_payload')
      return c.json({ error: 'invalid_payload' }, 400)
    }
    const bodyStatusRaw = (pickFirst({ ...d, ...b }, ['status', 'payment_status']) as string | null) ?? null
    const bodyAmount = numOrNull(pickFirst({ ...d, ...b }, ['amount', 'amount_idr']))
    const cfg = clipkupayConfig()

    /* Lapis 1 — HMAC (hanya bila secret dikonfigurasi). */
    let signatureValid = false
    if (cfg.webhookSecret) {
      const sig = String(c.req.header('x-clipkupay-signature') ?? '')
      signatureValid = verifyWebhookSignature(rawBuf, sig, cfg.webhookSecret)
      if (!signatureValid) {
        logWebhookEvent(orderId, 'bad_signature', false, 'invalid_signature')
        console.error(`[billing] webhook ditolak: signature salah untuk ${orderId}`)
        return c.json({ error: 'invalid_signature' }, 401)
      }
    }

    /* Order tak dikenal ditolak TANPA memanggil provider (hemat kuota). */
    const order = db.prepare(`SELECT * FROM credit_orders WHERE order_id = ?`).get(orderId) as CreditOrder | undefined
    if (!order) {
      logWebhookEvent(orderId, 'unknown_order', signatureValid, 'order_not_found')
      return c.json({ error: 'order_not_found' }, 404)
    }
    if (order.status === 'paid') {
      logWebhookEvent(orderId, 'duplicate', signatureValid, 'duplicate_paid')
      return c.json({ ok: true, duplicate: true })
    }

    /* Lapis 2 — verifikasi ulang ke provider (sumber kebenaran). */
    if (!cfg.apiKey) {
      logWebhookEvent(orderId, 'not_configured', signatureValid, 'clipkupay_not_configured')
      console.error(`[billing] webhook ${orderId} tidak dikreditkan: API key belum dikonfigurasi`)
      return c.json({ ok: true, verified: false, reason: 'clipkupay_not_configured' })
    }
    let prov: Awaited<ReturnType<typeof getStatusFromGateway>>
    try {
      prov = await getStatusFromGateway(orderId)
    } catch (e) {
      logWebhookEvent(orderId, 'verify_failed', signatureValid, 'provider_verification_failed')
      console.error(`[billing] verifikasi provider gagal untuk ${orderId}: ${(e as Error).message}`)
      return c.json({ ok: true, verified: false, reason: 'provider_verification_failed' })
    }

    if (prov.status !== 'paid') {
      /* Status non-lunas bersifat sementara: jangan kunci apa pun kecuali
         terminal (expired/failed). Webhook lunas berikutnya tetap diproses. */
      if (prov.status === 'expired') {
        db.prepare(`UPDATE credit_orders SET status = 'expired' WHERE order_id = ? AND status = 'pending'`).run(orderId)
      } else if (prov.status === 'failed') {
        db.prepare(`UPDATE credit_orders SET status = 'cancelled' WHERE order_id = ? AND status = 'pending'`).run(orderId)
      }
      logWebhookEvent(orderId, 'not_paid', signatureValid, `provider:${prov.status}`)
      return c.json({ ok: true, verified: true, status: prov.status, credited: false })
    }

    /* Nominal provider + nominal body (bila ada) harus cocok dengan order. */
    if (
      (prov.amountIdr !== null && prov.amountIdr !== order.amount_idr) ||
      (bodyAmount !== null && bodyAmount !== order.amount_idr)
    ) {
      logWebhookEvent(orderId, 'amount_mismatch', signatureValid, 'amount_mismatch')
      console.error(`[billing] webhook ${orderId} ditolak: nominal tidak cocok (body/provider vs order)`)
      return c.json({ error: 'amount_mismatch' }, 422)
    }
    void bodyStatusRaw

    const res = applyPaidOrder(orderId)
    if (!res.ok) {
      logWebhookEvent(orderId, 'apply_failed', signatureValid, res.reason ?? 'apply_failed')
      return c.json({ error: res.reason ?? 'apply_failed' }, 422)
    }
    logWebhookEvent(orderId, 'credited', signatureValid, res.duplicate ? 'duplicate' : 'credited')
    console.log(`[billing] top-up dikreditkan: ${orderId} +${order.credits} credit (user ${order.user_id})`)
    return c.json({ ok: true, credited: !res.duplicate, duplicate: res.duplicate ?? false })
  })

  /* ---- Admin: status + konfigurasi kredensial (nilai tak pernah dibalas) ---- */
  app.get('/api/admin/billing', (c) => {
    const user = currentUser(c)
    if (!user) return c.json({ error: 'Belum masuk.' }, 401)
    if (!isAdminUser(user)) return c.json({ error: 'Bukan admin.' }, 403)
    const cfg = clipkupayConfig()
    const counts = db
      .prepare(`SELECT status, COUNT(*) AS n FROM credit_orders GROUP BY status`)
      .all() as { status: string; n: number }[]
    const events = db
      .prepare(
        `SELECT order_id, event, signature_valid, result, created_at FROM credit_webhook_events ORDER BY id DESC LIMIT 20`,
      )
      .all() as { order_id: string; event: string; signature_valid: number; result: string; created_at: number }[]
    return c.json({
      configured: cfg.apiKey.length > 0,
      apiKeyFromEnv: Boolean((process.env.VB_CLIPKUPAY_API_KEY ?? '').trim()),
      hasWebhookSecret: cfg.webhookSecret.length > 0,
      webhookUrl: publicWebhookUrl(c),
      packages: PACKAGES,
      orderCounts: Object.fromEntries(counts.map((r) => [r.status, r.n])),
      recentWebhookEvents: events,
      note: 'API key + webhook secret: isi lewat env VB_CLIPKUPAY_API_KEY / VB_CLIPKUPAY_WEBHOOK_SECRET (utama) atau endpoint ini (tersimpan di admin_settings). HMAC hanya aktif bila webhook secret terisi; isi hanya bila gateway terbukti mengirim header x-clipkupay-signature.',
    })
  })

  app.put('/api/admin/billing', async (c) => {
    const user = currentUser(c)
    if (!user) return c.json({ error: 'Belum masuk.' }, 401)
    if (!isAdminUser(user)) return c.json({ error: 'Bukan admin.' }, 403)
    const body = (await c.req.json().catch(() => ({}))) as { apiKey?: string; webhookSecret?: string }
    const setOrClear = (key: string, v: unknown) => {
      if (v === undefined) return null
      if (typeof v !== 'string') return `Field ${key} harus string.`
      const s = v.trim()
      if (s === '') {
        db.prepare(`DELETE FROM admin_settings WHERE key = ?`).run(key)
        return null
      }
      if (s.length > 300) return `Field ${key} terlalu panjang.`
      db.prepare(
        `INSERT INTO admin_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(key, s, Date.now())
      return null
    }
    const err = setOrClear('clipkupay.api_key', body.apiKey) ?? setOrClear('clipkupay.webhook_secret', body.webhookSecret)
    if (err) return c.json({ error: err }, 400)
    const cfg = clipkupayConfig()
    return c.json({ ok: true, configured: cfg.apiKey.length > 0, hasWebhookSecret: cfg.webhookSecret.length > 0 })
  })
}

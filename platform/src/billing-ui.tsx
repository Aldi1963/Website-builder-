import { useEffect, useState } from 'react'
import { Icon } from './ui'
import { openTopupModal } from './topup-modal'
import type { User } from './api'

/* ---- UI credit VibeBuilder (fase 3) ----
   Chip saldo di header builder + halaman Penggunaan pengguna.
   Saldo diambil dari GET /api/billing/balance (kontrak fase 2:
   { balance: { total, free, purchased, plan, freeExpiresAt,
   purchasedExpiresAt, planExpiresAt }, packages, configured }).
   Riwayat dari GET /api/billing/usage (fase 3, server/src/billing.ts):
   { balance, usage: [{ model, promptTokens, completionTokens, credit,
   shortfallCredit, costUsd, createdAt }], orders: [...] }.
   Chip memuat ulang saldo saat event 'vb:balance-changed' diterima
   (dipicu App.tsx sesudah tiap run selesai) + tiap 30 detik. */

export type Balance = {
  total: number
  free: number
  purchased: number
  plan: number
  freeExpiresAt: number | null
  purchasedExpiresAt: number | null
  planExpiresAt: number | null
}

export type UsageRow = {
  model: string
  promptTokens: number
  completionTokens: number
  rateIn: number
  rateOut: number
  costUsd: number
  credit: number
  shortfallCredit: number
  createdAt: number
}

export type OrderRow = {
  orderId: string
  package: string
  amountIdr: number
  credits: number
  status: string
  createdAt: number
  paidAt: number | null
  expiresAt: number
}

/* Dipanggil App.tsx dari handler onDone/onError chat: saldo berkurang
   terlihat di chip tanpa refresh manual. */
export function notifyBalanceChanged() {
  window.dispatchEvent(new Event('vb:balance-changed'))
}

/* Saldo tampil 1 desimal, format id-ID: 100 -> "100,0". */
export function fmtCredit(n: number): string {
  return Number(n).toLocaleString('id-ID', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
}

const fmtRp = (n: number) => 'Rp' + Number(n).toLocaleString('id-ID')
const fmtDate = (ms: number | null) =>
  ms ? new Date(ms).toLocaleString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'
const fmtDateShort = (ms: number) =>
  new Date(ms).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) {
    let msg = `Gagal memuat (${res.status}).`
    try {
      const parsed = (await res.json()) as { error?: string }
      if (parsed?.error) msg = parsed.error
    } catch {
      /* pakai pesan default */
    }
    throw new Error(msg)
  }
  return (await res.json()) as T
}

function useBalance() {
  const [balance, setBalance] = useState<Balance | null>(null)
  const [error, setError] = useState('')
  const load = async () => {
    try {
      const j = await getJson<{ balance: Balance }>('/api/billing/balance')
      setBalance(j.balance)
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }
  useEffect(() => {
    void load()
    const onChange = () => void load()
    window.addEventListener('vb:balance-changed', onChange)
    const t = setInterval(() => void load(), 30000)
    return () => {
      window.removeEventListener('vb:balance-changed', onChange)
      clearInterval(t)
    }
  }, [])
  return { balance, error, reload: load }
}

/* Chip saldo — MENGGANTIKAN chip "N req" token server di header builder.
   Klik -> popup top-up ("popup saldo"). */
export function CreditChip() {
  const { balance, error } = useBalance()
  const low = balance !== null && balance.total < 10
  return (
    <button
      onClick={openTopupModal}
      aria-label="Saldo credit — buka top-up"
      title={error || 'Saldo credit — klik untuk top-up'}
      className={`flex h-8 items-center gap-1.5 rounded-full border px-3 text-[11.5px] font-semibold transition-opacity hover:opacity-85 max-md:h-10 ${
        low ? 'border-danger/50 bg-danger/10 text-danger' : 'border-edge bg-accent-soft text-accent'
      }`}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
        <path
          d="M12 7v10M9.5 9.5h3.5a1.75 1.75 0 0 1 0 3.5H11a1.75 1.75 0 0 0 0 3.5h3.5"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
      {balance === null ? '…' : `${fmtCredit(balance.total)} credit`}
    </button>
  )
}

/* Meter kredit ringkas (angka + progress bar 4px + Top-up) — selalu
   terlihat di sidebar supaya saldo rendah (4,7 < gate 10) tidak luput.
   Skala bar: 100 credit (jatah gratis bulanan). */
export function CreditMeter() {
  const { balance, error } = useBalance()
  const total = balance?.total ?? 0
  const pct = Math.max(0, Math.min(100, (total / 100) * 100))
  const low = balance !== null && total < 10
  return (
    <div className="border-t border-edge px-3 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-quiet">Kredit</span>
        <span className="text-[12.5px] font-semibold text-body">
          {balance === null ? '…' : `${fmtCredit(total)} credit`}
        </span>
      </div>
      <div className="vb-meter mt-2" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        <i style={{ width: `${pct}%` }} />
      </div>
      {low && balance !== null && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-danger">
          Di bawah batas minimal 10 untuk memakai AI.
        </p>
      )}
      {error && <p className="mt-1.5 text-[11px] text-quiet">{error}</p>}
      <div className="mt-2 flex gap-2">
        <button type="button" onClick={openTopupModal} className="vb-btn-primary h-8 flex-1 text-[11.5px]">
          Top-up
        </button>
        <a href="/penggunaan" className="vb-btn-ghost h-8 flex-1 text-[11.5px]">
          Penggunaan
        </a>
      </div>
    </div>
  )
}

/* Halaman Penggunaan pengguna di /penggunaan: saldo + rincian bucket,
   riwayat pemakaian per run, riwayat top-up. */
export function UsagePage({
  user,
  dark,
  onToggleTheme,
  onLogout,
  onMenu,
  navOpen,
  onCloseNav,
}: {
  user: User
  dark: boolean
  onToggleTheme: () => void
  onLogout: () => void
  onMenu: () => void
  navOpen: boolean
  onCloseNav: () => void
}) {
  const [balance, setBalance] = useState<Balance | null>(null)
  const [usage, setUsage] = useState<UsageRow[]>([])
  const [orders, setOrders] = useState<OrderRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [redeemCode, setRedeemCode] = useState('')
  const [redeemBusy, setRedeemBusy] = useState(false)
  const [redeemMsg, setRedeemMsg] = useState('')
  const [redeemMsgKind, setRedeemMsgKind] = useState<'ok' | 'err' | ''>('')

  const reloadUsage = async () => {
    try {
      const j = await getJson<{ balance: Balance; usage: UsageRow[]; orders: OrderRow[] }>('/api/billing/usage')
      setBalance(j.balance)
      setUsage(j.usage)
      setOrders(j.orders)
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }

  useEffect(() => {
    void reloadUsage().finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* Tukar kode redeem (28 Nov 2026): POST /api/redeem. Pesan gagal dari
     server sengaja generik supaya tidak bisa ditebak kode mana yang ada. */
  const submitRedeem = async (e: React.FormEvent) => {
    e.preventDefault()
    const code = redeemCode.trim()
    if (!code) return
    setRedeemBusy(true)
    setRedeemMsg('')
    try {
      const res = await fetch('/api/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      })
      const j = (await res.json().catch(() => ({}))) as { error?: string; credits?: number; balance?: Balance }
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
      setRedeemMsg(`Berhasil! +${fmtCredit(j.credits ?? 0)} credit — saldo sekarang ${fmtCredit(j.balance?.total ?? 0)} credit.`)
      setRedeemMsgKind('ok')
      setRedeemCode('')
      notifyBalanceChanged()
      await reloadUsage()
    } catch (err) {
      setRedeemMsg((err as Error).message)
      setRedeemMsgKind('err')
    } finally {
      setRedeemBusy(false)
    }
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-edge bg-surface px-4 max-md:h-12">
        <button
          onClick={onMenu}
          aria-label="Buka menu"
          className="vb-btn-ghost h-9 w-9 shrink-0 rounded-lg max-md:h-11 max-md:w-11"
        >
          <Icon name="back" size={15} />
        </button>
        <h1 className="text-[13px] font-medium text-body">Penggunaan</h1>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={onToggleTheme}
            aria-label={dark ? 'Mode terang' : 'Mode gelap'}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-edge text-quiet transition-colors hover:bg-surface-muted hover:text-body"
          >
            <Icon name={dark ? 'sun' : 'moon'} size={13} />
          </button>
          <button
            onClick={onLogout}
            className="vb-btn-ghost h-8 text-[11.5px] text-quiet"
          >
            Keluar
          </button>
        </div>
      </header>
      <div className="flex-1 overflow-y-auto">
        <div className="vb-page">
          {loading ? (
            <p className="text-[12.5px] text-quiet">Memuat…</p>
          ) : error ? (
            <p className="text-[13px] text-accent">Gagal memuat penggunaan: {error}</p>
          ) : (
            <>
              <div className="vb-card p-5">
                <p className="vb-eyebrow">Saldo credit</p>
                <p className="mt-1 font-display text-[28px] text-body">
                  {balance ? fmtCredit(balance.total) : '—'} <span className="text-[15px]">credit</span>
                </p>
                {balance && (
                  <div className="mt-2 space-y-1 text-[12.5px] text-quiet">
                    <p>
                      Gratis: <span className="text-body">{fmtCredit(balance.free)} credit</span>
                      {balance.freeExpiresAt ? ` · kedaluwarsa ${fmtDate(balance.freeExpiresAt)}` : ''}
                    </p>
                    <p>
                      Dibeli: <span className="text-body">{fmtCredit(balance.purchased)} credit</span>
                      {balance.purchasedExpiresAt ? ` · kedaluwarsa ${fmtDate(balance.purchasedExpiresAt)}` : ''}
                    </p>
                    <p>
                      Plan: <span className="text-body">{fmtCredit(balance.plan)} credit</span>
                      {balance.planExpiresAt ? ` · kedaluwarsa ${fmtDate(balance.planExpiresAt)}` : ''}
                    </p>
                    <p className="pt-1 text-[11.5px]">1 credit = $0,001 biaya LLM · Minimal 10 credit untuk memakai AI.</p>
                  </div>
                )}
                <button type="button" onClick={openTopupModal} className="vb-btn-primary mt-4 h-9">
                  Top-up credit
                </button>
              </div>

              <div className="vb-card mt-4 p-5">
                <p className="vb-eyebrow">Kode redeem</p>
                <p className="mt-1 text-[12.5px] text-quiet">Punya kode redeem? Tukar jadi credit.</p>
                <form onSubmit={submitRedeem} className="mt-3 flex gap-2">
                  <input
                    type="text"
                    className="vb-input h-9 min-w-0 flex-1 font-mono uppercase"
                    placeholder="CLIDI-XXXX-XXXX-XXXX"
                    aria-label="Kode redeem"
                    value={redeemCode}
                    maxLength={40}
                    onChange={(e) => setRedeemCode(e.target.value)}
                  />
                  <button type="submit" disabled={redeemBusy || !redeemCode.trim()} className="vb-btn-primary h-9 shrink-0">
                    {redeemBusy ? 'Menukar…' : 'Tukar'}
                  </button>
                </form>
                {redeemMsg && (
                  <p className={`mt-2 text-[12.5px] ${redeemMsgKind === 'ok' ? 'text-success' : 'text-danger'}`}>
                    {redeemMsg}
                  </p>
                )}
              </div>

              <h2 className="vb-eyebrow mt-8">Riwayat pemakaian</h2>
              {!usage.length ? (
                <p className="mt-3 text-[12.5px] text-quiet">Belum ada pemakaian tercatat.</p>
              ) : (
                <ul className="vb-card mt-3 divide-y divide-edge overflow-hidden">
                  {usage.map((u, i) => (
                    <li key={`${u.createdAt}-${i}`} className="px-4 py-3">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="min-w-0 truncate font-mono text-[12px] text-body">{u.model || '(model tidak tercatat)'}</span>
                        <span className="shrink-0 text-[12.5px] font-medium text-body">−{fmtCredit(u.credit)} credit</span>
                      </div>
                      <p className="mt-1 text-[11.5px] text-quiet">
                        {fmtDateShort(u.createdAt)} · {u.promptTokens.toLocaleString('id-ID')} in ·{' '}
                        {u.completionTokens.toLocaleString('id-ID')} out
                        {u.shortfallCredit > 0 ? ` · kekurangan ${fmtCredit(u.shortfallCredit)} credit (saldo habis di tengah jalan)` : ''}
                      </p>
                    </li>
                  ))}
                </ul>
              )}

              <h2 className="vb-eyebrow mt-8">Riwayat top-up</h2>
              {!orders.length ? (
                <p className="mt-3 text-[12.5px] text-quiet">
                  Belum ada top-up.{' '}
                  <button type="button" onClick={openTopupModal} className="cursor-pointer text-accent hover:underline">
                    Top-up pertama
                  </button>{' '}
                  lewat QRIS.
                </p>
              ) : (
                <ul className="vb-card mt-3 divide-y divide-edge overflow-hidden">
                  {orders.map((o) => (
                    <li key={o.orderId} className="px-4 py-3">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="min-w-0 truncate font-mono text-[12px] text-body">{o.orderId}</span>
                        <span className="shrink-0 text-[12.5px] font-medium text-body">
                          +{o.credits.toLocaleString('id-ID')} credit
                        </span>
                      </div>
                      <p className="mt-1 text-[11.5px] text-quiet">
                        {fmtDateShort(o.createdAt)} · {fmtRp(o.amountIdr)} ·{' '}
                        <span
                          className={
                            o.status === 'paid'
                              ? 'text-success'
                              : o.status === 'pending'
                                ? 'text-warning'
                                : 'text-quiet'
                          }
                        >
                          {o.status}
                        </span>
                        {o.paidAt ? ` · dibayar ${fmtDateShort(o.paidAt)}` : ''}
                      </p>
                    </li>
                  ))}
                </ul>
              )}

              <a href="/" className="mt-8 inline-flex h-8 items-center text-[12px] text-quiet hover:text-body">
                ← Kembali ke beranda
              </a>
            </>
          )}
        </div>
      </div>
      {navOpen && (
        <div
          onClick={onCloseNav}
          aria-hidden="true"
          className="fixed inset-0 z-20 bg-black/55 md:hidden"
        />
      )}
    </div>
  )
}

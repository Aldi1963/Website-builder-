import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon, useCopy } from './ui'

/* ---- Top-up credit sebagai POPUP (modal), bukan halaman terpisah ----
   Sebelumnya top-up adalah halaman server-rendered sendiri di GET /topup
   (server/src/billing.ts, topupPage) — pengguna keluar dari SPA untuk
   membayar. Sekarang semua pemicu (chip credit di header, tombol Top-up
   di sidebar, tombol di halaman Penggunaan, banner "credit habis" di
   chat) memanggil openTopupModal() -> event 'vb:open-topup' -> TopupModal
   yang terpasang di App.tsx membuka. GET /topup lama redirect ke /#topup dan modal
   dibuka otomatis saat SPA dimuat dengan hash itu (tautan lama/bookmark
   tetap jalan).
   Isi + alur SAMA dengan halaman lama, hanya presentasinya yang berubah:
   paket dari GET /api/billing/balance, buat order POST /api/billing/orders,
   QR dari payload (api.qrserver.com), polling GET /api/billing/orders/:id
   tiap 5 detik saat pending, tombol Periksa (POST .../sync) + Batalkan
   (POST .../cancel), riwayat dari GET /api/billing/orders. Logika
   pembayaran + API TIDAK diubah.
   Tutup: tombol X, klik backdrop, Escape. Scroll body dikunci selama
   modal terbuka dan dipulihkan saat tutup; isi modal scroll sendiri
   (max-h 90dvh). Mobile: bottom-sheet penuh-lebar; desktop: kartu
   tengah max-w 520px. Token navy + gaya Lovable, tanpa gradasi. */

export function openTopupModal() {
  window.dispatchEvent(new CustomEvent('vb:open-topup'))
}

type Balance = {
  total: number
  free: number
  purchased: number
  plan: number
  freeExpiresAt: number | null
  purchasedExpiresAt: number | null
  planExpiresAt: number | null
}

type Pkg = { id: string; amountIdr: number; credits: number }

type Order = {
  orderId: string
  package: string
  amountIdr: number
  credits: number
  status: string
  createdAt: number
  paidAt: number | null
  expiresAt: number
  qrPayload: string | null
  paymentUrl: string | null
}

const fmtCredit = (n: number) =>
  Number(n).toLocaleString('id-ID', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const fmtRp = (n: number) => 'Rp' + Number(n).toLocaleString('id-ID')
const fmtDate = (ms: number) =>
  new Date(ms).toLocaleString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })

async function apiJson<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts?.headers ?? {}) },
  })
  const j = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
  return j as T
}

function statusClass(status: string) {
  if (status === 'paid') return 'bg-success/10 text-success'
  if (status === 'pending') return 'bg-warning/10 text-warning'
  if (status === 'expired' || status === 'cancelled') return 'bg-danger/10 text-danger'
  return 'bg-surface-muted text-quiet'
}

export function TopupModal() {
  const [open, setOpen] = useState(false)
  const [balance, setBalance] = useState<Balance | null>(null)
  const [packages, setPackages] = useState<Pkg[]>([])
  const [configured, setConfigured] = useState(true)
  const [orders, setOrders] = useState<Order[]>([])
  const [current, setCurrent] = useState<Order | null>(null)
  const [msg, setMsg] = useState('')
  const [msgKind, setMsgKind] = useState<'info' | 'err' | 'ok'>('info')
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const { copied, copy } = useCopy()
  const closeRef = useRef<HTMLButtonElement>(null)
  const currentRef = useRef<Order | null>(null)

  useEffect(() => {
    currentRef.current = current
  }, [current])

  const loadBalance = useCallback(async () => {
    try {
      const j = await apiJson<{ balance: Balance; packages: Pkg[]; configured: boolean }>('/api/billing/balance')
      setBalance(j.balance)
      setPackages(j.packages)
      setConfigured(j.configured)
    } catch (e) {
      setMsg((e as Error).message)
      setMsgKind('err')
    }
  }, [])

  const loadOrders = useCallback(async () => {
    try {
      const j = await apiJson<{ orders: Order[] }>('/api/billing/orders')
      setOrders(j.orders)
      return j.orders
    } catch {
      return [] as Order[]
    }
  }, [])

  const showPaid = useCallback(async () => {
    await loadBalance()
    await loadOrders()
    window.dispatchEvent(new Event('vb:balance-changed'))
  }, [loadBalance, loadOrders])

  const refreshCurrent = useCallback(async () => {
    const prev = currentRef.current
    if (!prev) return
    try {
      const j = await apiJson<{ order: Order }>('/api/billing/orders/' + encodeURIComponent(prev.orderId))
      setCurrent(j.order)
      if (j.order.status === 'paid') {
        setMsg(`Pembayaran diterima — ${j.order.credits.toLocaleString('id-ID')} credit masuk ke saldo kamu.`)
        setMsgKind('ok')
        await showPaid()
      } else if (j.order.status === 'expired') {
        setMsg('Order kedaluwarsa sebelum dibayar. Buat order baru untuk top-up.')
        setMsgKind('err')
        await loadOrders()
      }
    } catch {
      /* tunggu polling berikutnya */
    }
  }, [loadOrders, showPaid])

  const doOpen = useCallback(async () => {
    setOpen(true)
    setLoading(true)
    setMsg('')
    setMsgKind('info')
    await loadBalance()
    const list = await loadOrders()
    /* Lanjutkan order pending terakhir bila ada — jangan buat dobel. */
    const pending = list.find((o) => o.status === 'pending')
    if (pending) setCurrent(pending)
    setLoading(false)
  }, [loadBalance, loadOrders])

  const doClose = useCallback(() => {
    setOpen(false)
    if (window.location.hash === '#topup') {
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [])

  /* Pemicu global + tautan lama /topup (redirect ke /#topup). */
  useEffect(() => {
    const onOpen = () => void doOpen()
    window.addEventListener('vb:open-topup', onOpen)
    if (window.location.hash === '#topup') void doOpen()
    return () => window.removeEventListener('vb:open-topup', onOpen)
  }, [doOpen])

  /* Escape menutup; scroll body dikunci selama modal terbuka. */
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') doClose()
    }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [open, doClose])

  /* Polling status tiap 5 detik selama order pending (seperti halaman lama). */
  useEffect(() => {
    if (!open || current?.status !== 'pending') return
    const t = setInterval(() => void refreshCurrent(), 5000)
    return () => clearInterval(t)
  }, [open, current?.status, refreshCurrent])

  const createOrder = async (pkgId: string) => {
    setCreating(true)
    setMsg('Membuat order…')
    setMsgKind('info')
    try {
      const j = await apiJson<{ order: Order }>('/api/billing/orders', {
        method: 'POST',
        body: JSON.stringify({ package: pkgId }),
      })
      setCurrent(j.order)
      setMsg('')
      await loadOrders()
    } catch (e) {
      setMsg(`Gagal membuat order: ${(e as Error).message}`)
      setMsgKind('err')
    } finally {
      setCreating(false)
    }
  }

  const checkStatus = async () => {
    if (!current || busy) return
    setBusy(true)
    setMsg('Memeriksa ke Clipku Pay…')
    setMsgKind('info')
    try {
      const j = await apiJson<{ order: Order }>(
        '/api/billing/orders/' + encodeURIComponent(current.orderId) + '/sync',
        { method: 'POST', body: '{}' },
      )
      setCurrent(j.order)
      if (j.order.status === 'paid') {
        setMsg('Pembayaran diterima.')
        setMsgKind('ok')
        await showPaid()
      } else {
        setMsg(`Status saat ini: ${j.order.status}.`)
        setMsgKind('info')
      }
    } catch (e) {
      setMsg((e as Error).message)
      setMsgKind('err')
    } finally {
      setBusy(false)
    }
  }

  const cancelOrder = async () => {
    if (!current || busy) return
    setBusy(true)
    try {
      const j = await apiJson<{ order: Order }>(
        '/api/billing/orders/' + encodeURIComponent(current.orderId) + '/cancel',
        { method: 'POST', body: '{}' },
      )
      setCurrent(j.order)
      setMsg('')
      await loadOrders()
    } catch (e) {
      setMsg((e as Error).message)
      setMsgKind('err')
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/55 sm:items-center sm:p-4"
      onClick={doClose}
      role="dialog"
      aria-modal="true"
      aria-label="Top-up credit"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="vb-enter flex max-h-[90dvh] w-full max-w-[520px] flex-col overflow-hidden rounded-t-2xl border border-edge bg-surface sm:rounded-2xl"
      >
        <div className="flex shrink-0 items-center justify-between px-4 pb-1 pt-4 sm:px-5">
          <h2 className="font-display text-[16px] text-body">Top-up Credit</h2>
          <button
            ref={closeRef}
            onClick={doClose}
            aria-label="Tutup top-up"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-quiet transition-colors hover:bg-surface-muted hover:text-body"
          >
            <Icon name="close" size={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-5 sm:px-5">
          <p className="text-[12.5px] leading-relaxed text-quiet">
            1 credit = $0,001 biaya LLM · Credit dibeli berlaku 12 bulan · Bayar via QRIS (Clipku Pay)
          </p>

          <div className="vb-card mt-3 p-4">
            <p className="vb-eyebrow">Saldo credit kamu</p>
            <p className="mt-1 font-display text-[28px] leading-tight text-body">
              {balance ? fmtCredit(balance.total) : '…'} <span className="text-[15px]">credit</span>
            </p>
            {balance && (
              <p className="mt-1 text-[12.5px] text-quiet">
                Gratis {fmtCredit(balance.free)} · Dibeli {fmtCredit(balance.purchased)} · Plan {fmtCredit(balance.plan)}
                {balance.purchasedExpiresAt ? ` · Credit dibeli kedaluwarsa ${fmtDate(balance.purchasedExpiresAt)}` : ''}
              </p>
            )}
            {!configured && (
              <p className="mt-2 text-[12px] leading-relaxed text-warning">
                Pembayaran belum dikonfigurasi admin — top-up belum bisa dibuat.
              </p>
            )}
          </div>

          {loading ? (
            <p className="mt-4 text-[12.5px] text-quiet">Memuat…</p>
          ) : (
            <>
              <h3 className="vb-eyebrow mt-5">Pilih paket</h3>
              <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {packages.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    disabled={creating}
                    onClick={() => void createOrder(p.id)}
                    className="vb-card px-4 py-3 text-left transition-colors hover:border-accent disabled:opacity-50"
                  >
                    <span className="block text-[16px] font-semibold text-body">{fmtRp(p.amountIdr)}</span>
                    <span className="mt-0.5 block text-[18px] font-semibold text-accent">
                      {p.credits.toLocaleString('id-ID')} credit
                    </span>
                    <span className="text-[12px] text-quiet">
                      ≈ Rp{(p.amountIdr / p.credits).toLocaleString('id-ID', { maximumFractionDigits: 2 })} / credit
                    </span>
                  </button>
                ))}
              </div>

              {current && (
                <div className="vb-card mt-4 p-4 text-center">
                  <h3 className="text-left text-[15px] font-semibold text-body">Scan QRIS untuk membayar</h3>
                  <p className="mt-2 text-left text-[12.5px] text-quiet">
                    Order <span className="font-mono text-body">{current.orderId}</span> · {fmtRp(current.amountIdr)} ·{' '}
                    {current.credits.toLocaleString('id-ID')} credit ·{' '}
                    <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ${statusClass(current.status)}`}>
                      {current.status}
                    </span>
                  </p>
                  {current.qrPayload && (
                    <>
                      <img
                        src={`https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=8&data=${encodeURIComponent(current.qrPayload)}`}
                        alt="Kode QRIS"
                        className="mx-auto mt-3 w-full max-w-[240px] rounded-lg bg-white p-2"
                      />
                      <code className="mt-3 block break-all rounded-lg border border-edge bg-surface-muted p-2.5 text-left font-mono text-[12px] text-body">
                        {current.qrPayload}
                      </code>
                      <p className="mt-3 flex flex-wrap items-center justify-center gap-2">
                        <button type="button" onClick={() => void copy(current.qrPayload ?? '')} className="vb-btn-ghost h-8 text-[12px]">
                          {copied ? 'Disalin' : 'Salin payload QRIS'}
                        </button>
                        {current.paymentUrl && (
                          <a href={current.paymentUrl} target="_blank" rel="noopener" className="vb-btn-ghost h-8 text-[12px]">
                            Buka halaman bayar
                          </a>
                        )}
                      </p>
                    </>
                  )}
                  <p className="mt-2 text-[12px] text-quiet">
                    Berlaku sampai {fmtDate(current.expiresAt)}
                    {current.status === 'pending' ? ' · Status diperbarui otomatis.' : ''}
                  </p>
                  {current.status === 'pending' && (
                    <p className="mt-3 flex flex-wrap items-center justify-center gap-2">
                      <button type="button" onClick={() => void checkStatus()} disabled={busy} className="vb-btn-ghost h-8 text-[12px] disabled:opacity-50">
                        Periksa status pembayaran
                      </button>
                      <button type="button" onClick={() => void cancelOrder()} disabled={busy} className="vb-btn-ghost h-8 text-[12px] disabled:opacity-50">
                        Batalkan order
                      </button>
                    </p>
                  )}
                </div>
              )}

              {msg && (
                <p className={`mt-3 text-[12.5px] leading-relaxed ${msgKind === 'err' ? 'text-danger' : msgKind === 'ok' ? 'text-success' : 'text-quiet'}`}>
                  {msg}
                </p>
              )}

              <h3 className="vb-eyebrow mt-5">Riwayat top-up</h3>
              {!orders.length ? (
                <p className="mt-2 text-[12.5px] text-quiet">Belum ada top-up.</p>
              ) : (
                <ul className="vb-card mt-2 divide-y divide-edge overflow-hidden">
                  {orders.slice(0, 5).map((o) => (
                    <li key={o.orderId} className="px-4 py-3">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="min-w-0 truncate font-mono text-[12px] text-body">{o.orderId}</span>
                        <span className="shrink-0 text-[12.5px] font-medium text-body">
                          +{o.credits.toLocaleString('id-ID')} credit
                        </span>
                      </div>
                      <p className="mt-1 text-[11.5px] text-quiet">
                        {fmtDate(o.createdAt)} · {fmtRp(o.amountIdr)} ·{' '}
                        <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ${statusClass(o.status)}`}>
                          {o.status}
                        </span>
                        {o.paidAt ? ` · dibayar ${fmtDate(o.paidAt)}` : ''}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

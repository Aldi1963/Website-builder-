import { useState, type FormEvent } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { getCookie } from '@tanstack/react-start/server'
import { query } from '~/lib/db-browser'
import { AUTH_COOKIE_NAME, requireUser } from '~/lib/auth'
import { createOrder, ensureTiketSchema, type TiketEvent } from '~/lib/tiket'
import { formatDate, formatPrice } from '~/lib/format'

type TicketType = { id: number; name: string; price_cents: number; quota: number; sold: number }

const loadEvent = createServerFn({ method: 'GET' })
  .validator((slug: string) => slug)
  .handler(async ({ data: slug }) => {
    await ensureTiketSchema()
    const { rows } = await query<TiketEvent>(
      `select * from events where slug=$1 and status='published' limit 1`, [slug],
    )
    const event = rows[0]
    if (!event) return { event: null, types: [] as TicketType[] }
    const types = await query<TicketType>(
      `select id, name, price_cents, quota, sold from ticket_types where event_id=$1 order by price_cents`, [event.id],
    )
    return { event, types: types.rows }
  })

const orderTickets = createServerFn({ method: 'POST' })
  .validator((input: { eventId: number; items: { ticketTypeId: number; quantity: number }[]; promoCode?: string }) => input)
  .handler(async ({ data }) => {
    const token = getCookie(AUTH_COOKIE_NAME)
    const user = await requireUser(token)
    const result = await createOrder({ ...data, userId: user.id })
    return { code: result.order.code, total: result.order.total_cents, tickets: result.attendees.length }
  })

export const Route = createFileRoute('/event/$slug')({
  loader: ({ params }) => loadEvent({ data: params.slug }),
  component: EventPage,
})

function EventPage() {
  const { event, types } = Route.useLoaderData()
  const nav = useNavigate()
  const [qty, setQty] = useState<Record<number, number>>({})
  const [promo, setPromo] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  if (!event) {
    return (
      <main className="container-page py-20">
        <div className="card p-10 text-center">
          <p className="text-slate-300">Event tidak ditemukan atau belum dipublikasikan.</p>
          <Link to="/" className="btn-ghost mt-4">Kembali ke katalog</Link>
        </div>
      </main>
    )
  }

  const total = types.reduce((sum, t) => sum + (qty[t.id] ?? 0) * t.price_cents, 0)
  const count = types.reduce((sum, t) => sum + (qty[t.id] ?? 0), 0)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (count < 1) { setError('Pilih minimal satu tiket.'); return }
    setBusy(true); setError('')
    try {
      await orderTickets({
        data: {
          eventId: event!.id,
          items: types.filter((t) => (qty[t.id] ?? 0) > 0).map((t) => ({ ticketTypeId: t.id, quantity: qty[t.id] })),
          promoCode: promo.trim() || undefined,
        },
      })
      await nav({ to: '/dashboard' })
    } catch (err) {
      setError((err as Error).message)
    } finally { setBusy(false) }
  }

  return (
    <main className="container-page py-10">
      <Link to="/" className="text-sm text-slate-400 hover:text-white">← Katalog event</Link>
      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_360px]">
        <section className="card p-6">
          <span className="badge">{event.status}</span>
          <h1 className="mt-3 text-3xl font-bold text-white">{event.title}</h1>
          <p className="mt-2 text-sm text-slate-400">{formatDate(event.starts_at)} · {event.venue || 'Lokasi belum diumumkan'}</p>
          <p className="mt-4 leading-relaxed text-slate-300">{event.description || 'Belum ada deskripsi.'}</p>

          <h2 className="mt-8 text-lg font-semibold text-white">Jenis tiket</h2>
          {types.length === 0 ? (
            <p className="mt-3 text-sm text-slate-400">Belum ada tiket untuk event ini.</p>
          ) : (
            <div className="mt-3 divide-y divide-white/10">
              {types.map((t) => {
                const left = t.quota - t.sold
                return (
                  <div key={t.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
                    <div>
                      <p className="font-medium text-white">{t.name}</p>
                      <p className="text-sm text-slate-400">{formatPrice(t.price_cents)} · sisa {left} tiket</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button type="button" className="btn-ghost h-11 w-11 p-0 text-lg" disabled={(qty[t.id] ?? 0) === 0}
                        onClick={() => setQty((s) => ({ ...s, [t.id]: Math.max(0, (s[t.id] ?? 0) - 1) }))} aria-label={`Kurangi ${t.name}`}>−</button>
                      <span className="w-8 text-center tabular-nums text-white">{qty[t.id] ?? 0}</span>
                      <button type="button" className="btn-ghost h-11 w-11 p-0 text-lg" disabled={(qty[t.id] ?? 0) >= left}
                        onClick={() => setQty((s) => ({ ...s, [t.id]: Math.min(left, (s[t.id] ?? 0) + 1) }))} aria-label={`Tambah ${t.name}`}>+</button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </section>

        <aside className="card h-fit p-6">
          <h2 className="text-lg font-semibold text-white">Ringkasan pesanan</h2>
          <p className="mt-1 text-sm text-slate-400">{count} tiket dipilih</p>
          <div className="mt-5 flex items-baseline justify-between">
            <span className="text-sm text-slate-400">Total</span>
            <span className="text-2xl font-bold tabular-nums text-white">{formatPrice(total)}</span>
          </div>
          <form onSubmit={submit} className="mt-5 space-y-3">
            <label className="block">
              <span className="label">Kode promo (opsional)</span>
              <input className="input mt-1 w-full" value={promo} onChange={(e) => setPromo(e.target.value)} placeholder="PROMO2026" />
            </label>
            {error && <p className="rounded-lg bg-red-500/10 p-3 text-sm text-red-300">{error}</p>}
            <button className="btn-primary w-full" disabled={busy || count < 1}>
              {busy ? 'Memproses pesanan…' : 'Pesan tiket'}
            </button>
          </form>
          <p className="mt-3 text-xs text-slate-500">Harus masuk terlebih dahulu. Kode tiket muncul di dashboard setelah pembayaran tercatat.</p>
        </aside>
      </div>
    </main>
  )
}

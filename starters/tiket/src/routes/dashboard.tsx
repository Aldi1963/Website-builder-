import { useState, type FormEvent } from 'react'
import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { getCookie, setCookie } from '@tanstack/react-start/server'
import { query } from '~/lib/db-browser'
import { AUTH_COOKIE_NAME, AUTH_COOKIE_MAX_AGE, getCurrentUser, requireUser, requireRole, login, logout } from '~/lib/auth'
import { canManageEvent, checkIn, ensureTiketSchema, type TiketEvent } from '~/lib/tiket'
import { formatDate, formatPrice } from '~/lib/format'

const cookieOpts = { httpOnly: true as const, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' as const, path: '/', maxAge: AUTH_COOKIE_MAX_AGE }

type OrderRow = { id: number; code: string; status: string; total_cents: number; event_title: string; created_at: Date }
type AttendeeRow = { id: number; code: string; name: string; event_title: string; checked_in_at: Date | null }

const loadDashboard = createServerFn({ method: 'GET' }).handler(async () => {
  await ensureTiketSchema()
  const token = getCookie(AUTH_COOKIE_NAME)
  const user = await getCurrentUser(token)
  if (!user) return { user: null, orders: [] as OrderRow[], managed: [] as TiketEvent[], attendees: [] as AttendeeRow[] }

  const orders = await query<OrderRow>(
    `select o.id, o.code, o.status, o.total_cents, e.title as event_title, o.created_at
       from orders o join events e on e.id=o.event_id where o.user_id=$1
      order by o.created_at desc limit 50`, [user.id],
  )
  const canManage = user.role === 'admin' || user.role === 'organizer'
  const managed = canManage
    ? (await query<TiketEvent>(`select * from events order by created_at desc limit 50`)).rows
    : []
  const attendees = canManage
    ? (await query<AttendeeRow>(
        `select a.id, a.code, a.name, e.title as event_title, a.checked_in_at
           from attendees a join orders o on o.id=a.order_id join events e on e.id=o.event_id
          order by a.created_at desc limit 50`)).rows
    : []
  return { user, orders: orders.rows, managed, attendees }
})

const createEvent = createServerFn({ method: 'POST' })
  .validator((input: { title: string; slug: string; venue: string; description: string }) => input)
  .handler(async ({ data }) => {
    const token = getCookie(AUTH_COOKIE_NAME)
    const user = await requireRole(token, ['admin', 'organizer'])
    const title = data.title.trim()
    const slug = data.slug.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '')
    if (title.length < 3) throw new Error('Judul event minimal 3 karakter.')
    if (slug.length < 3) throw new Error('Slug minimal 3 karakter.')
    await ensureTiketSchema()
    const exists = await query(`select 1 from events where slug=$1`, [slug])
    if (exists.rows.length) throw new Error('Slug sudah dipakai event lain.')
    await query(
      `insert into events (title, slug, description, venue, status, created_by) values ($1,$2,$3,$4,'draft',$5)`,
      [title, slug, data.description.trim(), data.venue.trim(), user.id],
    )
    return { ok: true }
  })

const publishEvent = createServerFn({ method: 'POST' })
  .validator((id: number) => id)
  .handler(async ({ data: id }) => {
    const token = getCookie(AUTH_COOKIE_NAME)
    const user = await requireRole(token, ['admin', 'organizer'])
    await ensureTiketSchema()
    const ev = await query<{ id: number; created_by: number | null }>(`select id, created_by from events where id=$1`, [id])
    if (!ev.rows.length) throw new Error('Event tidak ditemukan.')
    if (!(await canManageEvent(ev.rows[0], user))) throw new Error('Anda tidak mengelola event ini.')
    const types = await query(`select 1 from ticket_types where event_id=$1 limit 1`, [id])
    if (!types.rows.length) throw new Error('Tambahkan minimal satu jenis tiket sebelum mempublikasikan.')
    await query(`update events set status='published' where id=$1`, [id])
    return { ok: true }
  })

const addTicketType = createServerFn({ method: 'POST' })
  .validator((input: { eventId: number; name: string; priceCents: number; quota: number }) => input)
  .handler(async ({ data }) => {
    const token = getCookie(AUTH_COOKIE_NAME)
    const user = await requireRole(token, ['admin', 'organizer'])
    await ensureTiketSchema()
    const ev = await query<{ id: number; created_by: number | null }>(`select id, created_by from events where id=$1`, [data.eventId])
    if (!ev.rows.length || !(await canManageEvent(ev.rows[0], user))) throw new Error('Anda tidak mengelola event ini.')
    if (data.name.trim().length < 2) throw new Error('Nama tiket minimal 2 karakter.')
    if (!Number.isInteger(data.priceCents) || data.priceCents < 0) throw new Error('Harga tidak valid.')
    if (!Number.isInteger(data.quota) || data.quota < 1) throw new Error('Kuota minimal 1.')
    await query(
      `insert into ticket_types (event_id, name, price_cents, quota) values ($1,$2,$3,$4)`,
      [data.eventId, data.name.trim(), data.priceCents, data.quota],
    )
    return { ok: true }
  })

const scanTicket = createServerFn({ method: 'POST' })
  .validator((code: string) => code)
  .handler(async ({ data }) => {
    const token = getCookie(AUTH_COOKIE_NAME)
    await ensureTiketSchema()
    return checkIn(token, data.trim().toUpperCase(), requireRole, getCurrentUser)
  })

export const Route = createFileRoute('/dashboard')({
  loader: () => loadDashboard(),
  component: Dashboard,
})

function Dashboard() {
  const data = Route.useLoaderData()
  const router = useRouter()
  const [title, setTitle] = useState('')
  const [slug, setSlug] = useState('')
  const [venue, setVenue] = useState('')
  const [description, setDescription] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [ok, setOk] = useState('')
  const [busy, setBusy] = useState(false)

  if (!data.user) {
    return (
      <main className="container-page py-20">
        <div className="card p-10 text-center">
          <p className="text-muted">Masuk untuk melihat pesanan dan tiket Anda.</p>
          <Link to="/masuk" className="btn-primary mt-4">Masuk</Link>
        </div>
      </main>
    )
  }

  const canManage = data.user.role === 'admin' || data.user.role === 'organizer'

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setError(''); setOk('')
    try { await fn(); setOk('Berhasil. Data telah diperbarui.') }
    catch (err) { setError((err as Error).message) }
    finally { setBusy(false) }
  }

  function submitEvent(e: FormEvent) {
    e.preventDefault()
    void run(async () => {
      await createEvent({ data: { title, slug, venue, description } })
      setTitle(''); setSlug(''); setVenue(''); setDescription('')
      await router.invalidate()
    })
  }

  return (
    <main className="container-page py-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-ink">Dashboard</h1>
          <p className="mt-1 text-sm text-muted">{data.user.email} · {data.user.role || 'user'}</p>
        </div>
        <Link to="/" className="btn-ghost">Lihat event</Link>
      </div>

      {(error || ok) && (
        <p className={`mt-5 rounded-lg p-3 text-sm ${error ? 'bg-danger/10 text-danger' : 'bg-emerald-600/10 text-emerald-700'}`}>
          {error || ok}
        </p>
      )}

      <section className="mt-8">
        <h2 className="text-xl font-semibold text-ink">Pesanan saya</h2>
        {data.orders.length === 0 ? (
          <div className="card mt-3 p-8 text-center text-sm text-muted">Belum ada pesanan. <Link to="/" className="text-amber-700">Cari event</Link>.</div>
        ) : (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {data.orders.map((o) => (
              <div key={o.id} className="card p-5">
                <div className="flex items-center justify-between gap-3">
                  <p className="font-semibold text-ink">{o.event_title}</p>
                  <span className="badge">{o.status}</span>
                </div>
                <p className="mt-2 text-sm text-muted">Kode pesanan <span className="font-mono text-amber-700">{o.code}</span></p>
                <p className="mt-1 text-sm tabular-nums text-muted">Total {formatPrice(o.total_cents)}</p>
              </div>
            ))}
          </div>
        )}
      </section>

      {canManage && (
        <>
          <section className="mt-10 grid gap-6 lg:grid-cols-2">
            <div className="card p-6">
              <h2 className="text-lg font-semibold text-ink">Buat event baru</h2>
              <form onSubmit={submitEvent} className="mt-4 space-y-3">
                <label className="block"><span className="label">Judul event</span>
                  <input className="input mt-1 w-full" value={title} onChange={(e) => setTitle(e.target.value)} required />
                </label>
                <label className="block"><span className="label">Slug (URL)</span>
                  <input className="input mt-1 w-full" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="konser-jazz-2026" required />
                </label>
                <label className="block"><span className="label">Lokasi</span>
                  <input className="input mt-1 w-full" value={venue} onChange={(e) => setVenue(e.target.value)} />
                </label>
                <label className="block"><span className="label">Deskripsi</span>
                  <textarea className="input mt-1 w-full" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
                </label>
                <button className="btn-primary w-full" disabled={busy}>Buat event</button>
              </form>
            </div>

            <div className="card p-6">
              <h2 className="text-lg font-semibold text-ink">Check-in tiket</h2>
              <p className="mt-1 text-sm text-muted">Masukkan kode tiket peserta (SCAN-…).</p>
              <form className="mt-4 flex gap-2" onSubmit={(e) => {
                e.preventDefault()
                void run(async () => { await scanTicket({ data: code }); setCode('') })
              }}>
                <input className="input flex-1" value={code} onChange={(e) => setCode(e.target.value)} placeholder="SCAN-XXXXXXXX" required />
                <button className="btn-primary" disabled={busy}>Scan</button>
              </form>
            </div>
          </section>

          <section className="mt-10">
            <h2 className="text-xl font-semibold text-ink">Event yang dikelola</h2>
            {data.managed.length === 0 ? (
              <p className="card mt-3 p-8 text-center text-sm text-muted">Belum ada event. Buat event pertama di atas.</p>
            ) : (
              <div className="mt-3 space-y-3">
                {data.managed.map((e) => (
                  <EventAdmin key={e.id} id={e.id} title={e.title} status={e.status} run={run} router={router} />
                ))}
              </div>
            )}
          </section>

          <section className="mt-10">
            <h2 className="text-xl font-semibold text-ink">Tiket terdaftar</h2>
            {data.attendees.length === 0 ? (
              <p className="card mt-3 p-8 text-center text-sm text-muted">Belum ada tiket yang dipesan.</p>
            ) : (
              <div className="card mt-3 divide-y divide-edge">
                {data.attendees.map((a) => (
                  <div key={a.id} className="flex flex-wrap items-center justify-between gap-2 p-4">
                    <div>
                      <p className="text-sm text-ink">{a.name} · {a.event_title}</p>
                      <p className="font-mono text-xs text-amber-700">{a.code}</p>
                    </div>
                    <span className="badge">{a.checked_in_at ? 'Sudah check-in' : 'Belum check-in'}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </main>
  )
}

function EventAdmin({ id, title, status, run, router }: { id: number; title: string; status: string; run: (fn: () => Promise<unknown>) => void; router: ReturnType<typeof useRouter> }) {
  const [name, setName] = useState('')
  const [price, setPrice] = useState('')
  const [quota, setQuota] = useState('')

  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold text-ink">{title}</p>
        <span className="badge">{status}</span>
      </div>
      <form className="mt-4 flex flex-wrap gap-2" onSubmit={(e) => {
        e.preventDefault()
        void run(async () => {
          await addTicketType({ data: { eventId: id, name, priceCents: Math.round(Number(price) * 100), quota: Number(quota) } })
          setName(''); setPrice(''); setQuota('')
          await router.invalidate()
        })
      }}>
        <input className="input min-w-32 flex-1" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nama tiket" required />
        <input className="input w-28" type="number" min="0" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="Harga (Rp)" required />
        <input className="input w-24" type="number" min="1" step="1" value={quota} onChange={(e) => setQuota(e.target.value)} placeholder="Kuota" required />
        <button className="btn-ghost" disabled={status === 'published'}>Tambah tiket</button>
        {status !== 'published' && <button className="btn-primary" onClick={(e) => {
          e.preventDefault()
          void run(async () => { await publishEvent({ data: id }); await router.invalidate() })
        }}>Publikasikan</button>}
      </form>
    </div>
  )
}

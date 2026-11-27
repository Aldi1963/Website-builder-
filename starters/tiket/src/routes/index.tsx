import { createFileRoute, Link } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { getCookie } from '@tanstack/react-start/server'
import { query } from '~/lib/db-browser'
import { AUTH_COOKIE_NAME, getCurrentUser } from '~/lib/auth'
import { ensureTiketSchema, type TiketEvent } from '~/lib/tiket'
import { formatPrice } from '~/lib/format'

const loadHome = createServerFn({ method: 'GET' }).handler(async () => {
  await ensureTiketSchema()
  const token = getCookie(AUTH_COOKIE_NAME)
  const user = await getCurrentUser(token)
  const { rows } = await query<TiketEvent & { types: number; min_price: number | null }>(
    `select e.id, e.title, e.slug, e.description, e.venue, e.starts_at, e.status,
            count(t.id)::int as types,
            min(t.price_cents)::int as min_price
       from events e left join ticket_types t on t.event_id=e.id
      ${user?.role === 'admin' || user?.role === 'organizer' ? '' : `where e.status='published'`}
      group by e.id order by e.starts_at nulls last, e.created_at desc limit 50`,
  )
  return { user, events: rows }
})

export const Route = createFileRoute('/')({
  loader: () => loadHome(),
  component: Home,
})

function Home() {
  const { user, events } = Route.useLoaderData()
  const canManage = user?.role === 'admin' || user?.role === 'organizer'

  return (
    <main className="min-h-dvh">
      <header className="border-b border-white/10 bg-slate-950/70 backdrop-blur">
        <div className="container-page flex items-center justify-between py-4">
          <Link to="/" className="flex items-center gap-2 font-bold tracking-tight text-white">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-amber-400/15 text-amber-300">T</span>
            <span>TiketKu</span>
          </Link>
          <nav className="flex items-center gap-2 text-sm">
            {user ? (
              <>
                <Link to="/dashboard" className="btn-ghost">Dashboard</Link>
                <span className="hidden text-slate-400 sm:inline">{user.name || user.email}</span>
                <span className="badge capitalize">{user.role || 'user'}</span>
              </>
            ) : (
              <Link to="/masuk" className="btn-primary">Masuk</Link>
            )}
          </nav>
        </div>
      </header>

      <section className="container-page py-14 sm:py-20">
        <div className="mx-auto max-w-3xl text-center">
          <span className="badge">Event & Tiket</span>
          <h1 className="mt-4 text-4xl font-extrabold tracking-tight sm:text-6xl">
            Cari event, <span className="text-amber-300">pesan tiket</span>
          </h1>
          <p className="mt-5 text-base leading-relaxed text-slate-400 sm:text-lg">
            Lihat jadwal event, pilih jenis tiket, dan terima kode check-in langsung setelah pesanan dibuat.
          </p>
        </div>

        <div className="mt-14">
          <div className="mb-5 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold text-white">Event tersedia</h2>
              <p className="text-sm text-slate-400">{events.length} event</p>
            </div>
            {canManage && <Link to="/dashboard" className="btn-ghost text-sm">Kelola event →</Link>}
          </div>

          {events.length === 0 ? (
            <div className="card p-10 text-center">
              <p className="text-slate-300">Belum ada event yang dipublikasikan.</p>
              <p className="mt-1 text-sm text-slate-400">
                {canManage ? 'Buat event pertama dari dashboard.' : 'Event akan muncul di sini setelah organizer mempublikasikannya.'}
              </p>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {events.map((e) => (
                <Link key={e.id} to="/event/$slug" params={{ slug: e.slug }} className="card group block p-5 transition hover:border-amber-400/30 hover:bg-white/[0.06]">
                  <div className="flex items-start justify-between gap-3">
                    <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-amber-400/10 text-lg font-bold text-amber-300">
                      {e.title.slice(0, 1).toUpperCase()}
                    </div>
                    {e.status !== 'published' && <span className="badge">{e.status}</span>}
                  </div>
                  <h3 className="mt-4 font-semibold text-white group-hover:text-amber-200">{e.title}</h3>
                  <p className="mt-1 line-clamp-2 text-sm text-slate-400">{e.description || 'Belum ada deskripsi.'}</p>
                  <div className="mt-4 flex flex-wrap gap-3 text-xs text-slate-500">
                    <span>{e.types} jenis tiket</span>
                    {e.min_price !== null && <span>Mulai {formatPrice(e.min_price)}</span>}
                    {e.venue && <span>{e.venue}</span>}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </section>
    </main>
  )
}

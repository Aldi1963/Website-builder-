import { createFileRoute, Link } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { query } from '~/lib/db'

const loadInfo = createServerFn({ method: 'GET' }).handler(async () => {
  try {
    const { rows } = await query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    )
    return { ok: true, tables: rows.map((r) => r.table_name) }
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
})

export const Route = createFileRoute('/')({
  loader: () => loadInfo(),
  component: Home,
})

function Home() {
  const info = Route.useLoaderData()
  const tables = info.ok ? info.tables : []

  return (
    <main className="container-page flex min-h-dvh flex-col justify-center py-16">
      <div className="mx-auto max-w-2xl text-center">
        <span className="badge">Siap dikembangkan</span>
        <h1 className="mt-4 text-4xl font-extrabold tracking-tight sm:text-5xl">
          Aplikasi <span className="font-display text-accent">berjalan</span>
        </h1>
        <p className="mt-4 text-base text-ink">
          SSR TanStack Start aktif dengan database Postgres terkelola. Mulai bangun fitur pertamamu
          di sini.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link to="/login" className="btn-primary">
            Halaman login
          </Link>
          <Link to="/chat" className="btn-ghost">
            Halaman chat (AI)
          </Link>
        </div>
      </div>

      <div className="card mx-auto mt-12 max-w-2xl p-5 text-left">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">Tabel database</h2>
          <span className="badge">{tables.length} tabel</span>
        </div>
        {tables.length === 0 ? (
          <p className="text-sm text-muted">
            Belum ada tabel. Saat kamu meminta fitur yang butuh data, tabel akan dibuat otomatis.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {tables.map((t) => (
              <span key={t} className="badge font-mono">
                {t}
              </span>
            ))}
          </div>
        )}
        {!info.ok && (
          <p className="mt-3 text-sm text-danger">Gagal membaca database: {info.message}</p>
        )}
      </div>
    </main>
  )
}

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
  return (
    <main className="mx-auto max-w-2xl px-6 py-24">
      <h1 className="text-4xl font-bold tracking-tight">App berjalan</h1>
      <p className="mt-3 text-stone-400">SSR TanStack Start aktif. Database Postgres terkelola:</p>
      <pre className="mt-6 rounded-lg border border-stone-800 bg-stone-900 p-4 text-sm text-stone-100">
        {JSON.stringify(info, null, 2)}
      </pre>
      <p className="mt-6 text-sm text-stone-400">
        Contoh: <Link to="/login" className="text-stone-100 underline">halaman login</Link> (auth bawaan) ·{' '}
        <Link to="/chat" className="text-stone-100 underline">halaman chat</Link> (butuh API key LLM).
      </p>
    </main>
  )
}

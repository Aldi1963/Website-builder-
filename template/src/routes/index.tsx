import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { getDbInfo } from '~/lib/db'

const loadInfo = createServerFn({ method: 'GET' }).handler(async () => getDbInfo())

export const Route = createFileRoute('/')({
  loader: () => loadInfo(),
  component: Home,
})

function Home() {
  const info = Route.useLoaderData()
  return (
    <main className="mx-auto max-w-2xl px-6 py-24">
      <h1 className="text-4xl font-bold tracking-tight">App berjalan</h1>
      <p className="mt-3 text-slate-400">SSR TanStack Start aktif. Data dari server:</p>
      <pre className="mt-6 rounded-lg border border-slate-800 bg-slate-900 p-4 text-sm">
        {JSON.stringify(info, null, 2)}
      </pre>
    </main>
  )
}

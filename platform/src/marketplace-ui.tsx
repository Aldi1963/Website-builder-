import { useEffect, useState } from 'react'
import { Icon } from './ui'
import { navigate } from './router'
import { api, type User, type MarketplaceListing } from './api'

/* Halaman galeri marketplace (publik): telusuri template, fork jadi proyek baru.
   Bila pengguna belum login, fork mengarahkan ke beranda (login modal). */
export function MarketplacePage({
  user,
  onCreate,
}: {
  user: User | null
  onCreate: () => void | Promise<void>
}) {
  const [listings, setListings] = useState<MarketplaceListing[]>([])
  const [categories, setCategories] = useState<string[]>(['semua'])
  const [category, setCategory] = useState('semua')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [forkingId, setForkingId] = useState<number | null>(null)
  const [notice, setNotice] = useState('')

  const load = () => {
    setLoading(true)
    api
      .marketplace(category)
      .then((j) => {
        setListings(j.listings)
        setCategories(j.categories)
        setError('')
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false))
  }

  useEffect(load, [category])

  const fork = async (id: number) => {
    if (!user) {
      navigate('/')
      return
    }
    setForkingId(id)
    setNotice('')
    try {
      const r = await api.forkListing(id)
      setNotice(`Template di-fork jadi proyek "${r.name}".`)
      navigate(`/proyek/${r.projectId}`)
    } catch (e) {
      setNotice((e as Error).message)
    } finally {
      setForkingId(null)
    }
  }

  const filtered = listings.filter((l) =>
    query.trim()
      ? `${l.title} ${l.description}`.toLowerCase().includes(query.trim().toLowerCase())
      : true,
  )

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-edge bg-surface px-4 max-md:h-12">
        <button
          onClick={() => navigate('/')}
          aria-label="Kembali"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-edge text-body transition-colors hover:bg-surface-muted max-md:h-11 max-md:w-11"
        >
          <Icon name="back" size={15} />
        </button>
        <h1 className="text-[13px] font-medium text-body">Marketplace</h1>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => void onCreate()}
            className="vb-btn-ghost h-8 text-[11.5px] hover:border-accent hover:text-accent"
          >
            + Proyek baru
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="vb-page">
          <div className="vb-card p-5">
            <p className="vb-eyebrow">Galeri komunitas</p>
            <h1 className="vb-page-title mt-1">Marketplace template</h1>
            <p className="mt-1 text-[12.5px] leading-relaxed text-quiet">
              Templat siap pakai buatan komunitas. Fork jadi proyek baru milikmu, lalu lanjutkan lewat chat.
            </p>
          </div>

          <div className="mt-4 flex flex-col gap-3">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Cari template…"
              aria-label="Cari template"
              className="vb-input"
            />
            <div className="flex flex-wrap gap-2">
              {categories.map((c) => (
                <button
                  key={c}
                  onClick={() => setCategory(c)}
                  className={
                    'vb-chip h-7 px-3 text-[11.5px] ' +
                    (c === category
                      ? 'border-accent bg-accent-soft text-accent'
                      : 'text-quiet hover:text-body')
                  }
                >
                  {c}
                </button>
              ))}
            </div>
          </div>

          {notice && (
            <p className="mt-3 border-l-2 border-edge pl-2 text-[12px] text-body">{notice}</p>
          )}
          {error && (
            <p className="mt-3 border-l-2 border-accent pl-2 text-[12px] text-accent">{error}</p>
          )}

          {loading ? (
            <p className="mt-6 text-[12.5px] text-quiet">Memuat template…</p>
          ) : filtered.length === 0 ? (
            <p className="mt-6 text-[12.5px] text-quiet">
              Belum ada template di galeri. Publikasikan proyekmu dari panel Kelola website.
            </p>
          ) : (
            <ul className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.map((l) => (
                <li key={l.id} className="vb-card p-4 transition-colors hover:border-accent/50">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-medium text-body">{l.title}</p>
                      <p className="mt-0.5 text-[11px] text-quiet">{l.category}</p>
                    </div>
                    <span className="vb-chip shrink-0 px-2 py-0.5 text-[10.5px]">
                      {l.fork_count} fork
                    </span>
                  </div>
                  {l.description && (
                    <p className="mt-2 line-clamp-3 text-[12px] leading-relaxed text-quiet">
                      {l.description}
                    </p>
                  )}
                  <button
                    onClick={() => void fork(l.id)}
                    disabled={forkingId === l.id}
                    className="vb-btn-ghost mt-3 w-full border-accent text-accent hover:bg-accent-soft disabled:opacity-50"
                  >
                    {forkingId === l.id ? 'Meng-fork…' : 'Fork jadi proyek baru'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

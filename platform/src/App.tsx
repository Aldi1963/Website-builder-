import { useEffect, useRef, useState } from 'react'
import { Button } from '@cloudflare/kumo/components/button'
import { Icon, ProjectThumb, Spinner, StatusBadge, Wordmark } from './ui'
import { api, auth, ChatHandlers, chatStream, Project, exportProjectZip, type ActivityEvent, type User } from './api'
import { AuthGate, UserBar } from './auth'
import { matchPath, navigate, usePath } from './router'
import { ChatPanel, CodePane, PreviewPane, SettingsSheet, type ChatAudit, type ChatPlan, type InlineEvent, type VisualTarget } from './panels'
import { useActivity } from './activity'
import { MODEL_AUTO, getPickerModels, isSelectionAvailable, modelIdForServer } from './models'
/* Fase 3 (UI credit): chip saldo + halaman Penggunaan. File ini milik Hermes
   (kotor, belum commit) — perubahan di bawah ini MINIMAL + aditif dan TIDAK
   di-commit oleh trek ini; komponennya sendiri ada di billing-ui.tsx. */
import { CreditChip, CreditMeter, UsagePage, notifyBalanceChanged } from './billing-ui'
import { TopupModal } from './topup-modal'
import { MarketplacePage } from './marketplace-ui'
import DatabasePage from './database-ui'

/* Right-side session menu (Emergent-style): a single 3-dot button in the chat
   header that opens a small dropdown with the actions that used to clutter the
   header row. Setelan sengaja TIDAK ada di sini — buka lewat tombol setelan
   di kolom input chat (onOpenSettings di composer). */
function SessionMenu({ projectId, usage }: { projectId: string; usage: { requests: number; promptTokens: number; completionTokens: number } | null }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const item = 'flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12.5px] text-body transition-colors hover:bg-surface'
  const go = (slug: string) => () => { setOpen(false); navigate(`/proyek/${projectId}/${slug}`) }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Menu sesi"
        aria-expanded={open}
        className="flex h-9 w-9 items-center justify-center rounded-full border border-edge text-body transition-colors hover:border-quiet max-md:h-11 max-md:w-11"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
        </svg>
      </button>
      {open && (
        <div role="menu" className="vb-enter absolute right-0 top-[calc(100%+6px)] z-30 w-56 overflow-hidden rounded-xl border border-edge bg-ink shadow-lg">
          {usage && (
            <div className="border-b border-edge px-3 py-2">
              <p className="text-[10.5px] uppercase tracking-wide text-quiet">Pemakaian LLM</p>
              <p className="mt-0.5 font-mono text-[11px] text-body">
                {usage.requests} req · {usage.promptTokens.toLocaleString('id-ID')} in · {usage.completionTokens.toLocaleString('id-ID')} out
              </p>
            </div>
          )}
          <button className={item} onClick={go('chat')} role="menuitem"><Icon name="back" size={13} /> Chat</button>
          <button className={item} onClick={go('file')} role="menuitem"><Icon name="file" size={13} /> Lihat file</button>
          <button className={item} onClick={go('database')} role="menuitem">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true"><ellipse cx="12" cy="5" rx="8" ry="3" stroke="currentColor" strokeWidth="1.7" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" stroke="currentColor" strokeWidth="1.7" /></svg> Lihat database
          </button>
          <button className={item} onClick={go('jalankan')} role="menuitem"><Icon name="run" size={13} /> Jalankan</button>
          <button className={item} onClick={go('terbitkan')} role="menuitem"><Icon name="check" size={13} /> Terbitkan</button>
          <button className={item} onClick={go('export')} role="menuitem"><Icon name="download" size={13} /> Export ZIP</button>
          <button className={item} onClick={go('tampilan')} role="menuitem"><Icon name="moon" size={13} /> Mode tampilan</button>
        </div>
      )}
    </div>
  )
}

/* Theme is a real choice here: the shell is used for long sessions next to an
   arbitrary generated app, so both modes ship and both are verified. */
/* Light is the product default. The stored key is versioned so a stale
   'dark' saved by older builds (which followed the OS preference) can't
   keep a light-mode phone stuck in dark mode. */
const THEME_KEY = 'vb-theme-v2'

/* Tampilan workspace (Chat / Code + file yang dibuka) dipertahankan per
   proyek. Tanpa ini, tombol "daftar proyek" terasa memisah halaman karena
   Workspace di-mount ulang (key=activeId) dan selalu mulai di Chat. */
const VIEW_KEY = (id: string) => `vb-view-${id}`
type SavedView = { tab: 'chat' | 'code'; file: string | null }
function loadView(id: string): SavedView {
  try {
    const raw = localStorage.getItem(VIEW_KEY(id))
    if (raw) {
      const v = JSON.parse(raw) as SavedView
      if (v.tab === 'chat' || v.tab === 'code') return { tab: v.tab, file: typeof v.file === 'string' ? v.file : null }
    }
  } catch { /* abaikan data rusak */ }
  return { tab: 'chat', file: null }
}
function saveView(id: string, view: SavedView) {
  try { localStorage.setItem(VIEW_KEY(id), JSON.stringify(view)) } catch { /* abaikan */ }
}

function useTheme() {
  const [dark, setDark] = useState(() => localStorage.getItem(THEME_KEY) === 'dark')

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    localStorage.removeItem('vb-theme')
    localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light')
  }, [dark])

  return { dark, toggle: () => setDark((d) => !d) }
}

const PUBLIC_ORIGIN = import.meta.env.VITE_PUBLIC_ORIGIN ?? 'https://vibe.clipku.com'

function publicUrl(slug: string) {
  const u = new URL(PUBLIC_ORIGIN)
  return `${u.protocol}//${slug}.${u.host}/`
}

function publicLabel(url: string | null, slug: string) {
  if (!url) return `/p/${slug}`
  try {
    return new URL(url).host
  } catch {
    return `/p/${slug}`
  }
}

export default function App() {
  const path = usePath()
  const [user, setUser] = useState<User | null>(null)
  const [sessionChecked, setSessionChecked] = useState(false)
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [navOpen, setNavOpen] = useState(false)
  const [showStarters, setShowStarters] = useState(false)
  const { dark, toggle } = useTheme()

  // Routing: '/' home, '/proyek/:id' workspace, '/profil' account page,
  // '/penggunaan' credit usage page (fase 3).
  const sessionSlugs = ['chat', 'file', 'database', 'jalankan', 'terbitkan', 'export', 'tampilan'] as const
  const sessionSlug = sessionSlugs.find((slug) => matchPath(`/proyek/:id/${slug}`, path))
  const projectRoute =
    (sessionSlug ? matchPath(`/proyek/:id/${sessionSlug}`, path) : null) ??
    matchPath('/proyek/:id', path)
  const routeTab: Route = sessionSlug ?? 'chat'
  const profileRoute = matchPath('/profil', path)
  const usageRoute = matchPath('/penggunaan', path)
  const marketRoute = matchPath('/marketplace', path)
  const activeId = projectRoute?.id ?? null

  useEffect(() => {
    if (projectRoute && !projects.some((p) => p.id === activeId) && projects.length) {
      navigate('/', { replace: true })
    }
  }, [path, projects])

  const refresh = async () => {
    try {
      const { projects } = await api.listProjects()
      setProjects(projects)
      setLoadError('')
    } catch (err) {
      setLoadError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    auth
      .me()
      .then((r) => setUser(r.user))
      .catch(() => setUser(null))
      .finally(() => setSessionChecked(true))
  }, [])

  useEffect(() => {
    if (!user) return
    void refresh()
    const t = setInterval(() => void refresh(), 8000)
    return () => clearInterval(t)
  }, [user])

  const logout = async () => {
    await auth.logout().catch(() => {})
    setUser(null)
    setProjects([])
    navigate('/', { replace: true })
  }

  const createProject = async (starter: 'blank' | 'lms' | 'tiket' = 'blank', prompt = '') => {
    const name = prompt.trim()
      ? prompt.trim().slice(0, 48)
      : starter === 'lms'
        ? 'LMS baru'
        : starter === 'tiket'
          ? 'Event & Tiket baru'
          : 'Proyek tanpa nama'
    const { project } = await api.createProject(name, prompt.trim(), starter)
    setProjects((p) => [project, ...p])
    setShowStarters(false)
    navigate(`/proyek/${project.id}`)
  }

  const removeProject = async (id: string) => {
    await api.deleteProject(id)
    setProjects((p) => p.filter((x) => x.id !== id))
    if (activeId === id) navigate('/', { replace: true })
  }

  if (!sessionChecked) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-ink">
        <Spinner />
      </div>
    )
  }

  if (!user) return <AuthGate onUser={setUser} />

  const onSelect = (id: string) => {
    navigate(`/proyek/${id}`)
    setNavOpen(false)
  }

  if (projectRoute && activeId) {
    return (
      <div className="flex h-dvh overflow-hidden bg-ink text-body">
        <Sidebar
          user={user}
          onLogout={logout}
          projects={projects}
          activeId={activeId}
          loading={loading}
          loadError={loadError}
          dark={dark}
          onToggleTheme={toggle}
          onSelect={onSelect}
          onCreate={createProject}
          onDelete={removeProject}
          open={navOpen}
          onClose={() => setNavOpen(false)}
        />
        <Workspace
          key={activeId}
          projectId={activeId}
          routeTab={routeTab}
          onMenu={() => setNavOpen(true)}
          onTitle={(name) => setProjects((p) => p.map((x) => (x.id === activeId ? { ...x, name } : x)))}
        />
        <TopupModal />
      </div>
    )
  }

  if (profileRoute) {
    return (
      <ProfilePage
        user={user}
        projects={projects}
        dark={dark}
        onToggleTheme={toggle}
        onLogout={logout}
        onCreate={createProject}
        onSelect={onSelect}
        onMenu={() => setNavOpen(true)}
        navOpen={navOpen}
        onCloseNav={() => setNavOpen(false)}
      />
    )
  }

  /* Fase 3: halaman Penggunaan pengguna (/penggunaan). */
  if (usageRoute) {
    return (
      <div className="flex h-dvh overflow-hidden bg-ink text-body">
        <Sidebar
          user={user}
          onLogout={logout}
          projects={projects}
          activeId={null}
          loading={loading}
          loadError={loadError}
          dark={dark}
          onToggleTheme={toggle}
          onSelect={onSelect}
          onCreate={createProject}
          onDelete={removeProject}
          open={navOpen}
          onClose={() => setNavOpen(false)}
        />
        <UsagePage
          user={user}
          dark={dark}
          onToggleTheme={toggle}
          onLogout={logout}
          onMenu={() => setNavOpen(true)}
          navOpen={navOpen}
          onCloseNav={() => setNavOpen(false)}
        />
        <TopupModal />
      </div>
    )
  }

  /* Fase 3: galeri marketplace (/marketplace) — publik, tanpa perlu login. */
  if (marketRoute) {
    return (
      <MarketplacePage
        user={user}
        onCreate={async () => {
          if (!user) {
            navigate('/')
            return
          }
          await createProject()
        }}
      />
    )
  }

  return (
    <div className="flex h-dvh overflow-hidden bg-ink text-body">
      <Sidebar
        user={user}
        onLogout={logout}
        projects={projects}
        activeId={null}
        loading={loading}
        loadError={loadError}
        dark={dark}
        onToggleTheme={toggle}
        onSelect={onSelect}
        onCreate={createProject}
        onDelete={removeProject}
        open={navOpen}
        onClose={() => setNavOpen(false)}
      />
      <HomePage
        projects={projects}
        loading={loading}
        onCreate={createProject}
        onCreatePrompt={(text) => void createProject('blank', text)}
        onSelect={onSelect}
        user={user}
        dark={dark}
        onToggleTheme={toggle}
        onLogout={logout}
        onMenu={() => setNavOpen(true)}
        navOpen={navOpen}
        onCloseNav={() => setNavOpen(false)}
        showStarters={showStarters}
        setShowStarters={setShowStarters}
      />
      <TopupModal />
    </div>
  )
}

/* Home: overview of all projects with quick actions.
   Redesain 27 Nov 2026 (pola Lovable di atas token navy): prompt-first hero,
   toolbar satu baris, statistik kartu 2 kolom di mobile, tab filter +
   search/sort, dan baris proyek flex (thumb 48 + nama ellipsis + badge pill
   di ujung kanan — perbaikan bug "Marketingidle"). */
function HomePage({
  projects,
  loading,
  onCreate,
  onCreatePrompt,
  onSelect,
  user,
  dark,
  onToggleTheme,
  onLogout,
  onMenu,
  navOpen,
  onCloseNav,
  showStarters,
  setShowStarters,
}: {
  projects: Project[]
  loading: boolean
  onCreate: (starter?: 'blank' | 'lms' | 'tiket') => void
  onCreatePrompt: (prompt: string) => void
  onSelect: (id: string) => void
  user: User
  dark: boolean
  onToggleTheme: () => void
  onLogout: () => void
  onMenu: () => void
  navOpen: boolean
  onCloseNav: () => void
  showStarters: boolean
  setShowStarters: (show: boolean) => void
}) {
  const working = projects.filter((p) => p.status === 'working').length
  const published = projects.filter((p) => p.slug).length
  const idle = projects.filter((p) => p.status === 'idle').length
  const [tab, setTab] = useState<'semua' | 'saya' | 'published' | 'template'>('semua')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<'terbaru' | 'nama'>('terbaru')
  const [prompt, setPrompt] = useState('')

  const visible = projects
    .filter((p) => {
      if (tab === 'published' && !p.slug) return false
      if (tab === 'template' && (!p.starter || p.starter === 'blank')) return false
      if (query.trim() && !p.name.toLowerCase().includes(query.trim().toLowerCase())) return false
      return true
    })
    .sort((a, b) =>
      sort === 'nama' ? a.name.localeCompare(b.name, 'id') : b.updated_at - a.updated_at,
    )

  const submitPrompt = (e: React.FormEvent) => {
    e.preventDefault()
    const text = prompt.trim()
    if (!text) {
      setShowStarters(true)
      return
    }
    onCreatePrompt(text)
  }

  const tabs: { id: typeof tab; label: string }[] = [
    { id: 'semua', label: 'Semua' },
    { id: 'saya', label: 'Milik saya' },
    { id: 'published', label: 'Published' },
    { id: 'template', label: 'Template' },
  ]

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-edge bg-surface px-4 max-md:h-12">
        <button
          onClick={onMenu}
          aria-label="Buka menu"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-edge text-body transition-colors hover:bg-surface-muted max-md:h-11 max-md:w-11"
        >
          <Icon name="back" size={15} />
        </button>
        <h1 className="text-[13px] font-medium text-body">Beranda</h1>
        <div className="ml-auto flex items-center gap-2">
          <CreditChip />
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
          <p className="text-[11.5px] uppercase tracking-wide text-quiet">Halo, {user.name || user.email}</p>
          <h2 className="vb-page-title mt-1">
            Ruang kerja untuk membangun aplikasi
          </h2>

          <form onSubmit={submitPrompt} className="mt-6">
            <div className="overflow-hidden rounded-xl border border-edge bg-surface transition-colors focus-within:border-accent">
              <label htmlFor="vb-hero-prompt" className="sr-only">
                Jelaskan website yang mau dibuat
              </label>
              <textarea
                id="vb-hero-prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    submitPrompt(e as unknown as React.FormEvent)
                  }
                }}
                rows={2}
                placeholder="Jelaskan website yang mau dibuat…"
                className="w-full resize-none bg-transparent px-4 py-3 text-[14px] leading-relaxed text-body outline-none placeholder:text-quiet"
              />
              <div className="flex items-center justify-between gap-2 border-t border-edge px-3 py-2">
                <span className="min-w-0 truncate text-[11.5px] text-quiet">
                  Enter untuk membuat · Shift+Enter baris baru
                </span>
                <button type="submit" className="vb-btn-primary h-9 shrink-0 max-md:h-11">
                  Buat
                  <Icon name="arrow" size={13} />
                </button>
              </div>
            </div>
          </form>

          <div className="vb-toolbar mt-4">
            <button
              onClick={() => setShowStarters(!showStarters)}
              className="vb-btn-primary max-md:w-full"
            >
              <Icon name="plus" size={12} />
              Proyek baru
            </button>
            <a
              href="/profil"
              className="vb-btn-ghost max-md:flex-1"
            >
              Profil akun
            </a>
            <a
              href="/marketplace"
              className="vb-btn-ghost max-md:flex-1"
            >
              Marketplace
            </a>
          </div>
          {showStarters && (
            <div className="mt-3 grid gap-3 sm:grid-cols-3" role="group" aria-label="Pilih starter proyek">
              <button onClick={() => { setShowStarters(false); onCreate(); }} className="vb-card p-4 text-left transition-colors hover:border-accent">
                <span className="block text-sm font-semibold text-body">Proyek kosong</span>
                <span className="mt-1 block text-xs text-quiet">Template standar untuk mulai dari awal</span>
              </button>
              <button onClick={() => { setShowStarters(false); onCreate('lms'); }} className="vb-card border-accent/40 bg-accent-soft/60 p-4 text-left transition-colors hover:border-accent">
                <span className="block text-sm font-semibold text-body">Starter LMS</span>
                <span className="mt-1 block text-xs text-quiet">Kursus, materi, enrollment, tugas, dan penilaian</span>
              </button>
              <button onClick={() => { setShowStarters(false); onCreate('tiket'); }} className="vb-card p-4 text-left transition-colors hover:border-accent">
                <span className="block text-sm font-semibold text-body">Starter Event &amp; Tiket</span>
                <span className="mt-1 block text-xs text-quiet">Event, tiket, pesanan, promo, dan check-in</span>
              </button>
            </div>
          )}

          <div className="vb-stat-grid mt-8">
            <StatCard label="Total proyek" value={String(projects.length)} delta={`${published} sudah published`} />
            <StatCard label="Sedang jalan" value={String(working)} delta={working ? `${working} proyek sedang dibangun` : 'Tidak ada yang berjalan'} />
            <StatCard label="Selesai" value={String(idle)} delta={`${idle} proyek idle`} className="col-span-2 lg:col-span-1" />
          </div>

          <div className="mt-8 flex items-center justify-between gap-3">
            <h3 className="vb-section-title">Proyek kamu</h3>
            <span className="shrink-0 text-[12px] text-quiet">{visible.length} proyek</span>
          </div>
          <div className="vb-tabs mt-4" role="tablist" aria-label="Filter proyek">
            {tabs.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className={`vb-tab ${tab === t.id ? 'vb-tab-active' : ''}`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Cari proyek…"
              aria-label="Cari proyek"
              className="vb-input flex-1"
            />
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as 'terbaru' | 'nama')}
              aria-label="Urutkan proyek"
              className="vb-input sm:w-44"
            >
              <option value="terbaru">Terbaru</option>
              <option value="nama">Nama A–Z</option>
            </select>
          </div>

          {loading ? (
            <p className="mt-4 text-[12.5px] text-quiet">Memuat…</p>
          ) : !projects.length ? (
            <>
              <button onClick={() => setShowStarters(true)} className="vb-create-tile mt-4">
                <Icon name="plus" size={13} />
                Buat proyek baru
              </button>
              <p className="mt-3 text-[12.5px] leading-relaxed text-quiet">
                Belum ada proyek. Tulis ide di atas atau tekan Proyek baru untuk memulai yang pertama.
              </p>
            </>
          ) : !visible.length ? (
            <p className="mt-4 text-[12.5px] leading-relaxed text-quiet">
              Tidak ada proyek yang cocok. Coba ubah filter atau pencarian.
            </p>
          ) : (
            <ul className="vb-card mt-4 divide-y divide-edge overflow-hidden">
              {visible.map((p) => (
                <li key={p.id}>
                  <ProjectRow project={p} onSelect={onSelect} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <MobileNavOverlay open={navOpen} onClose={onCloseNav} />
    </div>
  )
}

/* Baris proyek (dipakai Beranda + Profil): thumb 48 + nama ellipsis +
   timestamp + badge pill di ujung kanan. Nama tidak pernah menempel ke
   badge karena nama flex-1 truncate dan badge shrink-0. */
export function ProjectRow({ project, onSelect }: { project: Project; onSelect: (id: string) => void }) {
  return (
    <button onClick={() => onSelect(project.id)} className="vb-project-row">
      <ProjectThumb name={project.name} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[16px] font-semibold leading-snug text-body">
            {project.name}
          </span>
          <StatusBadge status={project.status} published={!!project.slug} />
        </span>
        <span className="mt-0.5 block text-[12px] text-quiet">{formatProjectDate(project.updated_at)}</span>
      </span>
      <Icon name="arrow" size={14} className="hidden shrink-0 text-quiet sm:block" />
    </button>
  )
}

function formatProjectDate(ts: number) {
  return new Date(ts).toLocaleString('id-ID', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function StatCard({ label, value, delta, className = '' }: { label: string; value: string; delta?: string; className?: string }) {
  return (
    <div className={`vb-card px-4 py-4 ${className}`}>
      <p className="vb-eyebrow">{label}</p>
      <p className="vb-stat-value">{value}</p>
      {delta && <p className="vb-stat-delta">{delta}</p>}
    </div>
  )
}

function MobileNavOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div
      onClick={onClose}
      aria-hidden="true"
      className="fixed inset-0 z-20 bg-black/55 md:hidden"
    />
  )
}

/* Account profile page at /profil. */
function ProfilePage({
  user,
  projects,
  dark,
  onToggleTheme,
  onLogout,
  onCreate,
  onSelect,
  onMenu,
  navOpen,
  onCloseNav,
}: {
  user: User
  projects: Project[]
  dark: boolean
  onToggleTheme: () => void
  onLogout: () => void
  onCreate: () => void
  onSelect: (id: string) => void
  onMenu: () => void
  navOpen: boolean
  onCloseNav: () => void
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-edge bg-surface px-4 max-md:h-12">
        <button
          onClick={onMenu}
          aria-label="Buka menu"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-edge text-body transition-colors hover:bg-surface-muted max-md:h-11 max-md:w-11"
        >
          <Icon name="back" size={15} />
        </button>
        <h1 className="text-[13px] font-medium text-body">Profil</h1>
        <div className="ml-auto flex items-center gap-2">
          <CreditChip />
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
          <div className="vb-card p-5">
            <p className="vb-eyebrow">Akun</p>
            <p className="mt-1 text-[17px] font-semibold text-body">{user.name || 'Tanpa nama'}</p>
            <p className="text-[12.5px] text-quiet">{user.email}</p>
            <button onClick={onLogout} className="vb-btn-ghost mt-4 h-8">
              Keluar dari akun
            </button>
          </div>

          <div className="vb-card mt-4 p-5">
            <p className="vb-eyebrow">Tema</p>
            <button onClick={onToggleTheme} className="vb-btn-ghost mt-3 h-8 text-[12px]">
              <Icon name={dark ? 'sun' : 'moon'} size={12} />
              {dark ? 'Aktifkan mode terang' : 'Aktifkan mode gelap'}
            </button>
          </div>

          <div className="mt-6">
            <div className="flex items-center justify-between">
              <p className="text-[10.5px] uppercase tracking-wide text-quiet">Proyek ({projects.length})</p>
              <button onClick={() => { onCreate(); }} className="flex h-7 items-center gap-1 text-[11.5px] text-accent">
                <Icon name="plus" size={11} />
                Baru
              </button>
            </div>
            {!projects.length ? (
              <p className="mt-3 text-[12.5px] text-quiet">Belum ada proyek.</p>
            ) : (
              <ul className="vb-card mt-3 divide-y divide-edge overflow-hidden">
                {projects.map((p) => (
                  <li key={p.id}>
                    <ProjectRow project={p} onSelect={onSelect} />
                  </li>
                ))}
              </ul>
            )}
          </div>

          <a
            href="/"
            className="mt-8 inline-flex h-8 items-center text-[12px] text-quiet hover:text-body"
          >
            ← Kembali ke beranda
          </a>
        </div>
      </div>
      <MobileNavOverlay open={navOpen} onClose={onCloseNav} />
    </div>
  )
}

function Sidebar({
  user,
  onLogout,
  projects,
  activeId,
  loading,
  loadError,
  dark,
  onToggleTheme,
  onSelect,
  onCreate,
  onDelete,
  open,
  onClose,
}: {
  user: User
  onLogout: () => void
  projects: Project[]
  activeId: string | null
  loading: boolean
  loadError: string
  dark: boolean
  onToggleTheme: () => void
  onSelect: (id: string) => void
  onCreate: () => void
  onDelete: (id: string) => void
  open: boolean
  onClose: () => void
}) {
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    closeRef.current?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <>
      {open && (
        <div
          onClick={onClose}
          aria-hidden="true"
          className="fixed inset-0 z-20 bg-black/55 md:hidden"
        />
      )}

      <aside
        id="vb-nav"
        aria-label="Daftar proyek"
        className={`z-30 flex w-[252px] shrink-0 flex-col border-r border-edge bg-surface max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:w-[86vw] max-md:transition-transform ${
          open ? 'max-md:translate-x-0' : 'max-md:-translate-x-full'
        }`}
      >
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-edge px-3">
          <Wordmark />
          <button
            ref={closeRef}
            onClick={onClose}
            className="flex h-11 w-11 items-center justify-center text-quiet md:hidden"
          >
            <Icon name="close" size={15} title="Tutup daftar proyek" />
          </button>
          <button
            onClick={onToggleTheme}
            aria-label={dark ? 'Ganti ke tema terang' : 'Ganti ke tema gelap'}
            className="flex h-8 w-8 items-center justify-center text-quiet transition-colors hover:text-body max-md:hidden"
          >
            <Icon name={dark ? 'sun' : 'moon'} size={13} />
          </button>
        </div>

        <div className="px-3 py-3">
          <button
            onClick={onCreate}
            className="flex h-8 max-md:h-11 w-full items-center justify-center gap-1.5 rounded-full bg-accent text-[12px] font-medium text-ink transition-opacity hover:opacity-90"
          >
            <Icon name="plus" size={11} />
            Proyek baru
          </button>
        </div>

        <div className="vb-seam flex-1 overflow-y-auto">
          <p className="px-3 pb-1 pt-2.5 text-[11px] text-quiet">
            {projects.length ? `${projects.length} proyek` : 'proyek'}
          </p>

          {loading && (
            <div className="flex items-center gap-2 px-3 py-3 text-[11.5px] text-quiet">
              <Spinner />
              Memuat daftar proyek
            </div>
          )}

          {!loading && loadError && (
            <div className="mx-3 my-2 border-l-2 border-accent py-1 pl-2">
              <p className="text-[11.5px] leading-relaxed text-body">
                Server tidak menjawab. Cek proses di port 3000.
              </p>
              <p className="mt-1 break-words font-mono text-[10.5px] text-quiet">{loadError}</p>
            </div>
          )}

          {!loading && !loadError && !projects.length && (
            <p className="px-3 py-3 text-[11.5px] leading-relaxed text-quiet">
              Belum ada proyek. Tekan Proyek baru untuk memulai yang pertama.
            </p>
          )}

          {projects.map((p) => (
            <div
              key={p.id}
              className={`group flex items-center ${
                activeId === p.id ? 'border-l-2 border-l-accent bg-ink' : 'border-l-2 border-l-transparent'
              }`}
            >
              <button
                onClick={() => onSelect(p.id)}
                aria-current={activeId === p.id ? 'true' : undefined}
                className="flex min-h-[34px] max-md:min-h-[44px] flex-1 items-center gap-2 px-2.5 py-1 text-left"
              >
                <StatusMark status={p.status} />
                <span className="truncate text-[12.5px] text-body">{p.name}</span>
              </button>
              <button
                onClick={() => {
                  if (confirm(`Hapus "${p.name}" beserta seluruh filenya?`)) void onDelete(p.id)
                }}
                aria-label={`Hapus ${p.name}`}
                className="mr-1 flex h-7 w-7 items-center justify-center text-quiet opacity-0 transition-opacity hover:text-body group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100"
              >
                <Icon name="trash" size={11} />
              </button>
            </div>
          ))}
        </div>

        <CreditMeter />

        <a
          href="/admin/settings"
          className="flex min-h-[38px] max-md:min-h-[44px] items-center gap-2 border-t border-edge px-3 py-2 text-[12.5px] text-body transition-colors hover:bg-surface-muted"
          title="Pengaturan admin — API key, model, pembayaran"
        >
          <Icon name="gear" size={13} className="text-quiet" />
          Pengaturan admin
        </a>

        <UserBar user={user} onLogout={onLogout} />

        <div className="border-t border-edge px-3 py-2">
          <p className="text-[10.5px] leading-relaxed text-quiet">
            TanStack Start, React 19, Tailwind v4
          </p>
        </div>
      </aside>
    </>
  )
}

/* Square, not a pill and not a glow: the mark reports the project's real run
   state and nothing else, so shape carries it as much as color. */
function StatusMark({ status }: { status: string }) {
  const color =
    status === 'working'
      ? 'bg-accent'
      : status === 'building'
        ? 'bg-body'
        : status === 'error'
          ? 'bg-accent'
          : 'bg-edge'
  return <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 ${color}`} />
}

function EmptyState({ onCreate, showStarters, setShowStarters }: { onCreate: (starter?: 'blank' | 'lms' | 'tiket') => void; showStarters: boolean; setShowStarters: (show: boolean) => void }) {
  return (
    <div className="flex flex-1 items-center justify-center px-6">
      <div className="max-w-[44ch]">
        <h1 className="font-display text-[26px] leading-tight text-body">
          Satu ruang kerja untuk menulis dan menjalankan aplikasi
        </h1>
        <p className="mt-3 text-[13px] leading-relaxed text-quiet">
          Pilih proyek kosong, starter LMS (kursus, materi, tugas, penilaian), atau starter Event & Tiket (event, pesanan, promo, check-in).
        </p>
        {!showStarters ? (
          <button
            onClick={() => setShowStarters(true)}
            className="vb-btn-primary mt-6 max-md:h-11"
          >
            <Icon name="plus" size={12} />
            Buat proyek pertama
          </button>
        ) : (
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            <button onClick={() => onCreate('blank')} className="vb-card p-4 text-left transition-colors hover:border-accent">
              <span className="block text-sm font-semibold text-body">Proyek kosong</span>
              <span className="mt-1 block text-xs text-quiet">Mulai dari template standar</span>
            </button>
            <button onClick={() => onCreate('lms')} className="vb-card border-accent/40 bg-accent-soft p-4 text-left transition-colors hover:border-accent">
              <span className="block text-sm font-semibold text-body">Starter LMS</span>
              <span className="mt-1 block text-xs text-quiet">Kursus, materi, enrollment, tugas & grading</span>
            </button>
            <button onClick={() => onCreate('tiket')} className="vb-card p-4 text-left transition-colors hover:border-accent">
              <span className="block text-sm font-semibold text-body">Starter Event & Tiket</span>
              <span className="mt-1 block text-xs text-quiet">Event, tiket, pesanan, promo & check-in</span>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

type Route = 'chat' | 'file' | 'database' | 'jalankan' | 'terbitkan' | 'export' | 'tampilan'

function Workspace({ projectId, routeTab, onTitle, onMenu }: { projectId: string; routeTab: Route; onTitle: (n: string) => void; onMenu: () => void }) {
  const { dark, toggle } = useTheme()
  const [tab, setTab] = useState<'chat' | 'code'>(routeTab === 'file' ? 'code' : 'chat')
  const [messages, setMessages] = useState<{ role: string; content: string; id?: number; created_at?: number }[]>([])
  /* Kartu aktivitas PERSISTEN dari server (tabel activity_events). Berbeda
     dari feed live `activity` (reset tiap kirim pesan): state ini HANYA
     dimuat dari server dan TIDAK pernah di-reset — jadi kartu file/terminal
     tetap ada saat proyek dibuka ulang. */
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [pendingDiscovery, setPendingDiscovery] = useState<string | null>(null)
  const [streamText, setStreamText] = useState('')
  const [changedFiles, setChangedFiles] = useState<string[]>([])
  const [files, setFiles] = useState<{ path: string }[]>([])
  const [previewPort, setPreviewPort] = useState<number>(0)
  const [previewOn, setPreviewOn] = useState(false)
  const [inlineEvents, setInlineEvents] = useState<InlineEvent[]>([])
  const [contextPaths, setContextPaths] = useState<string[]>([])
  const [booting, setBooting] = useState(false)
  const [status, setStatus] = useState('')
  const [plan, setPlan] = useState<ChatPlan | null>(null)
  const [audit, setAudit] = useState<ChatAudit | null>(null)
  const [buildLog, setBuildLog] = useState<{ ok: boolean; log: string } | null>(null)
  const [openFile, setOpenFile] = useState<string | null>(() => loadView(projectId).file)
  const [fileContent, setFileContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [name, setName] = useState('')
  const [sending, setSending] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [slug, setSlug] = useState<string | null>(null)
  const [publishing, setPublishing] = useState(false)
  const [publishMsg, setPublishMsg] = useState('')
  const [pubUrl, setPubUrl] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [usage, setUsage] = useState<{ requests: number; promptTokens: number; completionTokens: number } | null>(null)
  const [model, setModel] = useState(() => localStorage.getItem('vb-model') ?? 'auto')
  const [modelNotice, setModelNotice] = useState('')

  /* Validasi pilihan tersimpan saat builder dibuka: bila model sudah tidak
     aktif lagi (dimatikan admin), fallback ke 'auto' + pesan jelas — jangan
     kirim model mati ke server. SettingsSheet mengulang validasi ini tiap
     dibuka (daftar segar); di sini cukup sekali saat mount. */
  useEffect(() => {
    let alive = true
    getPickerModels()
      .then(({ options, fromFallback }) => {
        if (!alive || fromFallback) return
        setModel((cur) => {
          if (isSelectionAvailable(cur, options)) return cur
          localStorage.setItem('vb-model', MODEL_AUTO)
          setModelNotice(`Model tersimpan (${cur}) sudah tidak aktif — kembali ke Auto.`)
          window.setTimeout(() => alive && setModelNotice(''), 15000)
          return MODEL_AUTO
        })
      })
      .catch(() => { /* fallback: biarkan pilihan apa adanya */ })
    return () => {
      alive = false
    }
  }, [])
  /* Route adalah sumber kebenaran: /chat, /file, /database. Berpindah URL
     (kembali, refresh, tautan langsung) selalu mengarahkan panel yang benar. */
  useEffect(() => {
    setTab(routeTab === 'file' ? 'code' : 'chat')
    if (routeTab === 'file' && openFile) saveView(projectId, { tab: 'code', file: openFile })
  }, [routeTab, projectId, openFile])

  const [planMode, setPlanMode] = useState(false)
  const [pendingPlan, setPendingPlan] = useState<{ prompt: string; imageIds: string[] } | null>(null)
  const [awaitingConfirm, setAwaitingConfirm] = useState(false)
  const { entries: activity, push: pushActivity, reset: resetActivity } = useActivity()
  const abortRef = useRef<AbortController | null>(null)

  /* Muat daftar file sekali saat workspace dipasang. State `filesReady`
     membedakan "belum selesai dimuat" dari "benar-benar kosong": panel Kode
     tidak boleh berbohong "Belum ada file" hanya karena request masih
     berjalan (endpoint bisa memakan beberapa detik). */
  const [filesReady, setFilesReady] = useState(false)
  const load = async () => {
    const d = await api.getProject(projectId)
    setMessages(d.messages.map((m) => ({ role: m.role, content: m.content, id: m.id, created_at: m.created_at })))
    setEvents(d.events ?? [])
    setFiles(d.files.map((f) => ({ path: f.path })))
    setFilesReady(true)
    setName(d.project.name)
    setPreviewPort(d.previewPort)
    setSlug(d.project.slug ?? null)
    setPubUrl(d.project.slug ? publicUrl(d.project.slug) : null)
    // Rencana yang menunggu persetujuan: tampilkan lagi kartunya bila user
    // kembali sesudah keluar (disimpan server saat gerbang konfirmasi).
    if (d.pendingPlan) {
      setPlan(d.pendingPlan.plan)
      setPendingPlan({ prompt: d.pendingPlan.prompt, imageIds: d.pendingPlan.plan.imageIds ?? [] })
      setAwaitingConfirm(true)
    } else {
      setPlan(null)
      setPendingPlan(null)
      setAwaitingConfirm(false)
    }
    const st = await api.previewStatus(projectId)
    setPreviewOn(st.running)
    return d
  }

  useEffect(() => {
    void load().then((d) => {
      /* File dibuka ulang hanya bila route memang /file, atau user nieuwe
         masuk lewat /proyek/:id dengan state tersimpan (kompatibilitas). */
      const saved = loadView(projectId)
      if (saved.tab === 'code' && saved.file && routeTab === 'file') void openFileAt(saved.file)
      /* Prompt-first (hero dashboard): proyek dibuat dengan prompt — kirim
         otomatis sekali saat pertama dibuka (belum ada pesan). Sesudah run
         pertama, messages sudah terisi sehingga tidak terulang. */
      if (d && d.messages.length === 0 && d.project.prompt?.trim()) void send(d.project.prompt.trim())
    })
    void api.usage().then(setUsage).catch(() => {})
    return () => abortRef.current?.abort()
  }, [projectId])

  /* One-view: simpan tab + file yang dibuka tiap berubah supaya kembali dari
     daftar proyek langsung ke tampilan yang sama, bukan mulai dari Chat. */
  useEffect(() => {
    if (routeTab === 'file' || routeTab === 'chat') saveView(projectId, { tab, file: openFile })
  }, [projectId, tab, openFile, routeTab])

  /* Ambil ulang kartu aktivitas persisten dari server sesudah run selesai:
     event run ini sudah ditulis server selama streaming, jadi tampil di
     transcript tanpa reload halaman. */
  const refreshEvents = async () => {
    try {
      const r = await api.events(projectId)
      setEvents(r.events ?? [])
      /* Samakan bubble dengan server (stempel waktu server) supaya kartu
         aktivitas tersusun kronologis dengan benar terhadap pesan; bubble
         lokal yang tidak ada di server (tanya-jawab discovery, error)
         dipertahankan, dan salinan lokal dari pesan yang sudah tersimpan
         di server dibuang supaya tidak dobel. */
      setMessages((prev) => {
        const server = r.messages ?? []
        const known = new Set(server.map((m) => `${m.role}\n${m.content}`))
        const localOnly = prev.filter((m) => {
          if (m.id !== undefined) return false
          if (known.has(`${m.role}\n${m.content}`)) return false
          /* Bubble visual-edit (🎯) adalah tampilan ringkas dari pesan user
             yang sama yang tersimpan di server (prompt panjang) — buang
             salinan lokalnya bila pesan servernya sudah ada. */
          if (m.role === 'user' && m.content.startsWith('🎯 ')) {
            return !server.some(
              (sm) => sm.role === 'user' && (sm.created_at ?? 0) >= (m.created_at ?? 0) - 5000,
            )
          }
          return true
        })
        const merged = [
          ...server.map((m) => ({ role: m.role, content: m.content, id: m.id, created_at: m.created_at })),
          ...localOnly,
        ]
        return merged.sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0))
      })
    } catch {
      /* kartu persisten gagal disegarkan: feed live sudah menampilkan run ini */
    }
  }

  const autoPreview = async () => {
    try {
      const p = await api.preview(projectId)
      setPreviewPort(p.port)
      setPreviewOn(true)
      setDirty(false)
    } catch {
      /* preview belum siap, tombol Jalankan tetap tersedia */
    }
  }

  const send = async (text: string, optsConfirmed = false, imageIds: string[] = []) => {
    if (!text.trim() || sending) return

    // Ask discovery only for the first user request. If the model needs details,
    // show its questions in chat and wait; otherwise continue straight to build.
    if (pendingDiscovery) {
      text = `Permintaan awal: ${pendingDiscovery}\n\nJawaban/konteks tambahan dari pemilik: ${text.trim()}`
      setPendingDiscovery(null)
    } else if (messages.length === 0) {
      try {
        const discovery = await api.discovery(text.trim())
        if (!discovery.ready && discovery.questions.length) {
          setPendingDiscovery(text.trim())
          setMessages((m) => [...m, { role: 'user', content: text.trim(), created_at: Date.now() }, { role: 'assistant', content: discovery.questions.map((q, i) => `${i + 1}. ${q}`).join('\n'), created_at: Date.now() }])
          return
        }
      } catch { /* Discovery is advisory; continue building if unavailable. */ }
    }

    setSending(true)
    setStatus('menyiapkan')
    setPlan(null)
    setAudit(null)
    setStreamText('')
    setChangedFiles([])
    setInlineEvents([])
    resetActivity()
    setContextPaths([])
    pushActivity({ kind: 'status', text: 'menyiapkan', at: Date.now() })
    if (!optsConfirmed) setPendingPlan({ prompt: text, imageIds })
    else setPendingPlan(null)
    setAwaitingConfirm(false)
    // Run konfirmasi = lanjutan dari prompt yang sama; jangan tampilkan bubble user dua kali.
    if (!optsConfirmed) setMessages((m) => [...m, { role: 'user', content: text, created_at: Date.now() }])

    const ctrl = new AbortController()
    abortRef.current = ctrl
    let didAwaitConfirm = false

    const handlers: ChatHandlers = {
      onStatus: (t) => {
        setStatus(t)
        pushActivity({ kind: 'status', text: t, at: Date.now() })
      },
      onPlan: (event) => setPlan(event),
      onAudit: (event) => setAudit(event),
      onFile: async (path, action) => {
        pushActivity({ kind: 'file', path, action, at: Date.now() })
        if (action !== 'mkdir') setInlineEvents((prev) => [...prev, { kind: 'file', path, action }])
        const { files } = await api.files(projectId)
        setFiles(files.map((f) => ({ path: f.path })))
        if (action === 'mkdir') return // folder baru: bukan file yang diubah, tak perlu preview ulang
        if (path) setChangedFiles((prev) => (prev.includes(path) ? prev : [...prev, path]))
        setDirty(true)
        if (previewOn) void reloadPreview()
      },
      onBuild: (ok, log) => {
        setBuildLog({ ok, log })
        pushActivity({ kind: 'terminal', title: 'npm run build', log, ok, at: Date.now() })
        setInlineEvents((prev) => [...prev, { kind: 'terminal', title: 'npm run build', log, ok }])
        if (!ok) navigate(`/proyek/${projectId}/file`)
      },
      onInstall: (ok, log) => {
        pushActivity({ kind: 'terminal', title: 'npm install', log, ok, at: Date.now() })
        setInlineEvents((prev) => [...prev, { kind: 'terminal', title: 'npm install', log, ok }])
      },
      onAssistantDelta: (d) => {
        setStreamText((prev) => {
          const next = prev + d
          setStatus('')
          return next
        })
      },
      onAssistant: (t) => {
        setStreamText('')
        setMessages((m) => [...m, { role: 'assistant', content: t, created_at: Date.now() }])
      },
      onAwaitingConfirmation: () => {
        // Gerbang konfirmasi: rencana sudah tampil di chat; tunggu tombol "Setujui".
        didAwaitConfirm = true
        setStatus('')
        setAwaitingConfirm(true)
        setMessages((m) => [...m, { role: 'assistant', content: 'Rencana sudah ditampilkan. Setujui untuk mulai dibangun, atau tulis perubahan yang diinginkan.', created_at: Date.now() }])
      },
      onContext: (paths) => {
        setContextPaths((prev) => Array.from(new Set([...prev, ...paths])))
      },
      onScreenshot: () => {
        /* Screenshot datang sesudah event file/terminal run ini tersimpan di
           server (persisten) — bersihkan salinan live-nya yang sudah ada di
           persistent set supaya kartu tidak tampil dua kali sampai onDone. */
        void load().then((d) => {
          const persisted = new Set(
            (d.events ?? []).map((e) =>
              e.kind === 'file' ? `file\n${e.label}\n${e.action ?? ''}` : `terminal\n${e.label}`,
            ),
          )
          setInlineEvents((prev) =>
            prev.filter((ev) => {
              const key = ev.kind === 'file' ? `file\n${ev.path}\n${ev.action}` : `terminal\n${ev.title}`
              return !persisted.has(key)
            }),
          )
        })
      },
      onPublished: (newSlug, url) => {
        setSlug(newSlug)
        setPubUrl(url)
        setDirty(false)
        pushActivity({ kind: 'status', text: `Web publik diperbarui: ${newSlug}`, at: Date.now() })
      },
      onError: (t) => {
        setStreamText('')
        setMessages((m) => [...m, { role: 'error', content: t, created_at: Date.now() }])
        /* Run gagal di tengah jalan: file/terminal yang sempat terjadi sudah
           tersimpan server — tampilkan sebagai kartu persisten, dan
           singkirkan salinan live-nya supaya tidak dobel. */
        setInlineEvents([])
        void refreshEvents()
        /* Run yang gagal di tengah jalan bisa tetap memotong credit
           (deduct atas usage sebagian) — segarkan chip saldo. */
        notifyBalanceChanged()
      },
      onDone: () => {
        // Jawaban yang di-stream (konsultasi & narasi) hidup di streamText.
        // Saat run selesai, simpan sebagai bubble permanen — kalau tidak,
        // bubble chat hilang begitu run berakhir / halaman dimuat ulang.
        setStreamText((streamed) => {
          const clean = streamed.trim()
          if (clean) setMessages((m) => [...m, { role: 'assistant', content: clean, created_at: Date.now() }])
          return ''
        })
        setStatus('')
        /* Fase 3: saldo berkurang sesudah run — segarkan chip tanpa refresh. */
        notifyBalanceChanged()
        /* Kartu persisten: ganti feed live run ini dengan kartu dari server
           (sudah termasuk semua file/terminal run ini) supaya tidak dobel. */
        setInlineEvents([])
        void refreshEvents()
        void api.files(projectId).then(({ files }) => setFiles(files.map((f) => ({ path: f.path }))))
        // Saat gerbang konfirmasi aktif, jangan jalankan preview: belum ada
        // perubahan file dan dist bisa belum ada (menghindari 500 yang sia-sia).
        if (!didAwaitConfirm) void autoPreview()
      },
    }

    try {
      /* Wire ke server HANYA bare model id (auto → undefined = default
         server). Prefix provider dari pilihan dilepas di sini — server
         belum punya format wire untuk provider (lihat models.ts). */
      await chatStream(projectId, text, handlers, ctrl.signal, { model: modelIdForServer(model), planMode, confirmPlan: true, confirmed: optsConfirmed, imageIds })
    } catch (err) {
      setMessages((m) => [...m, { role: 'error', content: (err as Error).message, created_at: Date.now() }])
    } finally {
      setSending(false)
      setStatus('')
      abortRef.current = null
    }
  }

  /* Visual edit: klik elemen di preview → agent menerima selector + teks +
     posisi, lalu mengubah file yang menaungi komponen tersebut. */
  const pickElement = (t: VisualTarget) => {
    if (sending) return
    const prompt = [
      'Ubah elemen yang saya pilih di preview.',
      `Tag: <${t.tag}>`,
      `Teks: ${t.label || '(tanpa teks)'}`,
      `Selector CSS: ${t.selector}`,
      `Posisi: x=${t.x} y=${t.y} ukuran=${t.width}x${t.height}`,
      'Cari komponen/file yang menaungi elemen ini (cocokkan teks/selector), lalu ubah hanya bagian yang diminta. Jawab singkat file apa yang diubah.',
    ].join('\n')
    setMessages((m) => [...m, { role: 'user', content: `🎯 ${t.label || t.tag} — ${t.selector}`, created_at: Date.now() }])
    void send(prompt)
  }

  const confirmPlanAndRun = async () => {
    if (!pendingPlan || sending) return
    const prompt = pendingPlan.prompt
    const imageIds = pendingPlan.imageIds ?? []
    setAwaitingConfirm(false)
    // Hapus pesan "menunggu persetujuan" lama dari tampilan.
    setMessages((m) => m.filter((x) => !(x.role === 'assistant' && x.content.startsWith('Rencana sudah ditampilkan'))))
    await send(prompt, true, imageIds)
  }

  const cancelPlan = async () => {
    if (!pendingPlan || sending) return
    try {
      await api.cancelPendingPlan(projectId)
    } catch {
      /* gagal hapus di server: tetap bersihkan tampilan */
    }
    setPlan(null)
    setPendingPlan(null)
    setAwaitingConfirm(false)
  }

  const startPreview = async () => {
    setBooting(true)
    try {
      const b = await api.build(projectId)
      if (!b.ok) {
        setBuildLog({ ok: false, log: b.log })
        navigate(`/proyek/${projectId}/file`)
        return
      }
      const p = await api.preview(projectId)
      setPreviewPort(p.port)
      setPreviewOn(true)
      setDirty(false)
    } catch (err) {
      setBuildLog({ ok: false, log: (err as Error).message })
    } finally {
      setBooting(false)
    }
  }

  const publish = async () => {
    setPublishing(true)
    setPublishMsg('')
    try {
      const r = await api.publish(projectId, slug ?? undefined)
      setSlug(r.slug)
      setPubUrl(r.url)
      setPreviewPort(r.port)
      setPreviewOn(true)
      setDirty(false)
    } catch (err) {
      setPublishMsg((err as Error).message)
    } finally {
      setPublishing(false)
    }
  }

  const unpublish = async () => {
    await api.unpublish(projectId)
    setSlug(null)
  }

  const reloadPreview = async () => {
    try {
      const p = await api.preview(projectId)
      setPreviewPort(p.port)
      setPreviewOn(true)
      setDirty(false)
    } catch {
      /* biarkan status lama */
    }
  }

  const openFileAt = async (path: string) => {
    setOpenFile(path)
    try {
      const f = await api.file(projectId, path)
      setFileContent(f.content)
      setSavedContent(f.content)
    } catch {
      setFileContent('')
      setSavedContent('')
      setBuildLog({ ok: false, log: `Gagal membaca ${path}` })
    }
  }

  const saveFile = async () => {
    if (!openFile) return
    await api.saveFile(projectId, openFile, fileContent)
    setSavedContent(fileContent)
    setBuildLog(null)
  }

  const rename = async () => {
    const next = name.trim()
    if (!next) return
    await api.renameProject(projectId, next)
    onTitle(next)
  }

  const unsaved = openFile !== null && fileContent !== savedContent

  /* Database adalah halaman penuh route-driven, bukan popup overlay. */
  if (routeTab === 'database') {
    return <DatabasePage projectId={projectId} onBack={() => navigate(`/proyek/${projectId}/chat`)} />
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-edge bg-surface px-4 max-md:h-12">
        <button
          onClick={() => navigate(`/proyek/${projectId}/chat`)}
          aria-label="Kembali ke chat"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-edge text-body transition-colors hover:bg-surface-muted max-md:h-11 max-md:w-11"
        >
          <Icon name="back" size={15} />
        </button>
        <label htmlFor="vb-project-name" className="sr-only">
          Nama proyek
        </label>
        <input
          id="vb-project-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={rename}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          className="min-w-0 max-w-[200px] flex-1 rounded border border-transparent bg-transparent px-1.5 py-1 text-[13px] font-medium text-body outline-none transition-colors hover:border-edge focus:border-edge max-sm:max-w-[130px]"
        />

        <div className="ml-auto flex items-center gap-2">
          {status && (
            <span className="hidden items-center gap-1.5 text-[11.5px] text-quiet xl:flex">
              <Spinner />
              {status}
            </span>
          )}
          {/* Fase 3: chip saldo credit menggantikan chip "N req" token server.
              Klik -> halaman Penggunaan. Saldo dimuat ulang sesudah tiap run
              lewat notifyBalanceChanged() di onDone/onError di bawah. */}
          <CreditChip />
          <SessionMenu projectId={projectId} usage={usage} />
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <section
          className={`flex min-w-0 flex-col border-r border-edge ${
            tab === 'chat' ? 'w-[46%] max-w-[600px] max-md:w-full max-md:max-w-none' : 'hidden'
          }`}
        >
          <ChatPanel
            projectId={projectId}
            messages={messages}
            sending={sending}
            status={status}
            plan={plan}
            audit={audit}
            streamText={streamText}
            activity={activity}
            onSend={(text, imageIds) => void send(text, false, imageIds ?? [])}
            onCancel={() => abortRef.current?.abort()}
            onConfirmPlan={confirmPlanAndRun}
            onCancelPlan={cancelPlan}
            awaitingConfirm={awaitingConfirm}
            onOpenSettings={() => setSettingsOpen(true)}
            waitingForDiscovery={!!pendingDiscovery}
            inlineEvents={inlineEvents}
            contextPaths={contextPaths}
            events={events}
            onOpenFile={(path) => {
              navigate(`/proyek/${projectId}/file`)
              void openFileAt(path)
            }}
            previewOpen={previewOn && !sending}
            previewUrl={slug ? publicUrl(slug) : previewPort ? `http://127.0.0.1:${previewPort}/` : ''}
          />
        </section>

        <section className={`flex min-w-0 flex-1 flex-col ${routeTab === 'chat' ? 'max-md:hidden' : ''}`}>
          {routeTab === 'chat' ? (
            <PreviewPane
              previewOn={previewOn}
              previewPort={previewPort}
              projectId={projectId}
              onPick={pickElement}
              dirty={dirty}
              buildLog={buildLog}
              onRun={startPreview}
              booting={booting}
              hasFiles={files.length > 0}
            />
          ) : routeTab === 'file' ? (
            <CodePane
              files={files}
              filesReady={filesReady}
              openFile={openFile}
              content={fileContent}
              buildLog={buildLog}
              changedFiles={changedFiles}
              projectId={projectId}
              onOpen={openFileAt}
              onChange={setFileContent}
              onSave={saveFile}
              onBuild={startPreview}
              onFilesRefresh={() => void api.files(projectId).then(({ files }) => { setFiles(files.map((f) => ({ path: f.path }))); setFilesReady(true) })}
            />
          ) : routeTab === 'jalankan' ? (
            <RunPane running={booting} buildLog={buildLog} hasFiles={files.length > 0} dirty={dirty} onRun={() => void startPreview()} onBack={() => navigate(`/proyek/${projectId}/chat`)} />
          ) : routeTab === 'terbitkan' ? (
            <PublishPane slug={slug} pubUrl={pubUrl} publishing={publishing} publishMsg={publishMsg} canPublish={files.length > 0} onPublish={publish} onUnpublish={() => void unpublish()} onBack={() => navigate(`/proyek/${projectId}/chat`)} />
          ) : routeTab === 'export' ? (
            <ExportPane canExport={files.length > 0} onExport={() => void exportProjectZip(projectId).catch(() => {})} onBack={() => navigate(`/proyek/${projectId}/chat`)} />
          ) : routeTab === 'tampilan' ? (
            <AppearancePane dark={dark} onToggle={toggle} onBack={() => navigate(`/proyek/${projectId}/chat`)} />
          ) : null}
        </section>
      </div>

      <SettingsSheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        projectId={projectId}
        projectName={name}
        model={model}
        onModel={(m) => {
          setModel(m)
          localStorage.setItem('vb-model', m)
        }}
        planMode={planMode}
        onPlanMode={setPlanMode}
      />

      {publishMsg && (
        <p className="shrink-0 border-t border-edge bg-surface px-3 py-1.5 text-[11px] text-accent">
          {publishMsg}
        </p>
      )}

      {modelNotice && (
        <p className="shrink-0 border-t border-edge bg-surface px-3 py-1.5 text-[11px] text-accent">
          {modelNotice}
        </p>
      )}

      {unsaved && (
        <p className="shrink-0 border-t border-edge bg-surface px-3 py-1.5 text-[11px] text-accent">
          Perubahan pada {openFile} belum disimpan. Tekan Simpan sebelum build.
        </p>
      )}
    </div>
  )
}

/* Panel aksi: route hanya menampilkan halaman; efek samping terjadi saat
   tombol eksplisit ditekan, tidak saat URL dibuka atau di-refresh. */
function PanelShell({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <div className="vb-scroll h-full overflow-y-auto bg-surface px-4 py-5 max-md:px-3">
      <h2 className="font-display text-[17px] text-body">{title}</h2>
      <p className="mt-1 max-w-[640px] text-[12px] leading-relaxed text-quiet">{note}</p>
      <div className="mt-4 max-w-[640px]">{children}</div>
    </div>
  )
}

function RunPane({ running, buildLog, hasFiles, dirty, onRun, onBack }: {
  running: boolean; buildLog: { ok: boolean; log: string } | null; hasFiles: boolean; dirty: boolean
  onRun: () => void; onBack: () => void
}) {
  return (
    <PanelShell title="Jalankan proyek" note="Build kode lalu nyalakan preview. Perubahan yang belum disimpan akan ikut dibangun bila sudah ada di server.">
      <button onClick={onRun} disabled={running || !hasFiles} className="vb-btn-primary h-10 px-4">
        <Icon name="run" size={13} /> {running ? 'Sedang build…' : 'Build & jalankan preview'}
      </button>
      {dirty && <p className="mt-3 border-l-2 border-accent pl-2 text-[11.5px] text-body">Ada file yang belum disimpan — simpan dulu di menu Lihat file agar hasil build sesuai editor.</p>}
      {buildLog && (
        <pre className="vb-scroll mt-4 max-h-[320px] overflow-auto rounded-lg border border-edge bg-surface-muted p-3 font-mono text-[11px] leading-relaxed text-body">{buildLog.log}</pre>
      )}
      <button onClick={onBack} className="mt-4 text-[12px] text-quiet underline hover:text-body">Kembali ke chat</button>
    </PanelShell>
  )
}

function PublishPane({ slug, pubUrl, publishing, publishMsg, canPublish, onPublish, onUnpublish, onBack }: {
  slug: string | null; pubUrl: string | null; publishing: boolean; publishMsg: string; canPublish: boolean
  onPublish: () => void; onUnpublish: () => void; onBack: () => void
}) {
  return (
    <PanelShell title="Terbitkan website" note="Website dipublikasikan ke subdomain clidi.net. Publikasi ulang hanya berjalan saat tombol ditekan.">
      {slug ? (
        <>
          <p className="text-[12.5px] text-body">Sudah tayang di <a href={pubUrl ?? '#'} target="_blank" rel="noreferrer" className="text-accent underline">{slug}.clidi.net</a></p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button onClick={() => void onPublish()} disabled={publishing || !canPublish} className="vb-btn-primary h-10 px-4 disabled:opacity-50">Perbarui publikasi</button>
            <button onClick={onUnpublish} disabled={publishing} className="vb-btn-ghost h-10 px-4 disabled:opacity-50">Tarik publikasi</button>
          </div>
        </>
      ) : (
        <button onClick={() => void onPublish()} disabled={publishing || !canPublish} className="vb-btn-primary h-10 px-4 disabled:opacity-50">
          <Icon name="check" size={13} /> {publishing ? 'Menerbitkan…' : 'Terbitkan sekarang'}
        </button>
      )}
      {!canPublish && <p className="mt-3 text-[11.5px] text-quiet">Build proyek dulu sebelum menerbitkan.</p>}
      {publishMsg && <p className="mt-3 border-l-2 border-accent pl-2 text-[12px] text-body">{publishMsg}</p>}
      <button onClick={onBack} className="mt-4 text-[12px] text-quiet underline hover:text-body">Kembali ke chat</button>
    </PanelShell>
  )
}

function ExportPane({ canExport, onExport, onBack }: { canExport: boolean; onExport: () => void; onBack: () => void }) {
  return (
    <PanelShell title="Export ZIP" note="Unduh seluruh file proyek sebagai arsip ZIP. Proyek lain tidak ikut terunduh.">
      <button onClick={onExport} disabled={!canExport} className="vb-btn-primary h-10 px-4 disabled:opacity-50">
        <Icon name="download" size={13} /> Unduh ZIP proyek
      </button>
      {!canExport && <p className="mt-3 text-[11.5px] text-quiet">Belum ada file untuk diexport.</p>}
      <button onClick={onBack} className="mt-4 text-[12px] text-quiet underline hover:text-body">Kembali ke chat</button>
    </PanelShell>
  )
}

function AppearancePane({ dark, onToggle, onBack }: { dark: boolean; onToggle: () => void; onBack: () => void }) {
  return (
    <PanelShell title="Mode tampilan" note="Pilih tema editor. Pengaturan ini tersimpan di perangkat ini dan tidak mengubah website yang kamu bangun.">
      <div className="grid gap-2 sm:grid-cols-2">
        <button onClick={() => { if (dark) onToggle() }} aria-pressed={!dark} className={`vb-card p-4 text-left text-[12.5px] transition-colors ${!dark ? 'border-accent bg-accent-soft text-body' : 'text-quiet'}`}>
          Terang {!dark && '· aktif'}
        </button>
        <button onClick={() => { if (!dark) onToggle() }} aria-pressed={dark} className={`vb-card p-4 text-left text-[12.5px] transition-colors ${dark ? 'border-accent bg-accent-soft text-body' : 'text-quiet'}`}>
          Gelap {dark && '· aktif'}
        </button>
      </div>
      <button onClick={onBack} className="mt-4 text-[12px] text-quiet underline hover:text-body">Kembali ke chat</button>
    </PanelShell>
  )
}

function TabBtn({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <Button
      onClick={onClick}
      aria-pressed={active}
      size="sm"
      variant="ghost"
      className={`h-7 max-md:h-11 ${active ? 'bg-accent text-on-accent' : 'text-quiet'}`}
    >
      {label}
    </Button>
  )
}

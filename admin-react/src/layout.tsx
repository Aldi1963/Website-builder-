import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Bell,
  CaretDown,
  Gear,
  List,
  Moon,
  SignOut,
  Sun,
  Warning,
  X,
} from '@phosphor-icons/react'
import { useAuth } from './lib/auth'
import { NavLink, navigate } from './lib/router'
import { api } from './lib/api'
import { ADMIN_SECTION_SLUGS, ROUTES, SITE_LINK } from './routes'
import { Badge } from './components/Badge'

/* Bentuk respons (diringkas dari server/src/admin.ts). */
interface OverviewResponse {
  users: { total: number }
  projects: { total: number }
  recent: { kind: string; text: string; at: number }[]
}

interface AlertItem {
  level: 'warning' | 'critical'
  kind: string
  message: string
  at: number
}

interface HealthResponse {
  llm: { reachable: boolean }
}

interface NotifItem {
  kind: 'alert' | 'activity'
  level?: 'warning' | 'critical'
  text: string
  at: number
  href: string
}

function timeAgo(ts: number): string {
  if (!ts) return '–'
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return 'baru saja'
  if (s < 3600) return `${Math.floor(s / 60)} mnt lalu`
  if (s < 86400) return `${Math.floor(s / 3600)} jam lalu`
  return `${Math.floor(s / 86400)} hari lalu`
}

function readTheme(): 'light' | 'dark' {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

export function AdminLayout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [theme, setTheme] = useState<'light' | 'dark'>(readTheme)
  const [usersCount, setUsersCount] = useState<number | null>(null)
  const [projectsCount, setProjectsCount] = useState<number | null>(null)
  const [healthOk, setHealthOk] = useState<boolean | null>(null)
  const [notifs, setNotifs] = useState<NotifItem[]>([])
  const [notifOpen, setNotifOpen] = useState(false)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const notifRef = useRef<HTMLDivElement>(null)
  const userMenuRef = useRef<HTMLDivElement>(null)

  /* Badge nav + notifikasi: sumber data SAMA seperti admin.js lama.
     - nav users/projects: GET /api/admin/overview (users.total, projects.total)
     - badge health: GET /api/admin/health (llm.reachable → "OK" / "LLM mati")
     - lonceng: GET /api/admin/alerts + overview.recent (5 item terakhir);
       badge = jumlah alert + aktivitas. Semua best-effort: gagal memuat
       tidak boleh merusak layout (badge cukup disembunyikan). */
  useEffect(() => {
    let cancelled = false
    api
      .get<OverviewResponse>('/api/admin/overview')
      .then((ov) => {
        if (cancelled) return
        setUsersCount(ov.users.total)
        setProjectsCount(ov.projects.total)
        setNotifs((prev) => {
          const alerts = prev.filter((n) => n.kind === 'alert')
          const activity: NotifItem[] = (ov.recent ?? []).slice(0, 5).map((r) => ({
            kind: 'activity',
            text: r.text,
            at: r.at,
            href: '/admin',
          }))
          return [...alerts, ...activity]
        })
      })
      .catch(() => {})
    api
      .get<{ alerts: AlertItem[] }>('/api/admin/alerts')
      .then((data) => {
        if (cancelled) return
        const alerts: NotifItem[] = (data.alerts ?? []).map((a) => ({
          kind: 'alert',
          level: a.level,
          text: a.message,
          at: a.at,
          href: '/admin/health',
        }))
        setNotifs((prev) => [...alerts, ...prev.filter((n) => n.kind === 'activity')])
      })
      .catch(() => {})
    api
      .get<HealthResponse>('/api/admin/health')
      .then((h) => {
        if (!cancelled) setHealthOk(h.llm.reachable)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  /* Tutup dropdown bila klik di luar. */
  useEffect(() => {
    if (!notifOpen && !userMenuOpen) return
    const onClick = (e: globalThis.MouseEvent) => {
      const t = e.target as Node
      if (notifOpen && notifRef.current && !notifRef.current.contains(t)) setNotifOpen(false)
      if (userMenuOpen && userMenuRef.current && !userMenuRef.current.contains(t)) setUserMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setNotifOpen(false)
        setUserMenuOpen(false)
        setSidebarOpen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [notifOpen, userMenuOpen])

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    document.documentElement.classList.toggle('dark', next === 'dark')
    try {
      localStorage.setItem('theme', next)
    } catch {
      /* abaikan */
    }
  }

  const closeSidebar = () => setSidebarOpen(false)
  const fmtNum = (n: number) => n.toLocaleString('id-ID')
  const badgeFor = (slug: string): ReactNode => {
    if (slug === 'users' && usersCount !== null) return <Badge tone="accent">{fmtNum(usersCount)}</Badge>
    if (slug === 'projects' && projectsCount !== null) return <Badge tone="accent">{fmtNum(projectsCount)}</Badge>
    if (slug === 'health' && healthOk !== null) {
      return healthOk ? <Badge tone="success">OK</Badge> : <Badge tone="danger">LLM mati</Badge>
    }
    return null
  }

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <a
          href="/admin"
          onClick={(e) => {
            e.preventDefault()
            navigate('/admin')
            closeSidebar()
          }}
          className="text-lg font-bold text-accent"
        >
          VibeBuilder
        </a>
        <button
          type="button"
          aria-label="Tutup menu"
          onClick={closeSidebar}
          className="rounded p-1 text-muted hover:bg-surface-muted lg:hidden"
        >
          <X size={20} />
        </button>
      </div>
      <nav className="flex-1 overflow-y-auto px-3 py-3" aria-label="Menu admin">
        <ul className="space-y-0.5">
          {ROUTES.map((route) => {
            const Icon = route.icon
            const sectionStart = ADMIN_SECTION_SLUGS[0] === route.slug
            return (
              <li key={route.slug}>
                {sectionStart ? (
                  <p className="px-3 pt-4 pb-1 text-xs font-bold tracking-wide text-muted uppercase">
                    Admin
                  </p>
                ) : null}
                <NavLink
                  to={route.path}
                  onClick={closeSidebar}
                  className={(active) =>
                    `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm ${
                      active
                        ? 'bg-accent-soft font-semibold text-accent'
                        : 'text-ink hover:bg-surface-muted'
                    }`
                  }
                >
                  <Icon size={18} className="shrink-0" />
                  <span className="flex-1 truncate">{route.title}</span>
                  {badgeFor(route.slug)}
                </NavLink>
              </li>
            )
          })}
          <li>
            <a
              href={SITE_LINK.href}
              className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-ink hover:bg-surface-muted"
            >
              <SITE_LINK.icon size={18} className="shrink-0" />
              <span className="flex-1 truncate">{SITE_LINK.title}</span>
            </a>
          </li>
        </ul>
      </nav>
      <div className="border-t border-border px-4 py-3 text-xs text-muted">© 2026 VibeBuilder Admin</div>
    </div>
  )

  return (
    <div className="min-h-full">
      {/* Sidebar desktop */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-border bg-surface lg:block">
        {sidebar}
      </aside>
      {/* Sidebar HP: off-canvas */}
      {sidebarOpen ? (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          aria-hidden="true"
          onClick={closeSidebar}
        />
      ) : null}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-72 max-w-[85vw] border-r border-border bg-surface transition-transform duration-200 lg:hidden ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
        aria-hidden={!sidebarOpen}
      >
        {sidebar}
      </aside>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 border-b border-border bg-surface">
          <div className="flex items-center gap-2 px-3 py-2.5 sm:px-4">
            <button
              type="button"
              aria-label="Buka menu"
              aria-expanded={sidebarOpen}
              onClick={() => setSidebarOpen((v) => !v)}
              className="rounded-lg p-2 text-ink hover:bg-surface-muted lg:hidden"
            >
              <List size={20} />
            </button>
            <a
              href="/admin"
              onClick={(e) => {
                e.preventDefault()
                navigate('/admin')
              }}
              className="text-base font-bold text-accent lg:hidden"
            >
              VibeBuilder
            </a>
            <span className="hidden text-sm font-semibold lg:block">Panel Admin</span>
            <div className="ml-auto flex items-center gap-1.5">
              <button
                type="button"
                onClick={toggleTheme}
                aria-label={theme === 'dark' ? 'Ganti ke tema terang' : 'Ganti ke tema gelap'}
                title="Ganti tema"
                className="rounded-lg border border-border p-2 hover:bg-surface-muted"
              >
                {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
              </button>

              <div className="relative" ref={notifRef}>
                <button
                  type="button"
                  onClick={() => {
                    setNotifOpen((v) => !v)
                    setUserMenuOpen(false)
                  }}
                  aria-label="Notifikasi"
                  aria-expanded={notifOpen}
                  className="relative rounded-lg border border-border p-2 hover:bg-surface-muted"
                >
                  <Bell size={18} />
                  {notifs.length > 0 ? (
                    <span className="absolute -top-1.5 -right-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-danger px-1 text-[11px] font-bold text-white">
                      {notifs.length}
                    </span>
                  ) : null}
                </button>
                {notifOpen ? (
                  <div className="absolute right-0 z-50 mt-2 w-[min(360px,calc(100vw-24px))] overflow-hidden rounded-xl border border-border bg-surface shadow-lg">
                    <p className="border-b border-border px-4 py-2.5 text-sm font-semibold">Notifikasi</p>
                    <div className="max-h-[60vh] overflow-y-auto">
                      {notifs.length === 0 ? (
                        <p className="px-4 py-6 text-center text-sm text-muted">Belum ada aktivitas.</p>
                      ) : (
                        <ul>
                          {notifs.some((n) => n.kind === 'alert') ? (
                            <li className="border-b border-border px-4 pt-2 pb-1 text-xs font-bold tracking-wide text-warning uppercase">
                              Peringatan
                            </li>
                          ) : null}
                          {notifs.map((n, i) => (
                            <li key={`${n.kind}-${i}`} className="border-b border-border last:border-b-0">
                              <a
                                href={n.href}
                                onClick={(e) => {
                                  e.preventDefault()
                                  navigate(n.href)
                                  setNotifOpen(false)
                                  closeSidebar()
                                }}
                                className="block px-4 py-2.5 text-sm hover:bg-surface-muted"
                              >
                                <span className="flex items-start gap-2">
                                  {n.kind === 'alert' ? (
                                    <Warning
                                      size={16}
                                      weight="fill"
                                      className={`mt-0.5 shrink-0 ${n.level === 'critical' ? 'text-danger' : 'text-warning'}`}
                                    />
                                  ) : null}
                                  <span className="min-w-0 flex-1 break-words">{n.text}</span>
                                </span>
                                <span className="mt-0.5 block pl-6 text-xs text-muted">{timeAgo(n.at)}</span>
                              </a>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <a
                      href="/admin"
                      onClick={(e) => {
                        e.preventDefault()
                        navigate('/admin')
                        setNotifOpen(false)
                      }}
                      className="block border-t border-border px-4 py-2.5 text-center text-sm hover:bg-surface-muted"
                    >
                      Lihat semua aktivitas
                    </a>
                  </div>
                ) : null}
              </div>

              <div className="relative" ref={userMenuRef}>
                <button
                  type="button"
                  onClick={() => {
                    setUserMenuOpen((v) => !v)
                    setNotifOpen(false)
                  }}
                  aria-expanded={userMenuOpen}
                  className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-sm hover:bg-surface-muted"
                >
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent text-xs font-bold text-white">
                    {(user?.name || user?.email || 'A').slice(0, 1).toUpperCase()}
                  </span>
                  <span className="hidden max-w-40 truncate md:inline">{user?.email ?? 'Admin'}</span>
                  <CaretDown size={14} className="text-muted" />
                </button>
                {userMenuOpen ? (
                  <div className="absolute right-0 z-50 mt-2 w-56 overflow-hidden rounded-xl border border-border bg-surface shadow-lg">
                    <p className="truncate border-b border-border px-4 py-2.5 text-sm font-semibold">
                      {user?.email ?? 'Admin'}
                    </p>
                    <a
                      href="/admin/settings"
                      onClick={(e) => {
                        e.preventDefault()
                        navigate('/admin/settings')
                        setUserMenuOpen(false)
                      }}
                      className="flex items-center gap-2 px-4 py-2.5 text-sm hover:bg-surface-muted"
                    >
                      <Gear size={16} /> Pengaturan
                    </a>
                    <a href="/" className="flex items-center gap-2 px-4 py-2.5 text-sm hover:bg-surface-muted">
                      <SITE_LINK.icon size={16} /> Kembali ke Builder
                    </a>
                    <button
                      type="button"
                      onClick={() => void logout()}
                      className="flex w-full items-center gap-2 border-t border-border px-4 py-2.5 text-left text-sm hover:bg-surface-muted"
                    >
                      <SignOut size={16} /> Keluar
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </header>

        <main id="main-content" className="mx-auto w-full max-w-6xl px-4 py-5 sm:px-6">
          {children}
        </main>
      </div>
    </div>
  )
}

import { lazy, type ComponentType, type LazyExoticComponent } from 'react'
import {
  Archive,
  ArrowSquareOut,
  ChartLine,
  ChatText,
  ClockCounterClockwise,
  Coins,
  CreditCard,
  Cube,
  CurrencyDollar,
  Flag,
  Gauge,
  Gear,
  Hammer,
  Heartbeat,
  Key,
  Link as LinkIcon,
  Medal,
  Megaphone,
  Plug,
  Robot,
  Trash,
  Users,
  Wrench,
  type Icon,
} from '@phosphor-icons/react'

/* Tabel route admin. URUTAN dan LABEL mengikuti shell.html lama.
   Komponen diimpor lazy dari ./pages/<slug> — stub diganti halaman asli
   oleh agen halaman tanpa mengubah file ini (kecuali bila path berubah). */

export interface AdminRoute {
  slug: string
  path: string
  title: string
  icon: Icon
  component: LazyExoticComponent<ComponentType>
  /** Route redirect/legacy: tidak tampil di sidebar & pencarian header. */
  hidden?: boolean
}

/* Impor lazy eksplisit per halaman: Vite tidak bisa membundel
   import() dinamis dengan template tanpa ekstensi di bagian statis
   (peringatan vite-dynamic-import-vars), jadi jangan pakai
   lazy(() => import(`./pages/${slug}`)). */
const page = (slug: string) => {
  switch (slug) {
    case 'dashboard':
      return lazy(() => import('./pages/dashboard'))
    case 'users':
      return lazy(() => import('./pages/users'))
    case 'projects':
      return lazy(() =>
        import('./pages/konten').then((m) => ({ default: m.ProjectsRedirect })),
      )
    case 'moderasi':
      return lazy(() =>
        import('./pages/konten').then((m) => ({ default: m.ModerasiRedirect })),
      )
    case 'domain':
      return lazy(() =>
        import('./pages/konten').then((m) => ({ default: m.DomainRedirect })),
      )
    case 'konten':
      return lazy(() => import('./pages/konten'))
    case 'plans':
      return lazy(() =>
        import('./pages/monetisasi').then((m) => ({ default: m.PlansRedirect })),
      )
    case 'credits':
      return lazy(() =>
        import('./pages/monetisasi').then((m) => ({ default: m.CreditsRedirect })),
      )
    case 'monetisasi':
      return lazy(() => import('./pages/monetisasi'))
    case 'ai':
      return lazy(() => import('./pages/ai'))
    case 'usage':
      return lazy(() =>
        import('./pages/ai').then((m) => ({ default: m.UsageRedirect })),
      )
    case 'biaya':
      return lazy(() =>
        import('./pages/ai').then((m) => ({ default: m.BiayaRedirect })),
      )
    case 'providers':
      return lazy(() =>
        import('./pages/ai').then((m) => ({ default: m.ProvidersRedirect })),
      )
    case 'ai-settings':
      return lazy(() =>
        import('./pages/ai').then((m) => ({ default: m.AiSettingsRedirect })),
      )
    case 'billing':
      return lazy(() =>
        import('./pages/monetisasi').then((m) => ({ default: m.BillingRedirect })),
      )
    case 'builds':
      return lazy(() =>
        import('./pages/sistem').then((m) => ({ default: m.BuildsRedirect })),
      )
    case 'messages':
      return lazy(() =>
        import('./pages/komunikasi').then((m) => ({ default: m.MessagesRedirect })),
      )
    case 'pengumuman':
      return lazy(() =>
        import('./pages/komunikasi').then((m) => ({ default: m.PengumumanRedirect })),
      )
    case 'sessions':
      return lazy(() =>
        import('./pages/sistem').then((m) => ({ default: m.SessionsRedirect })),
      )
    case 'health':
      return lazy(() =>
        import('./pages/sistem').then((m) => ({ default: m.HealthRedirect })),
      )
    case 'cadangan':
      return lazy(() =>
        import('./pages/sistem').then((m) => ({ default: m.CadanganRedirect })),
      )
    case 'pembersihan':
      return lazy(() =>
        import('./pages/sistem').then((m) => ({ default: m.PembersihanRedirect })),
      )
    case 'audit':
      return lazy(() =>
        import('./pages/komunikasi').then((m) => ({ default: m.AuditRedirect })),
      )
    case 'pemeliharaan':
      return lazy(() =>
        import('./pages/sistem').then((m) => ({ default: m.PemeliharaanRedirect })),
      )
    case 'settings':
      return lazy(() =>
        import('./pages/sistem').then((m) => ({ default: m.SettingsRedirect })),
      )
    case 'komunikasi':
      return lazy(() => import('./pages/komunikasi'))
    case 'sistem':
      return lazy(() => import('./pages/sistem'))
    default:
      throw new Error(`Halaman tidak dikenal: ${slug}`)
  }
}

export const ROUTES: AdminRoute[] = [
  { slug: 'dashboard', path: '/admin', title: 'Dashboard', icon: Gauge, component: page('dashboard') },
  { slug: 'users', path: '/admin/users', title: 'Pengguna', icon: Users, component: page('users') },
  /* URL lama yang tergabung: redirect ke tab halaman baru (hidden di sidebar & search). */
  { slug: 'projects', path: '/admin/projects', title: 'Proyek', icon: Cube, component: page('projects'), hidden: true },
  { slug: 'moderasi', path: '/admin/moderasi', title: 'Moderasi', icon: Flag, component: page('moderasi'), hidden: true },
  { slug: 'domain', path: '/admin/domain', title: 'Domain', icon: LinkIcon, component: page('domain'), hidden: true },
  { slug: 'konten', path: '/admin/konten', title: 'Konten', icon: Cube, component: page('konten') },
  { slug: 'plans', path: '/admin/plans', title: 'Plan', icon: Medal, component: page('plans'), hidden: true },
  { slug: 'credits', path: '/admin/credits', title: 'Kelola Credit', icon: Coins, component: page('credits'), hidden: true },
  { slug: 'monetisasi', path: '/admin/monetisasi', title: 'Monetisasi', icon: Coins, component: page('monetisasi') },
  { slug: 'ai', path: '/admin/ai', title: 'AI', icon: Robot, component: page('ai') },
  /* URL lama halaman AI (redirect ke tab yang benar, tidak tampil di sidebar). */
  { slug: 'usage', path: '/admin/usage', title: 'Penggunaan', icon: ChartLine, component: page('usage'), hidden: true },
  { slug: 'biaya', path: '/admin/biaya', title: 'Biaya LLM', icon: CurrencyDollar, component: page('biaya'), hidden: true },
  { slug: 'providers', path: '/admin/providers', title: 'Provider LLM', icon: Plug, component: page('providers'), hidden: true },
  { slug: 'ai-settings', path: '/admin/ai-settings', title: 'Pengaturan AI', icon: Robot, component: page('ai-settings'), hidden: true },
  { slug: 'billing', path: '/admin/billing', title: 'Pembayaran', icon: CreditCard, component: page('billing'), hidden: true },
  { slug: 'builds', path: '/admin/builds', title: 'Build', icon: Hammer, component: page('builds'), hidden: true },
  { slug: 'messages', path: '/admin/messages', title: 'Pesan', icon: ChatText, component: page('messages'), hidden: true },
  { slug: 'pengumuman', path: '/admin/pengumuman', title: 'Pengumuman', icon: Megaphone, component: page('pengumuman'), hidden: true },
  { slug: 'sessions', path: '/admin/sessions', title: 'Sesi', icon: Key, component: page('sessions'), hidden: true },
  { slug: 'health', path: '/admin/health', title: 'Kesehatan', icon: Heartbeat, component: page('health'), hidden: true },
  { slug: 'cadangan', path: '/admin/cadangan', title: 'Cadangan', icon: Archive, component: page('cadangan'), hidden: true },
  { slug: 'pembersihan', path: '/admin/pembersihan', title: 'Pembersihan', icon: Trash, component: page('pembersihan'), hidden: true },
  { slug: 'audit', path: '/admin/audit', title: 'Log Audit', icon: ClockCounterClockwise, component: page('audit'), hidden: true },
  { slug: 'pemeliharaan', path: '/admin/pemeliharaan', title: 'Pemeliharaan', icon: Wrench, component: page('pemeliharaan'), hidden: true },
  { slug: 'settings', path: '/admin/settings', title: 'Pengaturan', icon: Gear, component: page('settings'), hidden: true },
  { slug: 'komunikasi', path: '/admin/komunikasi', title: 'Komunikasi', icon: ChatText, component: page('komunikasi') },
  { slug: 'sistem', path: '/admin/sistem', title: 'Sistem', icon: Wrench, component: page('sistem') },
]

/** Kelompok menu sidebar: label tampil di atas item pertama tiap seksi.
    URUTAN menu tidak berubah — seksi hanya memberi label, seperti label
    "Admin" di shell.html lama. */
export const ADMIN_SECTIONS: { label: string; slugs: string[] }[] = [
  { label: 'Utama', slugs: ['dashboard', 'users'] },
  { label: 'Konten', slugs: ['konten'] },
  { label: 'Layanan', slugs: ['monetisasi', 'ai'] },
  { label: 'Sistem', slugs: ['komunikasi', 'sistem'] },
]

/** Tautan keluar sidebar (bukan route admin). */
export const SITE_LINK = { title: 'Kembali ke Builder', href: '/', icon: ArrowSquareOut }

/** Cocokkan pathname dengan tabel route. Mendukung segmen `:param`
    (mis. '/admin/users/:id') untuk halaman detail nanti. */
export function matchRoute(
  pathname: string,
): { route: AdminRoute; params: Record<string, string> } | null {
  for (const route of ROUTES) {
    const pattern = route.path.split('/').filter(Boolean)
    const parts = pathname.split('/').filter(Boolean)
    if (pattern.length !== parts.length) continue
    const params: Record<string, string> = {}
    let ok = true
    for (let i = 0; i < pattern.length; i++) {
      if (pattern[i].startsWith(':')) {
        params[pattern[i].slice(1)] = decodeURIComponent(parts[i])
      } else if (pattern[i] !== parts[i]) {
        ok = false
        break
      }
    }
    if (ok) return { route, params }
  }
  return null
}

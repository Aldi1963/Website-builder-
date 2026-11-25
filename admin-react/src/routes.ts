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
      return lazy(() => import('./pages/projects'))
    case 'moderasi':
      return lazy(() => import('./pages/moderasi'))
    case 'domain':
      return lazy(() => import('./pages/domain'))
    case 'plans':
      return lazy(() => import('./pages/plans'))
    case 'credits':
      return lazy(() => import('./pages/credits'))
    case 'usage':
      return lazy(() => import('./pages/usage'))
    case 'biaya':
      return lazy(() => import('./pages/biaya'))
    case 'providers':
      return lazy(() => import('./pages/providers'))
    case 'billing':
      return lazy(() => import('./pages/billing'))
    case 'builds':
      return lazy(() => import('./pages/builds'))
    case 'messages':
      return lazy(() => import('./pages/messages'))
    case 'pengumuman':
      return lazy(() => import('./pages/pengumuman'))
    case 'sessions':
      return lazy(() => import('./pages/sessions'))
    case 'health':
      return lazy(() => import('./pages/health'))
    case 'cadangan':
      return lazy(() => import('./pages/cadangan'))
    case 'pembersihan':
      return lazy(() => import('./pages/pembersihan'))
    case 'audit':
      return lazy(() => import('./pages/audit'))
    case 'pemeliharaan':
      return lazy(() => import('./pages/pemeliharaan'))
    case 'ai-settings':
      return lazy(() => import('./pages/ai-settings'))
    case 'settings':
      return lazy(() => import('./pages/settings'))
    default:
      throw new Error(`Halaman tidak dikenal: ${slug}`)
  }
}

export const ROUTES: AdminRoute[] = [
  { slug: 'dashboard', path: '/admin', title: 'Dashboard', icon: Gauge, component: page('dashboard') },
  { slug: 'users', path: '/admin/users', title: 'Pengguna', icon: Users, component: page('users') },
  { slug: 'projects', path: '/admin/projects', title: 'Proyek', icon: Cube, component: page('projects') },
  { slug: 'moderasi', path: '/admin/moderasi', title: 'Moderasi', icon: Flag, component: page('moderasi') },
  { slug: 'domain', path: '/admin/domain', title: 'Domain', icon: LinkIcon, component: page('domain') },
  { slug: 'plans', path: '/admin/plans', title: 'Plan', icon: Medal, component: page('plans') },
  { slug: 'credits', path: '/admin/credits', title: 'Kelola Credit', icon: Coins, component: page('credits') },
  { slug: 'usage', path: '/admin/usage', title: 'Penggunaan', icon: ChartLine, component: page('usage') },
  { slug: 'biaya', path: '/admin/biaya', title: 'Biaya LLM', icon: CurrencyDollar, component: page('biaya') },
  { slug: 'providers', path: '/admin/providers', title: 'Provider LLM', icon: Plug, component: page('providers') },
  { slug: 'billing', path: '/admin/billing', title: 'Pembayaran', icon: CreditCard, component: page('billing') },
  { slug: 'builds', path: '/admin/builds', title: 'Build', icon: Hammer, component: page('builds') },
  { slug: 'messages', path: '/admin/messages', title: 'Pesan', icon: ChatText, component: page('messages') },
  { slug: 'pengumuman', path: '/admin/pengumuman', title: 'Pengumuman', icon: Megaphone, component: page('pengumuman') },
  { slug: 'sessions', path: '/admin/sessions', title: 'Sesi', icon: Key, component: page('sessions') },
  { slug: 'health', path: '/admin/health', title: 'Kesehatan', icon: Heartbeat, component: page('health') },
  { slug: 'cadangan', path: '/admin/cadangan', title: 'Cadangan', icon: Archive, component: page('cadangan') },
  { slug: 'pembersihan', path: '/admin/pembersihan', title: 'Pembersihan', icon: Trash, component: page('pembersihan') },
  { slug: 'audit', path: '/admin/audit', title: 'Log Audit', icon: ClockCounterClockwise, component: page('audit') },
  { slug: 'pemeliharaan', path: '/admin/pemeliharaan', title: 'Pemeliharaan', icon: Wrench, component: page('pemeliharaan') },
  { slug: 'ai-settings', path: '/admin/ai-settings', title: 'Pengaturan AI', icon: Robot, component: page('ai-settings') },
  { slug: 'settings', path: '/admin/settings', title: 'Pengaturan', icon: Gear, component: page('settings') },
]

/** Slug yang masuk kelompok "Admin" di sidebar (ada pemisah + label
    "Admin" sebelum Log Audit, seperti shell.html). */
export const ADMIN_SECTION_SLUGS = ['audit', 'pemeliharaan', 'ai-settings', 'settings']

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

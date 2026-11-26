import {
  createContext,
  useContext,
  useEffect,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { matchRoute, type AdminRoute } from '../routes'

/* Router history minimal, tanpa dependensi luar. Basename '/admin':
   path '/admin' = Dashboard, '/admin/users' = Pengguna, dst.
   Path di luar /admin (mis. '/') tidak dirender aplikasi ini. */

export const BASENAME = '/admin'

export const NAVIGATE_EVENT = 'vb:navigate'

export function navigate(path: string): void {
  window.history.pushState(null, '', path)
  window.dispatchEvent(new Event(NAVIGATE_EVENT))
}

export interface RouteMatch {
  /** Pathname penuh, mis. '/admin/users'. */
  path: string
  route: AdminRoute | null
  params: Record<string, string>
}

const RouteContext = createContext<RouteMatch>({ path: BASENAME, route: null, params: {} })

function currentMatch(): RouteMatch {
  const path = window.location.pathname
  const found = matchRoute(path)
  return { path, route: found?.route ?? null, params: found?.params ?? {} }
}

export function RouterProvider({ children }: { children: ReactNode }) {
  const [match, setMatch] = useState<RouteMatch>(currentMatch)

  useEffect(() => {
    const sync = () => setMatch(currentMatch())
    window.addEventListener('popstate', sync)
    window.addEventListener(NAVIGATE_EVENT, sync)
    return () => {
      window.removeEventListener('popstate', sync)
      window.removeEventListener(NAVIGATE_EVENT, sync)
    }
  }, [])

  return <RouteContext.Provider value={match}>{children}</RouteContext.Provider>
}

/** Route aktif saat ini: { path, route, params }. */
export function useRoute(): RouteMatch {
  return useContext(RouteContext)
}

interface NavLinkProps {
  to: string
  children: ReactNode
  className?: string | ((active: boolean) => string)
  exact?: boolean
  onClick?: () => void
  title?: string
}

/** Tautan internal. `active` bila path cocok (persis bila `exact`, atau
    awalan segmen bila tidak — mis. '/admin/users' aktif juga di
    '/admin/users/12'). */
export function NavLink({ to, children, className, exact = false, onClick, title }: NavLinkProps) {
  const { path } = useRoute()
  const active = exact ? path === to : path === to || (to !== BASENAME && path.startsWith(`${to}/`))
  const resolved = typeof className === 'function' ? className(active) : className
  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault()
    if (path !== to) navigate(to)
    onClick?.()
  }
  return (
    <a href={to} onClick={handleClick} aria-current={active ? 'page' : undefined} className={resolved} title={title}>
      {children}
    </a>
  )
}

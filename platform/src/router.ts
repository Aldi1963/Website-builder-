import { useEffect, useState } from 'react'

/* Minimal History-API router: enough for a handful of routes without
   adding a dependency. Paths are matched with simple patterns like
   '/proyek/:id'. Navigation triggers React re-render via popstate plus
   an internal listener. */

export function usePath(): string {
  const [path, setPath] = useState(() => window.location.pathname)
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname)
    window.addEventListener('popstate', onPop)
    window.addEventListener('vb:navigate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      window.removeEventListener('vb:navigate', onPop)
    }
  }, [])
  return path
}

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  if (opts.replace) window.history.replaceState({}, '', to)
  else window.history.pushState({}, '', to)
  window.dispatchEvent(new Event('vb:navigate'))
}

export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const pp = pattern.split('/').filter(Boolean)
  const pa = path.split('/').filter(Boolean)
  if (pp.length !== pa.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < pp.length; i++) {
    if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(pa[i])
    else if (pp[i] !== pa[i]) return null
  }
  return params
}

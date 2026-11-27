/* Pemetaan nama file rute TanStack ke URL. Dipisah ke modul sendiri supaya
   bisa diuji langsung dan dipakai agent (probe halaman yatim).

   Konvensi nama file:
     index.tsx                          -> /
     dashboard.tsx                      -> /dashboard
     courses.$slug.tsx                  -> /courses/$slug
     courses.$slug_.certificate.tsx     -> /courses/$slug/certificate
     __root.tsx                         -> bukan rute (null)
     -komponen.tsx                      -> bukan rute (null)
   Segmen berakhiran `_` adalah pathless layout: parameter milik induk, jadi
   `$slug_` menjadi `$slug` pada URL. */
export function routePathFromFile(file: string): string | null {
  const m = /src\/routes\/(.+)\.(tsx|jsx)$/.exec(file)
  if (!m) return null
  const name = m[1]
  if (name === '__root' || name.startsWith('__') || name.startsWith('-')) return null
  const segs: string[] = []
  for (const raw of name.split('.')) {
    if (raw === 'index') continue
    if (raw.endsWith('_')) {
      const base = raw.slice(0, -1)
      segs.push(base.startsWith('$') ? base : `$${base}`)
      continue
    }
    segs.push(raw)
  }
  return '/' + segs.join('/')
}

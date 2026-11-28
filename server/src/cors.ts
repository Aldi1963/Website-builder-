/* Whitelist CORS berbasis origin. Diekspor terpisah supaya bisa diuji tanpa
   meng-import seluruh aplikasi (dan tanpa menyentuh database). */
const EXTRA_ORIGINS = new Set(
  [process.env.VB_PUBLIC_ORIGIN, process.env.VB_ALLOWED_ORIGIN]
    .flatMap((v) => (v ?? '').split(','))
    .map((v) => v.trim().replace(/\/$/, ''))
    .filter((v) => v && v !== 'none'),
)

export function allowedOrigin(
  origin: string | undefined,
  requestUrl: string,
): string | undefined {
  if (!origin || origin === 'null') return undefined
  if (EXTRA_ORIGINS.has(origin)) return origin
  try {
    const reqUrl = new URL(requestUrl)
    const o = new URL(origin)
    if (o.protocol === reqUrl.protocol && o.host === reqUrl.host) return origin
    const suffix = (process.env.VB_PUBLIC_SUFFIX ?? 'none').toLowerCase()
    if (o.protocol === 'https:' && suffix !== 'none' && o.hostname.endsWith(`.${suffix}`)) {
      const sub = o.hostname.slice(0, -(suffix.length + 1))
      if (sub && !sub.includes('.')) return origin
    }
    if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin
  } catch {
    /* origin bukan URL valid */
  }
  return undefined
}

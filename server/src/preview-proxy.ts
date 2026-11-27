import type { Context } from 'hono'
import { readFileSync } from 'node:fs'

/**
 * Owner-scoped live preview.
 *
 * The preview process listens on 127.0.0.1 only, so the browser iframe has to
 * talk to the platform. Forwarding under /api/projects/<id>/live/ keeps the
 * visitor's own origin, which means the session cookie, POST bodies (TanStack
 * server-function RPC), Set-Cookie responses and 3xx redirects all work without
 * exposing an internal port. Guests and other owners are rejected by the caller's
 * ownership check before this function runs.
 *
 * The preview is built with that prefix as Vite `base` and TanStack router
 * `basepath` (see buildProject/startPreview in workspace.ts), so the app itself
 * emits prefixed URLs and the prefix is forwarded untouched — no HTML rewriting.
 */
export function previewPrefix(projectId: string): string {
  return `/api/projects/${projectId}/live`
}

const HOP_BY_HOP = ['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'proxy-authorization', 'proxy-authenticate']

export async function proxyPreview(c: Context, projectId: string, port: number): Promise<Response> {
  const prefix = previewPrefix(projectId)
  const incoming = new URL(c.req.url)
  const editor = incoming.searchParams.get('__vbEditor') === '1'
  // Bridge disuntik HANYA untuk iframe editor (query __vbEditor=1). Aplikasi
  // publik yang dibuka lewat /p/<slug> atau domain kustom tak menyadarinya.
  if (editor) incoming.searchParams.delete('__vbEditor')
  const target = `http://127.0.0.1:${port}${incoming.pathname}${incoming.search}`

  const headers = new Headers(c.req.raw.headers)
  for (const name of [...HOP_BY_HOP, 'host', 'accept-encoding', 'content-length']) headers.delete(name)
  headers.set('x-forwarded-host', incoming.host)
  headers.set('x-forwarded-proto', incoming.protocol.replace(':', ''))
  headers.set('x-forwarded-prefix', prefix)

  const method = c.req.method
  const hasBody = method !== 'GET' && method !== 'HEAD'
  let upstream: Response
  try {
    upstream = await fetch(target, {
      method,
      headers,
      body: hasBody ? await c.req.arrayBuffer() : undefined,
      redirect: 'manual',
    })
    if (editor && upstream.ok && (upstream.headers.get('content-type') ?? '').includes('text/html')) {
      const html = await upstream.text()
      const outHeaders = new Headers(upstream.headers)
      outHeaders.delete('content-length')
      outHeaders.set('content-security-policy', "frame-ancestors 'self'")
      return new Response(withVisualBridge(html), { status: upstream.status, headers: outHeaders })
    }
  } catch {
    return c.json({ ok: false, error: 'preview tidak dapat dihubungi' }, 502)
  }

  const out = new Headers()
  upstream.headers.forEach((value, key) => {
    const name = key.toLowerCase()
    if (HOP_BY_HOP.includes(name) || name === 'content-encoding' || name === 'content-length') return
    if (name === 'location') return out.set('location', rewriteLocation(value, prefix, port))
    if (name === 'set-cookie') return
    out.set(key, value)
  })
  for (const cookie of upstream.headers.getSetCookie?.() ?? []) {
    out.append('set-cookie', rewriteCookiePath(cookie, prefix))
  }

  return new Response(upstream.body, { status: upstream.status, headers: out })
}


/* Bridge mode "Pilih elemen". Disimpan sebagai file JS statis supaya regex
   di dalamnya tak perlu di-escape dua kali di template literal TypeScript. */
let bridgeScript: string | undefined
function getBridgeScript(): string {
  if (bridgeScript === undefined) {
    bridgeScript = readFileSync(new URL('./visual-bridge.js', import.meta.url), 'utf8')
  }
  return bridgeScript
}

export function withVisualBridge(html: string): string {
  if (/vb-visual-bridge/.test(html)) return html
  const tag = '<script>' + getBridgeScript() + '</script>'
  return /<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>/i, tag + '</body>') : html + tag
}

function rewriteLocation(value: string, prefix: string, port: number): string {
  try {
    const url = new URL(value, `http://127.0.0.1:${port}`)
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
      // App yang sudah sadar-basepath mengirim Location berprefix; jangan dobel.
      const path = url.pathname.startsWith(`${prefix}/`) || url.pathname === prefix ? url.pathname : `${prefix}${url.pathname}`
      return `${path}${url.search}${url.hash}`
    }
  } catch {
    /* relative Location */
  }
  return value
}

function rewriteCookiePath(cookie: string, prefix: string): string {
  return /;\s*path=\//i.test(cookie) ? cookie.replace(/;\s*path=\//i, `; Path=${prefix}/`) : cookie
}

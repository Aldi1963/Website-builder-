import type { Context } from 'hono'

/**
 * Owner-scoped live preview.
 *
 * The preview process listens on 127.0.0.1 only, so the browser iframe has to
 * talk to the platform. Forwarding under /api/projects/<id>/live/ keeps the
 * visitor's own origin, which means the session cookie, POST bodies (TanStack
 * server-function RPC), Set-Cookie responses and 3xx redirects all work without
 * exposing an internal port. Guests and other owners are rejected by the caller's
 * ownership check before this function runs.
 */
export function previewPrefix(projectId: string): string {
  return `/api/projects/${projectId}/live`
}

const HOP_BY_HOP = ['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'proxy-authorization', 'proxy-authenticate']

export async function proxyPreview(c: Context, projectId: string, port: number): Promise<Response> {
  const prefix = previewPrefix(projectId)
  const incoming = new URL(c.req.url)
  const rest = incoming.pathname.slice(c.req.path.indexOf(prefix) + prefix.length) || '/'
  const target = `http://127.0.0.1:${port}${rest}${incoming.search}`

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

  const type = upstream.headers.get('content-type') ?? ''
  if (type.includes('text/html')) {
    const html = await upstream.text()
    out.set('cache-control', 'no-store')
    return new Response(rewriteHtml(html, prefix), { status: upstream.status, headers: out })
  }
  return new Response(upstream.body, { status: upstream.status, headers: out })
}

/**
 * Generated apps reference /assets/*, /wb-cloud.js and their own API with root
 * absolute URLs. Served from a path prefix those would resolve against the
 * platform, so markup references are prefixed and a small shim re-roots runtime
 * fetches. TanStack server functions post to /_serverFn/* from the client, which
 * only the shim can catch.
 */
function rewriteHtml(html: string, prefix: string): string {
  const rewritten = html.replace(/(\s(?:src|href|action)=")\/(?!\/)/g, `$1${prefix}/`)
  const shim = `<script>(${rootShim.toString()})(${JSON.stringify(prefix)})</script>`
  return rewritten.includes('</head>') ? rewritten.replace('</head>', `${shim}</head>`) : `${shim}${rewritten}`
}

/* Runs in the visitor's browser, not on the server. */
function rootShim(prefix: string) {
  const rebase = (input: string) => (input.startsWith('/') && !input.startsWith('//') && !input.startsWith(`${prefix}/`) ? `${prefix}${input}` : input)
  const nativeFetch = window.fetch.bind(window)
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string') return nativeFetch(rebase(input), init)
    if (input instanceof URL) return nativeFetch(new URL(rebase(input.pathname + input.search), input.origin), init)
    return nativeFetch(input, init)
  }
  const open = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, async?: boolean, user?: string | null, password?: string | null) {
    return open.call(this, method, typeof url === 'string' ? rebase(url) : url, async ?? true, user ?? null, password ?? null)
  }
  const wrap = (fn: History['pushState']) =>
    function (this: History, state: unknown, title: string, url?: string | URL | null) {
      return fn.call(this, state, title, typeof url === 'string' ? rebase(url) : url)
    }
  history.pushState = wrap(history.pushState)
  history.replaceState = wrap(history.replaceState)
}

function rewriteLocation(value: string, prefix: string, port: number): string {
  try {
    const url = new URL(value, `http://127.0.0.1:${port}`)
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
      return `${prefix}${url.pathname}${url.search}${url.hash}`
    }
  } catch {
    /* relative Location */
  }
  return value
}

function rewriteCookiePath(cookie: string, prefix: string): string {
  return /;\s*path=\//i.test(cookie) ? cookie.replace(/;\s*path=\//i, `; Path=${prefix}/`) : cookie
}
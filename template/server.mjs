import { serve } from 'srvx'
import { readFile, stat } from 'node:fs/promises'
import { join, normalize, extname } from 'node:path'
import handler from './dist/server/server.js'

const port = Number(process.env.PORT ?? 3001)
const hostname = process.env.HOST ?? '127.0.0.1'
const CLIENT_DIR = new URL('./dist/client/', import.meta.url).pathname

const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
}

async function tryStatic(pathname) {
  const rel = normalize(decodeURIComponent(pathname))
    .replace(/^(\.\.[/\\])+/, '')
    .replace(/^\/+/, '')
  if (!rel) return null
  const abs = join(CLIENT_DIR, rel)
  if (!abs.startsWith(CLIENT_DIR)) return null
  try {
    const st = await stat(abs)
    if (!st.isFile()) return null
    const body = await readFile(abs)
    return new Response(body, {
      headers: {
        'content-type': MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'public, max-age=0, must-revalidate',
      },
    })
  } catch {
    return null
  }
}

const ssr = (req) => (typeof handler?.fetch === 'function' ? handler.fetch(req) : handler(req))

await serve({
  fetch: async (request) => {
    const url = new URL(request.url)
    const hit = await tryStatic(url.pathname)
    if (hit) return hit
    const res = await ssr(request)
    return res ?? new Response('Not found', { status: 404 })
  },
  port,
  hostname,
})

console.log(`[vb-template] listening on http://${hostname}:${port}`)

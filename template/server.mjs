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

/* ---------- LLM proxy: POST /api/chat ----------
   Satu-satunya jalan aplikasi ini memakai LLM. Key dibaca dari environment
   server SAJA (LLM_API_KEY, LLM_BASE_URL, LLM_MODEL — diisi pemilik proyek di
   pengaturan proyek VibeBuilder). Key TIDAK PERNAH ada di kode client /
   bundle frontend: jangan pernah mengimpor atau menuliskannya di src/. */

const LLM_DEFAULT_BASE_URL = 'https://ai.clipku.com/v1'
const LLM_DEFAULT_MODEL = 'cx/gpt-5.6-luna'

function llmConfig() {
  return {
    key: process.env.LLM_API_KEY ?? '',
    baseUrl: (process.env.LLM_BASE_URL ?? LLM_DEFAULT_BASE_URL).replace(/\/+$/, ''),
    model: process.env.LLM_MODEL ?? LLM_DEFAULT_MODEL,
  }
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

async function handleChat(request) {
  const { key, baseUrl, model } = llmConfig()
  if (!key) {
    return jsonError(503, 'API key LLM belum diatur di pengaturan proyek')
  }
  let body
  try {
    body = await request.json()
  } catch {
    return jsonError(400, 'Body harus JSON.')
  }
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const valid =
    messages.length > 0 &&
    messages.length <= 50 &&
    messages.every(
      (m) =>
        m &&
        typeof m === 'object' &&
        ['system', 'user', 'assistant'].includes(m.role) &&
        typeof m.content === 'string' &&
        m.content.length > 0 &&
        m.content.length <= 8000,
    )
  if (!valid) {
    return jsonError(400, 'messages harus berisi 1-50 pesan dengan role dan content yang valid.')
  }
  const system =
    typeof body?.system === 'string' && body.system
      ? [{ role: 'system', content: body.system.slice(0, 8000) }]
      : []
  let upstream
  try {
    upstream = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ model, messages: [...system, ...messages], stream: true }),
    })
  } catch (err) {
    return jsonError(502, `Tidak bisa menghubungi LLM upstream: ${err.message}`)
  }
  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '')
    return jsonError(502, `LLM upstream menolak (${upstream.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`)
  }
  // Teruskan SSE upstream sebagai event delta sederhana: data: {"delta":"..."}
  // diakhiri data: [DONE].
  const stream = new ReadableStream({
    async start(controller) {
      const reader = upstream.body.getReader()
      const decoder = new TextDecoder()
      const encoder = new TextEncoder()
      let buf = ''
      const send = (text) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta: text })}\n\n`))
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          let idx
          while ((idx = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, idx).trim()
            buf = buf.slice(idx + 1)
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (payload === '[DONE]') continue
            try {
              const chunk = JSON.parse(payload)
              const delta = chunk?.choices?.[0]?.delta?.content
              if (typeof delta === 'string' && delta) send(delta)
            } catch {
              /* abaikan baris yang bukan JSON */
            }
          }
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      } catch {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: 'Stream LLM terputus.' })}\n\n`))
        controller.close()
      }
    },
  })
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  })
}

await serve({
  fetch: async (request) => {
    const url = new URL(request.url)
    if (url.pathname === '/api/chat') {
      if (request.method !== 'POST') return jsonError(405, 'Gunakan POST.')
      return handleChat(request)
    }
    const hit = await tryStatic(url.pathname)
    if (hit) return hit
    const res = await ssr(request)
    return res ?? new Response('Not found', { status: 404 })
  },
  port,
  hostname,
})

console.log(`[vb-template] listening on http://${hostname}:${port}`)

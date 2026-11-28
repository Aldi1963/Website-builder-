import { serve } from 'srvx'
import { readFile, stat } from 'node:fs/promises'
import { join, normalize, extname } from 'node:path'
import handler from './dist/server/server.js'

const port = Number(process.env.PORT ?? 3001)
const hostname = process.env.HOST ?? '127.0.0.1'
const CLIENT_DIR = new URL('./dist/client/', import.meta.url).pathname

/* Preview platform menyajikan aplikasi di bawah prefix (VB_BASE, mis.
   /api/projects/<id>/live/). URL yang sampai ke proses ini masih membawa
   prefix itu, jadi aset statis dan route API lokal di bawah harus dikupas dulu
   sebelum dicari di disk. SSR tidak lewat sini: TanStack membaca basepath
   sendiri dari bundle hasil build. */
const BASE = (process.env.VB_BASE ?? '/').replace(/\/+$/, '')

function stripBase(pathname) {
  if (!BASE) return pathname
  if (pathname === BASE) return '/'
  return pathname.startsWith(`${BASE}/`) ? pathname.slice(BASE.length) : pathname
}

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

/* ---------- Integrations: write-only secret proxy ----------
   Form admin di aplikasi hasil generate memanggil endpoint ini. Nilai secret
   diteruskan ke platform VibeBuilder memakai cookie sesi yang sama, lalu
   disimpan sebagai env var write-only. Nilai TIDAK PERNAH dikembalikan, tidak
   ditulis ke disk workspace, dan tidak masuk bundle client. */
const PLATFORM_ORIGIN = process.env.VB_PLATFORM_ORIGIN ?? 'http://127.0.0.1:3000'
const PROJECT_ID = process.env.VB_PROJECT_ID ?? ''
async function integrationProxy(req, pathname) {
  if (!PROJECT_ID) return new Response(JSON.stringify({ error: 'Project tidak dikenal.' }), { status: 503, headers: { 'content-type': 'application/json' } })
  const url = `${PLATFORM_ORIGIN}/api/projects/${encodeURIComponent(PROJECT_ID)}${pathname}`
  const headers = new Headers()
  const cookie = req.headers.get('cookie')
  if (cookie) headers.set('cookie', cookie)
  const method = req.method
  if (method !== 'GET') headers.set('content-type', 'application/json')
  let body
  if (method !== 'GET' && method !== 'HEAD') body = await req.text()
  try {
    const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(8000) })
    const text = await res.text()
    // Platform mengembalikan {ok:true,key} — aman diteruskan (tanpa nilai).
    return new Response(text, { status: res.status, headers: { 'content-type': 'application/json' } })
  } catch {
    return new Response(JSON.stringify({ error: 'Gagal menghubungi platform.' }), { status: 502, headers: { 'content-type': 'application/json' } })
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

/* ---------- RAG embedding lokal: POST /api/embed ----------
   Embedding pakai fastembed (model bge-small ONNX, 384 dim) yang jalan di CPU
   proses Node ini — tanpa API key / kirim data keluar. Dipakai helper ~/lib/rag
   untuk membangun basis pengetahuan (pgvector). */

let _embedder = null
let _embedderInit = null
async function getEmbedder() {
  if (_embedder) return _embedder
  if (!_embedderInit) {
    _embedderInit = (async () => {
      const { FlagEmbedding } = await import('fastembed')
      _embedder = await FlagEmbedding.init()
      return _embedder
    })()
  }
  return _embedderInit
}

async function embedTexts(inputs) {
  const embedder = await getEmbedder()
  // embed() menerima array dan menghasilkan satu vektor per input (Float32Array).
  const vectors = []
  for await (const vec of embedder.embed(inputs)) vectors.push(Array.from(vec))
  return vectors
}

async function handleEmbed(request) {
  let body
  try {
    body = await request.json()
  } catch {
    return jsonError(400, 'Body harus JSON.')
  }
  const { input } = body ?? {}
  const inputs = Array.isArray(input) ? input : typeof input === 'string' ? [input] : null
  if (!inputs || !inputs.length || inputs.some((s) => typeof s !== 'string' || !s.trim())) {
    return jsonError(400, 'Field "input" harus string atau array string non-kosong.')
  }
  if (inputs.length > 64) return jsonError(400, 'Maksimal 64 input per permintaan.')
  try {
    const vectors = await embedTexts(inputs)
    // Satu input -> balas embedding langsung; banyak -> array embedding.
    const out = inputs.length === 1 ? vectors[0] : vectors
    return new Response(JSON.stringify({ embedding: out, dimensions: vectors[0]?.length ?? 0 }), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })
  } catch (err) {
    return jsonError(500, `Gagal membuat embedding: ${err.message}`)
  }
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
    const pathname = stripBase(url.pathname)
    if (pathname === '/api/chat') {
      if (request.method !== 'POST') return jsonError(405, 'Gunakan POST.')
      return handleChat(request)
    }
    if (pathname === '/api/embed') {
      if (request.method !== 'POST') return jsonError(405, 'Gunakan POST.')
      return handleEmbed(request)
    }
    if (pathname === '/api/integrations/secret' || pathname === '/api/integrations/keys') {
      if (pathname.endsWith('/keys') && request.method !== 'GET') return jsonError(405, 'Gunakan GET.')
      if (pathname.endsWith('/secret') && request.method !== 'PUT') return jsonError(405, 'Gunakan PUT.')
      return integrationProxy(request, pathname === '/api/integrations/keys' ? '/secret-keys' : '/secrets')
    }
    const hit = await tryStatic(pathname)
    if (hit) return hit
    const res = await ssr(request)
    return res ?? new Response('Not found', { status: 404 })
  },
  port,
  hostname,
})

console.log(`[vb-template] listening on http://${hostname}:${port}`)

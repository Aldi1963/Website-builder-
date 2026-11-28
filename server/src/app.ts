import { Hono, type Context } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import { streamSSE } from 'hono/streaming'
import { cors } from 'hono/cors'
import { randomBytes } from 'node:crypto'
import { appendFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createProject,
  getProject,
  listProjects,
  deleteProject,
  renameProject,
  setStatus,
  listMessages,
  addMessage,
  addActivityEvent,
  listActivityEvents,
  listFiles,
  getFile,
  putFile,
  recordBuild,
  lastBuild,
  publishProject,
  unpublishProject,
  projectBySlug,
  listPublishedSlugs,
  claimOrphanProjects,
  userOwnsProject,
  getSetting,
  setSetting,
  deleteSetting,
  listSettings,
  projectByDomain,
} from './db.ts'
import { db } from './db.ts'
import type { Project } from './db.ts'
import { getPendingPlan, clearPendingPlan } from './pending-plan.ts'
import { saveReferenceImage, listReferenceImages, readReferenceImage, deleteReferenceImage } from './reference-images.ts'
import { listVersions, getVersionDiff, restoreVersion, snapshotVersion, diffLines } from './versions.ts'
import { PROJECTS_DIR } from './paths.ts'
import { projectZip } from './export.ts'
import { syncToGitHub, saveGitHubConfig } from './github-sync.ts'
import {
  ensureWorkspace,
  buildProject,
  installDeps,
  startPreview,
  stopPreview,
  runningPreviews,
  previewPort,
  readProjectFile,
  writeProjectFile,
  projectDir,
} from './workspace.ts'
import { captureScreenshot, listScreenshots, readScreenshot } from './screenshots.ts'
import { dropProjectDb, projectDbPool, isManagedDbEnabled, provisionProjectDb, validateProjectSql } from './managed-db.ts'
import {
  SESSION_COOKIE,
  sessionCookie,
  clearCookie,
  readCookie,
  createUser,
  userByEmail,
  userByToken,
  createSession,
  destroySession,
  purgeExpiredSessions,
  validateSignup,
  verifyPassword,
  countUsers,
  userById,
  createResetToken,
  consumeResetToken,
  hashPassword,
  type User,
} from './auth.ts'
import { runAgent, type AgentEvent } from './agent.ts'
import { complete, effectiveModel, llmUsage } from './llm.ts'
import { DISCOVERY_SYSTEM } from './prompts.ts'
import { registerAdmin } from './admin.ts'
import { proxyPreview, previewPrefix } from './preview-proxy.ts'
import { rateLimit } from './rate-limit.ts'
import { deliverResetLink } from './mail.ts'
import { allowedOrigin } from './cors.ts'

type Env = { Variables: { user: User } }

export const app = new Hono<Env>()

/* CORS: hanya origin yang dipercaya yang boleh memakai cookie sesi.
   Sebelumnya origin apa pun dipantulkan (termasuk `null`) bersama
   Access-Control-Allow-Credentials: true — itu CSRF lintas-origin. */
app.use('*', cors({
  origin: (o, c) => allowedOrigin(o, c.req.url),
  credentials: true,
  allowHeaders: ['content-type', 'authorization', 'x-requested-with'],
}))

/* Header keamanan dasar untuk semua respons.
   - HSTS hanya aman bila di balik HTTPS; di lingkungan dev lokal (http)
     tidak mengubah apa pun karena browser mengabaikannya tanpa TLS. */
app.use('*', async (c, next) => {
  await next()
  /* Response auth mengandung data akun & (saat dev) tautan reset. */
  if (c.req.path.startsWith('/api/auth/') || c.req.path === '/api/usage') {
    c.header('Cache-Control', 'no-store')
    c.header('Pragma', 'no-cache')
  }
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  c.header('Cross-Origin-Opener-Policy', 'same-origin')
  c.header('Cross-Origin-Resource-Policy', 'same-origin')
  /* CSP untuk UI platform: tidak ada inline script, aset lokal/content-hash.
     Preview aplikasi pengguna punya CSP sendiri lewat proxyPreview. */
  if (!c.req.path.startsWith('/p/') && !c.req.path.startsWith('/api/projects/')) {
    c.header(
      'Content-Security-Policy',
      "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'self'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:",
    )
  }
  const proto = c.req.header('x-forwarded-proto') ?? ''
  if (proto === 'https' || new URL(c.req.url).protocol === 'https:') {
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
})

/*
 * Published apps answer on their own hostname: <slug>.vibe.clipku.com.
 * The subdomain is resolved to a project, its preview is started if needed,
 * and the request is forwarded verbatim — same path, same method — because
 * generated apps link assets with absolute /assets/ URLs.
 */
const PUBLIC_SUFFIX = process.env.VB_PUBLIC_SUFFIX ?? 'none'
const PUBLIC_ORIGIN = process.env.VB_PUBLIC_ORIGIN ?? 'none'

function buildHostSubdomain(host: string): string | null {
  const name = host.split(':')[0].toLowerCase()
  if (!name.endsWith(`.${PUBLIC_SUFFIX}`)) return null
  const sub = name.slice(0, -(PUBLIC_SUFFIX.length + 1))
  if (!sub || sub.includes('.')) return null
  return sub
}

function projectByCustomDomain(host: string): Project | undefined {
  const name = host.split(':')[0].toLowerCase()
  if (!name || name === PUBLIC_ORIGIN.replace(/^https?:\/\//, '')) return undefined
  return projectByDomain(name)
}

/* Caddy meminta validasi hostname sebelum menerbitkan sertifikat. */
const DOMAIN_RE_LAX = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i

async function forward(port: number, request: Request): Promise<Response> {
  const url = new URL(request.url)
  const target = `http://127.0.0.1:${port}${url.pathname}${url.search}`
  const method = request.method
  const hasBody = method !== 'GET' && method !== 'HEAD'
  const headers = new Headers(request.headers)
  headers.delete('host')
  headers.set('host', `127.0.0.1:${port}`)
  headers.set('x-forwarded-host', url.host)
  headers.set('x-forwarded-proto', 'https')
  const upstream = await fetch(target, {
    method,
    headers,
    body: hasBody ? await request.arrayBuffer() : undefined,
    redirect: 'manual',
  })
  const out = new Headers(upstream.headers)
  out.delete('content-encoding')
  out.delete('content-length')
  out.delete('transfer-encoding')
  return new Response(upstream.body, { status: upstream.status, headers: out })
}

app.use('*', async (c, next) => {
  const host = c.req.header('host') ?? ''
  const slug = buildHostSubdomain(host)
  const project = slug ? projectBySlug(slug) : projectByCustomDomain(host)
  if (!project) return next()

  let port: number
  try {
    port = await startPreview(project.id)
  } catch {
    return c.text('Aplikasi terdaftar tapi preview-nya tidak bisa dinyalakan.', 503)
  }
  return forward(port, c.req.raw)
})

purgeExpiredSessions()

/* ---------- on-demand TLS (Caddy) ----------
   Caddy menanyakan endpoint ini sebelum menerbitkan sertifikat untuk
   sebuah hostname custom domain. Balas 200 hanya jika hostname terdaftar
   di tabel custom_domains dengan status 'verified'. */
app.get('/api/on-demand-tls-ask', (c) => {
  const domain = (c.req.query('domain') ?? '').trim().toLowerCase()
  if (!DOMAIN_RE_LAX.test(domain)) return c.text('bukan domain valid', 400)
  const row = db
    .prepare(`SELECT id FROM custom_domains WHERE LOWER(domain) = ? AND status = 'verified' LIMIT 1`)
    .get(domain)
  if (!row) return c.text('domain tidak terdaftar', 403)
  return c.text('ok', 200)
})

/* ---------- auth ---------- */

function clientIp(c: { req: { header: (n: string) => string | undefined } }): string {
  /* CF memastikan header ini hanya bisa ditambahkan proxy, bukan client. */
  return (c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown'
}

function isSecure(c: Context) {
  return (
    (c.req.header('x-forwarded-proto') ?? '').split(',')[0]?.trim() === 'https' ||
    new URL(c.req.url).protocol === 'https:'
  )
}

function tooMany(c: Context, scope: string, max: number, windowMs?: number) {
  const result = rateLimit(`${scope}:${clientIp(c)}`, max, windowMs)
  return result.ok
    ? null
    : c.json({ ok: false, error: 'Terlalu banyak permintaan. Coba lagi beberapa saat lagi.' }, 429, {
        'Retry-After': String(result.retryAfter),
      })
}

function currentUser(c: { req: { header: (n: string) => string | undefined } }): User | undefined {
  return userByToken(readCookie(c.req.header('cookie'), SESSION_COOKIE))
}

/* Every /api/projects route is owner-scoped. A single gate keeps the rules in
   one place instead of trusting each handler to remember. */
app.use('/api/projects/*', async (c, next) => {
  const user = currentUser(c)
  if (!user) return c.json({ error: 'Belum masuk.' }, 401)
  c.set('user', user)
  await next()
})
app.use('/api/projects', async (c, next) => {
  const user = currentUser(c)
  if (!user) return c.json({ error: 'Belum masuk.' }, 401)
  c.set('user', user)
  await next()
})

app.post('/api/auth/signup', async (c) => {
  const limited = tooMany(c, 'signup', 8, 10 * 60_000)
  if (limited) return limited
  const body = (await c.req.json().catch(() => ({}))) as { email?: string; name?: string; password?: string }
  const email = (body.email ?? '').trim()
  const password = body.password ?? ''
  const name = (body.name ?? '').trim() || email.split('@')[0]

  const invalid = validateSignup(email, password)
  if (invalid) return c.json({ ok: false, error: invalid }, 400)
  if (userByEmail(email)) return c.json({ ok: false, error: 'Email ini sudah terdaftar.' }, 409)

  const user = createUser(email, name, password)
  /* First account inherits pre-auth projects so nothing becomes unreachable. */
  if (countUsers() === 1) claimOrphanProjects(user.id)

  const { token } = createSession(user.id)
  c.header('set-cookie', sessionCookie(token, 60 * 60 * 24 * 30, isSecure(c)))
  return c.json({ ok: true, user }, 201)
})

app.post('/api/auth/login', async (c) => {
  const limited = tooMany(c, 'login', 12, 10 * 60_000)
  if (limited) return limited
  const body = (await c.req.json().catch(() => ({}))) as { email?: string; password?: string; remember?: boolean }
  const remember = body.remember !== false
  const row = userByEmail((body.email ?? '').trim())
  if (!row || !verifyPassword(body.password ?? '', row.password_hash)) {
    return c.json({ ok: false, error: 'Email atau password salah.' }, 401)
  }
  if (row.disabled) return c.json({ ok: false, error: 'Akun ini dinonaktifkan. Hubungi admin.' }, 403)
  const { password_hash: _drop, ...user } = row
  const { token, expiresAt } = createSession(user.id, remember)
  c.header('set-cookie', sessionCookie(token, Math.floor((expiresAt - Date.now()) / 1000), isSecure(c)))
  return c.json({ ok: true, user })
})

/* Forgot password: token dikirim lewat email (atau tersimpan di log self-host),
   TIDAK dikembalikan di response API. Pesan generik mencegah enumerasi akun. */
app.post('/api/auth/forgot', async (c) => {
  const limited = tooMany(c, 'forgot', 5, 10 * 60_000)
  if (limited) return limited
  const body = (await c.req.json().catch(() => ({}))) as { email?: string }
  const email = (body.email ?? '').trim()
  const created = createResetToken(email)
  const generic = { ok: true, message: 'Jika email terdaftar, tautan atur ulang sudah dikirim.' }
  if (!created) return c.json(generic)
  const origin = new URL(c.req.url).origin
  const link = `${origin}/?reset=${encodeURIComponent(created.token)}`
  const delivery = await deliverResetLink(email, link)
  return c.json(
    delivery.mode === 'dev'
      ? { ok: true, message: delivery.message, resetUrl: delivery.link }
      : { ok: true, message: delivery.message },
  )
})

app.post('/api/auth/reset', async (c) => {
  const limited = tooMany(c, 'reset', 10, 10 * 60_000)
  if (limited) return limited
  const body = (await c.req.json().catch(() => ({}))) as { token?: string; password?: string }
  const password = body.password ?? ''
  if (password.length < 8) return c.json({ ok: false, error: 'Password minimal 8 karakter.' }, 400)
  const userId = consumeResetToken(body.token ?? '')
  if (!userId) return c.json({ ok: false, error: 'Tautan tidak valid atau sudah kedaluwarsa.' }, 400)
  db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hashPassword(password), userId)
  db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId)
  return c.json({ ok: true, message: 'Password sudah diperbarui. Silakan masuk.' })
})

app.post('/api/auth/logout', (c) => {
  destroySession(readCookie(c.req.header('cookie'), SESSION_COOKIE))
  c.header('set-cookie', clearCookie(isSecure(c)))
  return c.json({ ok: true })
})

app.get('/api/auth/me', (c) => {
  const user = currentUser(c)
  return c.json({ user: user ?? null, signupOpen: countUsers() === 0 })
})

/* ---------- project settings: overview / domain / secrets ---------- */

const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i

app.get('/api/projects/:id/settings', (c) => {
  const r = owned(c)
  if ('error' in r) return c.json({ error: r.error }, r.status)
  const p = r.project
  const secrets = listSettings(p.id)
    .filter((s) => s.key.startsWith('secret_'))
    .map((s) => ({ key: s.key.slice(7), hint: `••••${s.value.slice(-4)}` }))
  return c.json({
    customDomain: getSetting(p.id, 'custom_domain') ?? '',
    secrets,
    overview: {
      name: p.name,
      status: p.status,
      slug: p.slug ?? null,
      files: listFiles(p.id).length,
      createdAt: p.created_at,
    },
  })
})

app.put('/api/projects/:id/domain', async (c) => {
  const r = owned(c)
  if ('error' in r) return c.json({ error: r.error }, r.status)
  const body = (await c.req.json().catch(() => ({}))) as { domain?: string }
  const domain = (body.domain ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  if (!domain) {
    deleteSetting(r.project.id, 'custom_domain')
    return c.json({ ok: true, customDomain: '' })
  }
  if (!DOMAIN_RE.test(domain)) return c.json({ error: 'Format domain tidak valid.' }, 400)
  setSetting(r.project.id, 'custom_domain', domain)
  return c.json({ ok: true, customDomain: domain })
})

app.put('/api/projects/:id/secrets', async (c) => {
  const r = owned(c)
  if ('error' in r) return c.json({ error: r.error }, r.status)
  const body = (await c.req.json().catch(() => ({}))) as { key?: string; value?: string }
  const key = (body.key ?? '').trim()
  const value = body.value ?? ''
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return c.json({ error: 'Nama kunci harus ENV_NAME yang valid.' }, 400)
  if (!value) return c.json({ error: 'Nilai secret kosong.' }, 400)
  setSetting(r.project.id, `secret_${key}`, value)
  return c.json({ ok: true, key })
})

/* ---------- Database terkelola (introspeksi skema) ---------- */

/* Ringkasan skema database Postgres terkelola proyek: daftar tabel publik,
   kolom, dan jumlah baris. Dipakai panel Database. Bukan SQLite. */
app.get('/api/projects/:id/database', async (c) => {
  const r = owned(c)
  if ('error' in r) return c.json({ error: r.error }, r.status)
  if (!isManagedDbEnabled()) {
    return c.json({ managed: false, tables: [], note: 'Database terkelola belum aktif.' })
  }
  let pool: import('pg').Pool | null = null
  try {
    const opened = await projectDbPool(r.project.id)
    pool = opened.pool
    const tablesRes = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
    )
    const tables: Array<{ name: string; columns: string[]; rows: Record<string, unknown>[]; note: string }> = []
    for (const t of tablesRes.rows) {
      const cols = await pool.query<{ column_name: string; data_type: string }>(
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
        [t.table_name],
      )
      const q = `SELECT * FROM "${t.table_name.replace(/"/g, '""')}" LIMIT 20`
      const rowsRes = await pool.query<Record<string, unknown>>(q)
      const cnt = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM "${t.table_name.replace(/"/g, '""')}"`)
      const total = Number(cnt.rows[0]?.n ?? 0)
      tables.push({
        name: t.table_name,
        columns: cols.rows.map((c) => c.column_name),
        rows: rowsRes.rows.slice(0, 20).map((row) => {
          const out: Record<string, unknown> = {}
          for (const [k, v] of Object.entries(row)) {
            out[k] = v === null ? null : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : (v as string | number | boolean)
          }
          return out
        }),
        note: `${cols.rows.length} kolom · ${total} baris${rowsRes.rows.length > 20 ? ' · menampilkan 20' : ''}`,
      })
    }
    return c.json({ managed: true, engine: 'postgres', database: opened.database, tables })
  } catch (err) {
    return c.json({ managed: true, engine: 'postgres', tables: [], error: (err as Error).message })
  }
})

/* SQL console panel Database: hanya SELECT/WITH, satu pernyataan, dibatasi.
   Memakai validator yang sama dengan tool agent db_query — tokenisasi dulu,
   sehingga kata terlarang di dalam literal tidak memicu false positive. */
app.post('/api/projects/:id/database/query', async (c) => {
  const r = owned(c)
  if ('error' in r) return c.json({ error: r.error }, r.status)
  if (!isManagedDbEnabled()) return c.json({ ok: false, error: 'Database terkelola belum aktif.' }, 503)
  const body = (await c.req.json().catch(() => ({}))) as { sql?: string; limit?: number }
  const checked = validateProjectSql('query', body.sql ?? '')
  if (!checked.ok) return c.json({ ok: false, error: checked.error }, 400)
  const first = checked.sql.trim().split(/\s+/)[0]?.toLowerCase()
  if (first !== 'select' && first !== 'with') {
    return c.json({ ok: false, error: 'Panel database hanya menjalankan query SELECT.' }, 400)
  }
  const limit = Math.min(Math.max(Number(body.limit) || 100, 1), 500)
  try {
    const { pool } = await projectDbPool(r.project.id)
    const res = await pool.query(`SELECT * FROM (${checked.sql}) AS vb_q LIMIT $${1}`, [limit])
    const cols = (res.fields ?? []).map((f) => f.name)
    const rows = res.rows.slice(0, limit).map((row) => {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(row)) {
        out[k] = v === null ? null : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : (v as string | number | boolean)
      }
      return out
    })
    return c.json({ ok: true, columns: cols, rows, rowCount: rows.length, limit, truncated: res.rows.length > limit })
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 400)
  }
})

/* Eksekusi DML manual (INSERT/UPDATE/DELETE) dari panel database.
   Memakai validator tokenisasi yang sama — satu pernyataan, operasi
   administratif dan fungsi server terlarang tetap ditolak. Berjalan di pool
   proyek yang sama dengan app (Neon bila aktif, lokal bila tidak). */
app.post('/api/projects/:id/database/exec', async (c) => {
  const r = owned(c)
  if ('error' in r) return c.json({ ok: false, error: r.error }, r.status)
  if (!isManagedDbEnabled()) return c.json({ ok: false, error: 'Database terkelola belum aktif.' }, 503)
  const body = (await c.req.json().catch(() => ({}))) as { sql?: string }
  const checked = validateProjectSql('query', body.sql ?? '')
  if (!checked.ok) return c.json({ ok: false, error: checked.error }, 400)
  const first = checked.sql.trim().split(/\s+/)[0]?.toLowerCase()
  if (first !== 'insert' && first !== 'update' && first !== 'delete') {
    return c.json({ ok: false, error: 'Endpoint ini hanya untuk INSERT / UPDATE / DELETE. Gunakan /database/query untuk SELECT.' }, 400)
  }
  try {
    const { pool } = await projectDbPool(r.project.id)
    const res = await pool.query(checked.sql)
    return c.json({ ok: true, rowCount: res.rowCount ?? 0, command: res.command })
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 400)
  }
})

/* Mode database ala phpMyAdmin: nama tabel DIVALIDASI terhadap katalog dulu,
   baru dipakai sebagai identifier. Filter/offset tetap parameterized. */
async function safeTable(pool: import('pg').Pool, name: string): Promise<string | null> {
  const found = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name=$1`,
    [name],
  )
  return found.rows[0]?.table_name ?? null
}
const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`

app.get('/api/projects/:id/database/table', async (c) => {
  const r = owned(c)
  if ('error' in r) return c.json({ error: r.error }, r.status)
  if (!isManagedDbEnabled()) return c.json({ ok: false, error: 'Database terkelola belum aktif.' }, 503)
  const name = c.req.query('name') ?? ''
  const search = (c.req.query('search') ?? '').slice(0, 120)
  const page = Math.max(0, Number(c.req.query('page')) || 0)
  const perPage = Math.min(Math.max(Number(c.req.query('perPage')) || 25, 1), 100)
  try {
    const { pool } = await projectDbPool(r.project.id)
    const table = await safeTable(pool, name)
    if (!table) return c.json({ ok: false, error: 'Tabel tidak ditemukan.' }, 404)
    const cols = await pool.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
      [table],
    )
    const where = search ? ` WHERE ${cols.rows.map((x, i) => `CAST(${quoteIdent(x.column_name)} AS text) ILIKE $${i + 1}`).join(' OR ')}` : ''
    const params = search ? [...cols.rows.map(() => `%${search}%`)] : []
    const cnt = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM ${quoteIdent(table)}${where}`, params)
    const total = Number(cnt.rows[0]?.n ?? 0)
    const dataParams = [...params, perPage, page * perPage]
    const res = await pool.query<Record<string, unknown>>(
      `SELECT * FROM ${quoteIdent(table)}${where} LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`, dataParams,
    )
    const rows = res.rows.map((row) => {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(row)) out[k] = v === null ? null : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : (v as string | number | boolean)
      return out
    })
    return c.json({
      ok: true, table, page, perPage, total, pageCount: Math.max(1, Math.ceil(total / perPage)),
      columns: cols.rows.map((x) => ({ name: x.column_name, type: x.data_type, nullable: x.is_nullable === 'YES', default: x.column_default })),
      rows,
    })
  } catch (err) { return c.json({ ok: false, error: (err as Error).message }, 400) }
})

app.get('/api/projects/:id/database/export', async (c) => {
  const r = owned(c)
  if ('error' in r) return c.json({ error: r.error }, r.status)
  if (!isManagedDbEnabled()) return c.json({ ok: false, error: 'Database terkelola belum aktif.' }, 503)
  try {
    const { pool } = await projectDbPool(r.project.id)
    const tabs = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`,
    )
    const chunks: string[] = ['-- Ekspor database VibeBuilder (Postgres)\n']
    for (const t of tabs.rows) {
      const name = await safeTable(pool, t.table_name)
      if (!name) continue
      const cols = await pool.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
        `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [name],
      )
      const defs = cols.rows.map((x) => `  ${quoteIdent(x.column_name)} ${x.data_type}${x.is_nullable === 'NO' ? ' NOT NULL' : ''}${x.column_default ? ` DEFAULT ${x.column_default}` : ''}`)
      chunks.push(`CREATE TABLE IF NOT EXISTS ${quoteIdent(name)} (\n${defs.join(',\n')}\n);\n`)
      const data = await pool.query<Record<string, unknown>>(`SELECT * FROM ${quoteIdent(name)}`)
      for (const row of data.rows) {
        const keys = cols.rows.map((x) => x.column_name)
        const vals = keys.map((k) => {
          const v = row[k]
          if (v === null || v === undefined) return 'NULL'
          if (typeof v === 'number' || typeof v === 'boolean') return String(v)
          return `'${String(v).replace(/'/g, "''")}'`
        })
        chunks.push(`INSERT INTO ${quoteIdent(name)} (${keys.map(quoteIdent).join(', ')}) VALUES (${vals.join(', ')});\n`)
      }
      chunks.push('\n')
    }
    return c.json({ ok: true, sql: chunks.join(''), tables: tabs.rows.length })
  } catch (err) { return c.json({ ok: false, error: (err as Error).message }, 400) }
})

/* ---------- GitHub sync ---------- */

app.put('/api/projects/:id/github', async (c) => {
  const r = owned(c)
  if ('error' in r) return c.json({ error: r.error }, r.status)
  const body = (await c.req.json().catch(() => ({}))) as { repo?: string; token?: string; branch?: string }
  const repo = (body.repo ?? '').trim()
  const branch = (body.branch ?? 'main').trim() || 'main'
  if (repo && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    return c.json({ error: 'Repo harus format owner/repo.' }, 400)
  }
  if (repo) setSetting(r.project.id, 'github_repo', repo)
  if (branch) setSetting(r.project.id, 'github_branch', branch)
  if (body.token) setSetting(r.project.id, 'secret_GITHUB_TOKEN', body.token.trim())
  return c.json({ ok: true, repo, branch, tokenSaved: Boolean(body.token) })
})

app.post('/api/projects/:id/github/sync', async (c) => {
  const r = owned(c)
  if ('error' in r) return c.json({ error: r.error }, r.status)
  const body = (await c.req.json().catch(() => ({}))) as { repo?: string; branch?: string; token?: string }
  if (body.repo || body.branch || body.token) {
    saveGitHubConfig(r.project.id, (body.repo ?? '').trim(), (body.token ?? '').trim(), (body.branch ?? '').trim())
  }
  const result = await syncToGitHub(r.project.id, { repo: body.repo, branch: body.branch })
  return c.json(result, result.ok ? 200 : 400)
})

app.delete('/api/projects/:id/secrets/:key', (c) => {
  const r = owned(c)
  if ('error' in r) return c.json({ error: r.error }, r.status)
  deleteSetting(r.project.id, `secret_${c.req.param('key')}`)
  return c.json({ ok: true })
})

/* ---------- health ---------- */

app.get('/api/usage', (c) => c.json(llmUsage))

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    service: 'vibebuilder',
    model: effectiveModel(),
    previews: runningPreviews(),
    uptime: Math.round(process.uptime()),
  }),
)

/* ---------- projects ---------- */

app.get('/api/projects', (c) => c.json({ projects: listProjects(c.get('user').id) }))

app.post('/api/projects', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { name?: string; prompt?: string; starter?: string }
  const starter = body.starter === 'lms' || body.starter === 'tiket' ? body.starter : 'blank'
  const id = randomBytes(5).toString('hex')
  const defaultName = starter === 'lms' ? 'LMS baru' : starter === 'tiket' ? 'Event & Tiket baru' : 'Proyek tanpa nama'
  const name = (body.name ?? body.prompt ?? defaultName).slice(0, 60)
  const project = createProject(id, name, body.prompt ?? '', c.get('user').id, starter)
  ensureWorkspace(id, starter)
  if (starter === 'lms' || starter === 'tiket') {
    try {
      await provisionProjectDb(id)
    } catch {
      setStatus(id, 'error')
      const label = starter === 'lms' ? 'LMS' : 'tiketing'
      return c.json({ project: getProject(id), error: `Database ${label} belum siap. Periksa konfigurasi database terkelola lalu coba lagi.` }, 503)
    }
  }
  return c.json({ project }, 201)
})

/* Ownership check shared by every by-id route. Returns the project or a
   response the handler can return as-is. */
function owned(c: { req: { param: (n: string) => string }; get: (k: 'user') => User }) {
  const id = c.req.param('id')
  const project = getProject(id)
  if (!project) return { error: 'not found' as const, status: 404 as const }
  if (project.owner_id !== c.get('user').id) return { error: 'not found' as const, status: 404 as const }
  return { project }
}

app.get('/api/projects/:id', (c) => {
  const r = owned(c)
  if ('error' in r) return c.json({ error: r.error }, r.status)
  const p = r.project
  return c.json({
    project: p,
    messages: listMessages(p.id),
    events: listActivityEvents(p.id),
    files: listFiles(p.id),
    build: lastBuild(p.id) ?? null,
    previewPort: previewPort(p.id),
    pendingPlan: getPendingPlan(p.id) ?? null,
  })
})

app.patch('/api/projects/:id', async (c) => {
  const r = owned(c)
  if ('error' in r) return c.json({ error: r.error }, r.status)
  const body = (await c.req.json().catch(() => ({}))) as { name?: string }
  if (body.name) renameProject(r.project.id, body.name.slice(0, 80))
  return c.json({ project: getProject(r.project.id) })
})

app.delete('/api/projects/:id', async (c) => {
  const r = owned(c)
  if ('error' in r) return c.json({ error: r.error }, r.status)
  stopPreview(r.project.id)
  try { await dropProjectDb(r.project.id) } catch { /* DB terkelola opsional */ }
  // Hapus folder file fisik proyek (source, node_modules, dist, dsb.) dari VPS.
  try { rmSync(projectDir(r.project.id), { recursive: true, force: true }) } catch { /* folder mungkin tak ada */ }
  deleteProject(r.project.id)
  return c.json({ ok: true })
})

/* Rencana menunggu persetujuan: dibatalkan user dari kartu rencana. */
app.delete('/api/projects/:id/pending-plan', (c) => {
  const r = owned(c)
  if ('error' in r) return c.json({ error: r.error }, r.status)
  clearPendingPlan(r.project.id)
  return c.json({ ok: true })
})

app.get('/api/projects/:id/files', (c) => {
  const r = owned(c)
  if ('error' in r) return c.json({ error: r.error }, r.status)
  return c.json({ files: listFiles(r.project.id) })
})

app.get('/api/projects/:id/file', (c) => {
  const r = owned(c)
  if ('error' in r) return c.json({ error: r.error }, r.status)
  const path = c.req.query('path') ?? ''
  const content = getFile(r.project.id, path) ?? readProjectFile(r.project.id, path)
  if (content === null || content === undefined) return c.json({ error: 'not found' }, 404)
  return c.json({ path, content })
})

app.put('/api/projects/:id/file', async (c) => {
  const r = owned(c)
  if ('error' in r) return c.json({ error: r.error }, r.status)
  const body = (await c.req.json().catch(() => ({}))) as { path?: string; content?: string }
  if (!body.path) return c.json({ error: 'path wajib' }, 400)
  const path = writeProjectFile(r.project.id, body.path, body.content ?? '')
  putFile(r.project.id, path, body.content ?? '')
  return c.json({ ok: true, path })
})

app.post('/api/projects/:id/build', async (c) => {
  const r = owned(c)
  if ('error' in r) return c.json({ error: r.error }, r.status)
  const id = r.project.id
  setStatus(id, 'building')
  const installed = await installDeps(id)
  const build = installed.code === 0 ? await buildProject(id) : installed
  recordBuild(id, build.code === 0, build.output)
  setStatus(id, build.code === 0 ? 'idle' : 'error')
  return c.json({ ok: build.code === 0, log: build.output.slice(-8000) })
})

app.post('/api/projects/:id/install', async (c) => {
  const r = owned(c)
  if ('error' in r) return c.json({ error: r.error }, r.status)
  const res = await installDeps(r.project.id)
  return c.json({ ok: res.code === 0, log: res.output.slice(-4000) })
})

app.post('/api/projects/:id/preview', async (c) => {
  const r = owned(c)
  if ('error' in r) return c.json({ error: r.error }, r.status)
  try {
    const port = await startPreview(r.project.id)
    return c.json({ ok: true, port, url: `${previewPrefix(r.project.id)}/`, directPort: `http://127.0.0.1:${port}/` })
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 500)
  }
})

/* Publish makes a project reachable at a memorable slug. The slug redirects to the
   project's own preview port rather than proxying, so the generated app keeps
   serving its absolute /assets URLs without a rewrite layer that would break SSR. */
app.post('/api/projects/:id/publish', async (c) => {
  const r = owned(c)
  if ('error' in r) return c.json({ error: r.error }, r.status)
  const project = r.project

  const body = (await c.req.json().catch(() => ({}))) as { slug?: string }
  const slug = slugify(body.slug || project.name || project.id)
  if (!slug) return c.json({ ok: false, error: 'slug tidak valid' }, 400)

  const taken = projectBySlug(slug)
  if (taken && taken.id !== project.id) return c.json({ ok: false, error: `slug "${slug}" sudah dipakai` }, 409)

  const build = await buildProject(project.id)
  if (build.code !== 0) return c.json({ ok: false, error: 'build gagal', log: build.output.slice(-2000) }, 400)
  recordBuild(project.id, true, build.output)

  let port: number
  try {
    port = await startPreview(project.id)
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 500)
  }

  publishProject(project.id, slug)
  return c.json({
    ok: true,
    slug,
    url: `${PUBLIC_ORIGIN.replace('://', `://${slug}.`)}/`,
    port,
  })
})

app.delete('/api/projects/:id/publish', (c) => {
  const r = owned(c)
  if ('error' in r) return c.json({ error: r.error }, r.status)
  unpublishProject(r.project.id)
  return c.json({ ok: true })
})

/* Auto-publish: setelah run chat sukses yang mengubah UI, web publik
   <slug>.domain selalu segar — user tidak perlu klik Deploy tiap kali AI
   mengubah file. Dipanggil sekali per run (di onDone), bukan tiap event
   file/build. Project tanpa slug diberi slug dari nama project. */
async function autoPublishAfterRun(
  projectId: string,
  opts: { uiChanged: boolean; buildOk: boolean },
  emit?: (event: string, data: unknown) => Promise<void>,
): Promise<{ slug?: string; url?: string; skipped?: string }> {
  if (!opts.uiChanged) return { skipped: 'tidak ada perubahan UI' }
  if (!opts.buildOk) return { skipped: 'build belum sukses' }
  if (PUBLIC_SUFFIX === 'none' || PUBLIC_ORIGIN === 'none') return { skipped: 'domain publik belum dikonfigurasi' }

  const project = getProject(projectId)
  if (!project) return { skipped: 'proyek tidak ditemukan' }
  const slug = slugify(project.slug || project.name || projectId)
  if (!slug) return { skipped: 'slug tidak valid' }

  const taken = projectBySlug(slug)
  if (taken && taken.id !== projectId) return { skipped: `slug "${slug}" sudah dipakai` }

  const build = await buildProject(projectId)
  if (build.code !== 0) return { skipped: 'build gagal saat auto-publish' }
  recordBuild(projectId, true, build.output)

  let port: number
  try {
    port = await startPreview(projectId)
  } catch {
    return { skipped: 'preview gagal dinyalakan' }
  }
  publishProject(projectId, slug)
  const url = `${PUBLIC_ORIGIN.replace('://', `://${slug}.`)}/`
  await emit?.('published', { slug, url, port })
  return { slug, url }
}

/* Published apps are public by design — no session required. */
app.get('/p/:slug', async (c) => {
  const slug = c.req.param('slug')
  const project = projectBySlug(slug)
  if (!project) return c.text(`Tidak ada aplikasi terbit dengan slug "${slug}".`, 404)

  /* On the real deployment the app has its own hostname, so /p/<slug> just
     points there. Locally there is no DNS, so fall back to the preview port. */
  if (PUBLIC_SUFFIX !== 'none') return c.redirect(`${PUBLIC_ORIGIN.replace('://', `://${slug}.`)}/`, 302)

  let port: number
  try {
    port = await startPreview(project.id)
  } catch {
    return c.text('Aplikasi terdaftar tapi preview-nya tidak bisa dinyalakan. Buka workspace proyeknya.', 503)
  }
  return c.redirect(`http://127.0.0.1:${port}/`, 302)
})

/* Live preview over the platform origin. Ownership is checked on every request,
   including assets and RPC posts, so a preview URL cannot leak to guests or to a
   different account. Two routes: the bare prefix (root of the app, after Hono
   trims a trailing slash) and everything below it. */
const livePreview = async (c: Context) => {
  const r = owned(c as Parameters<typeof owned>[0])
  if ('error' in r) return c.json({ error: r.error }, r.status)
  let port: number
  try {
    port = await startPreview(r.project.id)
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 503)
  }
  return proxyPreview(c, r.project.id, port)
}

app.all('/api/projects/:id/live', livePreview)
app.all('/api/projects/:id/live/*', livePreview)

app.delete('/api/projects/:id/preview', (c) => {
  const r = owned(c)
  if ('error' in r) return c.json({ error: r.error }, r.status)
  stopPreview(r.project.id)
  return c.json({ ok: true })
})

app.get('/api/projects/:id/preview/status', async (c) => {
  const r = owned(c)
  if ('error' in r) return c.json({ error: r.error }, r.status)
  const port = previewPort(r.project.id)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1200) })
    return c.json({ running: true, port, status: res.status })
  } catch {
    return c.json({ running: false, port })
  }
})

app.post('/api/discovery', async (c) => {
  /* Endpoint ini memanggil LLM (biaya). Batasi per IP dan panjang prompt. */
  const limited = tooMany(c, 'discovery', 20, 60 * 60_000)
  if (limited) return limited
  const body = (await c.req.json().catch(() => ({}))) as { prompt?: string }
  const prompt = (body.prompt ?? '').trim().slice(0, 2000)
  if (!prompt) return c.json({ ready: false, questions: ['Aplikasi apa yang mau dibangun?'], assumptions: [] })

  try {
    const { message } = await complete(
      [
        { role: 'system', content: DISCOVERY_SYSTEM },
        { role: 'user', content: prompt },
      ],
      { temperature: 0.1, maxTokens: 500 },
    )
    const raw = (typeof message.content === 'string' ? message.content : '').trim()
    const jsonText = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)
    const parsed = JSON.parse(jsonText) as { ready?: boolean; questions?: string[]; assumptions?: string[] }
    return c.json({
      ready: parsed.ready ?? true,
      questions: (parsed.questions ?? []).slice(0, 3),
      assumptions: (parsed.assumptions ?? []).slice(0, 4),
    })
  } catch {
    return c.json({ ready: true, questions: [], assumptions: [] })
  }
})

app.post('/api/projects/:id/chat', async (c) => {
  const r = owned(c)
  if ('error' in r) return c.json({ error: r.error }, r.status)
  /* Auth sudah ada, tapi chat menyalakan LLM berbayar: batasi juga per akun+IP. */
  const limited = tooMany(c, `chat:${c.get('user').id}`, 60, 60 * 60_000)
  if (limited) return limited
  const id = r.project.id

  const body = (await c.req.json().catch(() => ({}))) as { message?: string; model?: string; planMode?: boolean; confirmPlan?: boolean; confirmed?: boolean; imageIds?: string[] }
  const message = (body.message ?? '').trim()
  if (!message) return c.json({ error: 'message kosong' }, 400)
  const pendingPlan = getPendingPlan(id)
  const imageIds = (body.confirmed && pendingPlan?.plan.imageIds?.length ? pendingPlan.plan.imageIds : body.imageIds ?? [])
    .filter((x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{10}$/.test(x)).slice(0, 3)

  return streamSSE(c, async (stream) => {
    const dbg = (m: string) => { try { appendFileSync('/home/hatch/workspace/logs/vb-sse-debug.log', `${new Date().toISOString()} ${m}\n`) } catch {} }
    const t0 = Date.now()
    dbg(`start project=${id}`)
    c.req.raw.signal?.addEventListener('abort', () => dbg(`req ABORT at ${(Date.now() - t0) / 1000}s`))
    setStatus(id, 'working')
    const send = async (event: string, data: unknown) => {
      try {
        await stream.writeSSE({ event, data: JSON.stringify(data) })
        dbg(`sent ${event} at ${((Date.now() - t0) / 1000).toFixed(3)}s`)
      } catch (err) {
        dbg(`send fail ${event}: ${(err as Error).message}`)
      }
    }

    /* Lacak apakah run ini benar-benar mengubah file UI dan build sukses —
       dipakai untuk auto-publish sekali setelah agent selesai. */
    let uiChanged = false
    let buildOk = false

    const onEvent = async (e: AgentEvent) => {
      dbg(`event ${e.type} at ${(Date.now() - t0) / 1000}s`)
      if (e.type === 'file' && (e.action === 'write' || e.action === 'delete')) uiChanged = true
      if (e.type === 'build' && e.ok) buildOk = true
      /* Kartu aktivitas persisten: tulis event file/terminal ke
         activity_events supaya transcript chat mempertahankannya melewati
         reload (klien memuatnya lewat GET project / messages). Gagal
         mencatat tidak boleh menggagalkan run. */
      try {
        if (e.type === 'file') addActivityEvent(id, { kind: 'file', label: e.path, action: e.action })
        else if (e.type === 'build') addActivityEvent(id, { kind: 'terminal', label: 'npm run build', detail: e.log, ok: e.ok })
        else if (e.type === 'install') addActivityEvent(id, { kind: 'terminal', label: 'npm install', detail: e.log, ok: e.ok })
      } catch { /* abaikan */ }
      if (e.type === 'context') await send('context', e)
      else if (e.type === 'file') await send('file', e)
      else if (e.type === 'build') await send('build', e)
      else if (e.type === 'install') await send('install', e)
      else if (e.type === 'status') await send('status', e)
      else if (e.type === 'plan') await send('plan', e)
      else if (e.type === 'audit') await send('audit', e)
      else if (e.type === 'assistant_delta') await send('assistant_delta', e)
      else if (e.type === 'assistant') await send('assistant', e)
      else if (e.type === 'screenshot') await send('screenshot', e)
      else if (e.type === 'awaiting_confirmation') await send('awaiting_confirmation', e)
      else await send('error', e)
    }

    let agentFailed = false
    try {
      await runAgent(id, message, onEvent, body.model, body.planMode, { userId: c.get('user').id, confirmPlan: body.confirmPlan === true, confirmed: body.confirmed === true, imageIds })
      dbg(`agent resolved at ${(Date.now() - t0) / 1000}s`)
      setStatus(id, 'idle')
    } catch (err) {
      agentFailed = true
      dbg(`agent THREW at ${(Date.now() - t0) / 1000}s: ${(err as Error).message}`)
      setStatus(id, 'error')
      await send('error', { type: 'error', text: (err as Error).message })
    }
    if (!agentFailed) {
      await send('status', { type: 'status', text: 'Memastikan web publik terbaru…' })
      try {
        const res = await autoPublishAfterRun(id, { uiChanged, buildOk }, send)
        if (res.skipped) dbg(`auto-publish dilewati: ${res.skipped}`)
        else dbg(`auto-publish sukses: ${res.slug}`)
      } catch (err) {
        /* Auto-publish adalah bonus — jangan gagalkan chat yang sudah sukses. */
        dbg(`auto-publish gagal: ${(err as Error).message}`)
      }
    }
    // Checkpoint dikirim terlepas dari hasil audit: selama file berubah,
    // pengguna tetap perlu tombol Undo gaya Lovable.
    try {
      const vs = listVersions(id)
      const before = [...vs].reverse().find((v) => v.label.startsWith('sebelum:'))
      if (before) {
        const diff = getVersionDiff(id, before.id)
        const changed = diff?.changed ?? []
        if (changed.length) await send('version', { before: before.id, after: before.id + 1, changed })
      }
    } catch { /* event version opsional */ }
    await send('done', { ok: true })
    dbg(`done sent at ${(Date.now() - t0) / 1000}s`)
  })
})

app.get('/api/projects/:id/messages', (c) => {
  const r = owned(c)
  if ('error' in r) return c.json({ error: r.error }, r.status)
  return c.json({ messages: listMessages(r.project.id), events: listActivityEvents(r.project.id) })
})

/* ---------- version history ---------- */

app.get('/api/projects/:id/versions', (c) => {
  const r = owned(c)
  if ('error' in r) return c.json({ error: r.error }, r.status)
  return c.json({ versions: listVersions(r.project.id) })
})

app.get('/api/projects/:id/versions/:vid', (c) => {
  const r = owned(c)
  if ('error' in r) return c.json({ error: r.error }, r.status)
  const vid = Number(c.req.param('vid'))
  const diff = getVersionDiff(r.project.id, vid)
  if (!diff) return c.json({ error: 'versi tidak ditemukan' }, 404)
  return c.json(diff)
})

app.get('/api/projects/:id/versions/:vid/changes', (c) => {
  const r = owned(c)
  if ('error' in r) return c.json({ error: r.error }, r.status)
  const vid = Number(c.req.param('vid'))
  const dir = join(PROJECTS_DIR, r.project.id, '.versions')
  const file = join(dir, `v${vid}.json`)
  if (!existsSync(file)) return c.json({ error: 'versi tidak ditemukan' }, 404)
  let snap: { id: number; label: string; created_at: number; files: { path: string; content: string }[] }
  try { snap = JSON.parse(readFileSync(file, 'utf8')) } catch { return c.json({ error: 'versi rusak' }, 400) }
  const before = new Map(snap.files.map((f) => [f.path, f.content]))
  const current = new Map(listFiles(r.project.id).map((f) => [f.path, getFile(r.project.id, f.path) ?? '']))
  const paths = new Set([...before.keys(), ...current.keys()])
  const changes: { path: string; kind: 'added' | 'removed' | 'modified'; diff: string[] }[] = []
  for (const path of paths) {
    const a = before.get(path)
    const b = current.get(path)
    const kind = a === undefined ? 'added' : b === undefined ? 'removed' : a === b ? null : 'modified'
    if (!kind) continue
    changes.push({ path, kind, diff: diffLines(a ?? '', b ?? '').slice(0, 120) })
  }
  return c.json({ version: snap.id, label: snap.label, created_at: snap.created_at, changes })
})

app.post('/api/projects/:id/versions/:vid/restore', async (c) => {
  const r = owned(c)
  if ('error' in r) return c.json({ error: r.error }, r.status)
  const vid = Number(c.req.param('vid'))
  const res = restoreVersion(r.project.id, vid)
  if (!res.ok) return c.json({ error: 'versi tidak ditemukan' }, 404)
  snapshotVersion(r.project.id, `restore ke v${vid}`)
  const build = await buildProject(r.project.id)
  recordBuild(r.project.id, build.code === 0, build.output)
  return c.json({ ok: true, restored: res.restored, buildOk: build.code === 0 })
})

/* ---------- file diff ---------- */

app.get('/api/projects/:id/file/diff', (c) => {
  const r = owned(c)
  if ('error' in r) return c.json({ error: r.error }, r.status)
  const path = c.req.query('path') ?? ''
  const before = c.req.query('before') ?? ''
  const after = getFile(r.project.id, path) ?? readProjectFile(r.project.id, path) ?? ''
  return c.json({ path, diff: diffLines(before, after).slice(0, 400) })
})

/* ---------- export seluruh proyek sebagai ZIP ---------- */

app.get('/api/projects/:id/export', (c) => {
  const r = owned(c)
  if ('error' in r) return c.json({ error: r.error }, r.status)
  const zip = projectZip(r.project.id)
  if (!zip) return c.json({ error: 'belum ada file untuk diekspor' }, 400)
  const safeName = (r.project.name || r.project.id).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || r.project.id
  return new Response(new Uint8Array(zip), {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${safeName}.zip"`,
    },
  })
})

/* ---------- marketplace ---------- */

import {
  listMarketplace,
  publishListing,
  unpublishListing,
  forkListing,
  marketplaceCategories,
  listMyListings,
} from './marketplace.ts'

/* Galeri publik — boleh diakses tanpa login. */
app.get('/api/marketplace', (c) => {
  const category = c.req.query('category')
  return c.json({ listings: listMarketplace(category), categories: marketplaceCategories() })
})

/* Listing milik pengguna. */
app.get('/api/marketplace/mine', (c) => {
  const user = currentUser(c)
  if (!user) return c.json({ error: 'Belum masuk.' }, 401)
  return c.json({ listings: listMyListings(user.id) })
})

/* Publikasikan / perbarui proyek sebagai template galeri. */
app.put('/api/projects/:id/marketplace', async (c) => {
  const r = owned(c)
  if ('error' in r) return c.json({ error: r.error }, r.status)
  const body = (await c.req.json().catch(() => ({}))) as { title?: string; description?: string; category?: string }
  const listing = publishListing(
    r.project.id,
    r.project.owner_id,
    body.title ?? r.project.name,
    body.description ?? '',
    body.category ?? 'umum',
  )
  return c.json({ ok: true, listing })
})

/* Tarik listing dari galeri. */
app.delete('/api/projects/:id/marketplace', (c) => {
  const r = owned(c)
  if ('error' in r) return c.json({ error: r.error }, r.status)
  const removed = unpublishListing(r.project.id)
  return c.json({ ok: removed })
})

/* Fork template jadi proyek baru milik pengguna. */
app.post('/api/marketplace/:listingId/fork', (c) => {
  const user = currentUser(c)
  if (!user) return c.json({ error: 'Belum masuk.' }, 401)
  const listingId = Number(c.req.param('listingId'))
  if (!Number.isFinite(listingId)) return c.json({ error: 'ID template tidak valid.' }, 400)
  const out = forkListing(listingId, user.id)
  if ('error' in out) return c.json(out, 404)
  return c.json({ ok: true, projectId: out.project.id, name: out.project.name })
})

app.post('/api/projects/:id/messages', async (c) => {
  const r = owned(c)
  if ('error' in r) return c.json({ error: r.error }, r.status)
  const body = (await c.req.json().catch(() => ({}))) as { role?: string; content?: string }
  const m = addMessage(r.project.id, body.role ?? 'assistant', body.content ?? '')
  return c.json({ message: m })
})

/* ---------- referensi gambar (screenshot desain dari user) ---------- */

app.get('/api/projects/:id/references', async (c) => {
  const r = owned(c)
  if ('error' in r) return c.json({ error: r.error }, r.status)
  return c.json({ images: await listReferenceImages(r.project.id) })
})

app.post('/api/projects/:id/references', async (c) => {
  const r = owned(c)
  if ('error' in r) return c.json({ error: r.error }, r.status)
  const body = (await c.req.json().catch(() => ({}))) as { dataUrl?: string; name?: string }
  try {
    if (!body.dataUrl) throw new Error('dataUrl gambar wajib diisi')
    const image = await saveReferenceImage(r.project.id, body.dataUrl, body.name ?? 'referensi')
    return c.json({ ok: true, image: { ...image, dataUrl: undefined } })
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 400)
  }
})

app.get('/api/projects/:id/references/:refId', async (c) => {
  const r = owned(c)
  if ('error' in r) return c.json({ error: r.error }, r.status)
  const img = await readReferenceImage(r.project.id, c.req.param('refId'))
  if (!img) return c.json({ error: 'gambar tidak ditemukan' }, 404)
  const bytes = Buffer.from(img.dataUrl.split(',')[1]!, 'base64')
  return new Response(new Uint8Array(bytes), {
    headers: { 'content-type': img.mime, 'content-length': String(bytes.length), 'cache-control': 'private, max-age=31536000' },
  })
})

app.delete('/api/projects/:id/references/:refId', async (c) => {
  const r = owned(c)
  if ('error' in r) return c.json({ error: r.error }, r.status)
  const ok = await deleteReferenceImage(r.project.id, c.req.param('refId'))
  return c.json({ ok })
})

/* ---------- screenshot preview ---------- */

app.get('/api/projects/:id/screenshots', (c) => {
  const r = owned(c)
  if ('error' in r) return c.json({ error: r.error }, r.status)
  return c.json({ screenshots: listScreenshots(r.project.id) })
})

/* Response gambar, bukan JSON, dengan content-type dan panjang eksplisit. */
app.get('/api/projects/:id/screenshots/:name', (c) => {
  const r = owned(c)
  if ('error' in r) return c.json({ error: r.error }, r.status)
  const data = readScreenshot(r.project.id, c.req.param('name'))
  if (!data) return c.json({ error: 'screenshot tidak ditemukan' }, 404)
  return new Response(new Uint8Array(data), {
    headers: { 'content-type': 'image/png', 'content-length': String(data.length), 'cache-control': 'private, max-age=31536000' },
  })
})

app.post('/api/projects/:id/screenshots', async (c) => {
  const r = owned(c)
  if ('error' in r) return c.json({ error: r.error }, r.status)
  try {
    // Build first so the screenshot reflects the current workspace, not stale dist.
    const build = await buildProject(r.project.id)
    if (build.code !== 0) return c.json({ ok: false, error: 'Screenshot gagal: build belum lolos', log: build.output.slice(-2000) }, 400)
    const screenshot = await captureScreenshot(r.project.id)
    return c.json({ ok: true, screenshot })
  } catch (err) {
    return c.json({ ok: false, error: `Screenshot gagal: ${(err as Error).message}` }, 503)
  }
})

/* ---------- panel admin (Metis) ---------- */

registerAdmin(app)

/* ---------- static UI ---------- */

const UI_DIR = new URL('../../platform/dist/', import.meta.url).pathname

app.use('/assets/*', serveStatic({ root: UI_DIR }))
app.use('/favicon.svg', serveStatic({ root: UI_DIR }))

/* SEO: sitemap asli (XML), bukan fallback SPA HTML. Hanya halaman publik. */
app.get('/sitemap.xml', (c) => {
  const origin = PUBLIC_ORIGIN
  const esc = (v: string) => v.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch] as string)
  const urls = [origin + '/', origin + '/marketplace']
  for (const slug of listPublishedSlugs()) {
    if (/^[a-z0-9-]+$/i.test(slug)) urls.push(origin + '/p/' + slug)
  }
  const body = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map((u) => '  <url><loc>' + esc(u) + '</loc></url>').join('\n') + '\n</urlset>\n'
  c.header('Content-Type', 'application/xml; charset=UTF-8')
  c.header('Cache-Control', 'public, max-age=3600')
  return c.body(body)
})

app.get('/robots.txt', (c) => {
  c.header('Content-Type', 'text/plain; charset=UTF-8')
  return c.body([
    'User-agent: *',
    'Allow: /',
    'Disallow: /api/',
    'Disallow: /proyek/',
    'Disallow: /admin',
    'Disallow: /masuk',
    'Disallow: /daftar',
    '',
    'Sitemap: ' + PUBLIC_ORIGIN + '/sitemap.xml',
    '',
  ].join('\n'))
})

app.get('/', async (c) => {
  const fs = await import('node:fs/promises')
  const html = await fs.readFile(`${UI_DIR}index.html`, 'utf8').catch(() => null)
  if (!html) return c.text('UI belum di-build. Jalankan: cd platform && npm run build', 503)
  // Entry point tidak boleh di-cache (browser/CDN): aset JS/CSS sudah
  // content-hash, jadi index.html segar = deploy baru langsung terlihat.
  c.header('Cache-Control', 'no-store')
  return c.html(html)
})

// SPA fallback: client-side routes (/proyek/:id, /profil, ...) semuanya
// memakai index.html yang sama. API dan aset statis tidak ikut fallback.
app.get('*', async (c) => {
  const p = c.req.path
  if (p.startsWith('/api/') || p.startsWith('/assets/') || p.startsWith('/p/')) {
    return c.json({ error: 'Not found' }, 404)
  }
  const fs = await import('node:fs/promises')
  const html = await fs.readFile(`${UI_DIR}index.html`, 'utf8').catch(() => null)
  if (!html) return c.text('UI belum di-build. Jalankan: cd platform && npm run build', 503)
  c.header('Cache-Control', 'no-store')
  return c.html(html)
})

function slugify(input: string) {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

import type { Hono, Context, Next } from 'hono'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { db, deleteProject } from './db.ts'
import { stopPreview, runningPreviews } from './workspace.ts'
import { SESSION_COOKIE, readCookie, userByToken, type User } from './auth.ts'
import { llmUsage, FAST_MODEL, STRONG_MODEL, LLM_ENDPOINT, LLM_KEY_CONFIGURED } from './llm.ts'
import { ROOT } from './paths.ts'

type AdminEnv = { Variables: { user: User } }

/* ------------------------------------------------------------------ */
/* Gerbang admin                                                       */
/*                                                                     */
/* Skema users tidak punya kolom role. Admin ditentukan dengan aturan  */
/* berikut (urutan prioritas):                                         */
/*   1. VB_ADMIN_EMAIL cocok dengan email akun (bila env diset),       */
/*   2. akun pertama yang dibuat (pemilik instalasi).                  */
/* Semua akun lain ditolak (default-deny).                             */
/* ------------------------------------------------------------------ */

export function adminIdentity(): { email: string; via: 'env' | 'first-account' } | null {
  const override = (process.env.VB_ADMIN_EMAIL ?? '').trim().toLowerCase()
  if (override) {
    const row = db.prepare(`SELECT email FROM users WHERE lower(email) = ?`).get(override) as
      | { email: string }
      | undefined
    if (row) return { email: row.email, via: 'env' }
  }
  const first = db.prepare(`SELECT email FROM users ORDER BY created_at ASC, id ASC LIMIT 1`).get() as
    | { email: string }
    | undefined
  return first ? { email: first.email, via: 'first-account' } : null
}

export function isAdmin(user: User): boolean {
  const ident = adminIdentity()
  return !!ident && ident.email.toLowerCase() === user.email.toLowerCase()
}

function currentAdminUser(c: Context): User | undefined {
  const user = userByToken(readCookie(c.req.header('cookie'), SESSION_COOKIE))
  if (!user || !isAdmin(user)) return undefined
  return user
}

async function requireAdmin(c: Context<AdminEnv>, next: Next) {
  const user = userByToken(readCookie(c.req.header('cookie'), SESSION_COOKIE))
  if (!user) return c.json({ error: 'Belum masuk.' }, 401)
  if (!isAdmin(user)) return c.json({ error: 'Bukan admin.' }, 403)
  c.set('user', user)
  await next()
}

const DAY = 86_400_000
const now = () => Date.now()

function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10)
}

function last14Days(): string[] {
  const out: string[] = []
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  for (let i = 13; i >= 0; i--) {
    const t = new Date(d.getTime() - i * DAY)
    out.push(t.toISOString().slice(0, 10))
  }
  return out
}

function count(sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...(params as never[])) as { n: number }).n
}

/* ------------------------------------------------------------------ */
/* Endpoint admin                                                      */
/* ------------------------------------------------------------------ */

export function registerAdmin(app: Hono<AdminEnv>) {
  app.use('/api/admin/*', requireAdmin)

  app.get('/api/admin/overview', (c) => {
    const t = now()
    const byStatus = db.prepare(`SELECT status, count(*) AS n FROM projects GROUP BY status`).all() as {
      status: string
      n: number
    }[]
    const statusMap: Record<string, number> = {}
    for (const r of byStatus) statusMap[r.status] = r.n

    const recentUsers = db
      .prepare(`SELECT email, name, created_at FROM users ORDER BY created_at DESC LIMIT 5`)
      .all() as { email: string; name: string; created_at: number }[]
    const recentProjects = db
      .prepare(
        `SELECT p.id, p.name, p.created_at, u.email AS owner_email FROM projects p
         LEFT JOIN users u ON u.id = p.owner_id ORDER BY p.created_at DESC LIMIT 5`,
      )
      .all() as { id: string; name: string; created_at: number; owner_email: string | null }[]
    const recentBuilds = db
      .prepare(
        `SELECT b.ok, b.created_at, p.name AS project_name FROM builds b
         JOIN projects p ON p.id = b.project_id ORDER BY b.id DESC LIMIT 5`,
      )
      .all() as { ok: number; created_at: number; project_name: string }[]

    const recent: { kind: string; text: string; at: number }[] = [
      ...recentUsers.map((u) => ({ kind: 'user', text: `Pengguna baru: ${u.name || u.email} (${u.email})`, at: u.created_at })),
      ...recentProjects.map((p) => ({
        kind: 'project',
        text: `Proyek baru: ${p.name}${p.owner_email ? ` oleh ${p.owner_email}` : ''}`,
        at: p.created_at,
      })),
      ...recentBuilds.map((b) => ({
        kind: 'build',
        text: `Build ${b.ok ? 'berhasil' : 'gagal'}: ${b.project_name}`,
        at: b.created_at,
      })),
    ]
      .sort((a, b) => b.at - a.at)
      .slice(0, 10)

    const topUsers = db
      .prepare(
        `SELECT u.id, u.email, u.name,
           (SELECT count(*) FROM projects p WHERE p.owner_id = u.id) AS projects,
           (SELECT count(*) FROM messages m JOIN projects p ON p.id = m.project_id WHERE p.owner_id = u.id) AS messages
         FROM users u ORDER BY messages DESC, projects DESC LIMIT 5`,
      )
      .all() as { id: string; email: string; name: string; projects: number; messages: number }[]

    return c.json({
      users: { total: count(`SELECT count(*) AS n FROM users`), new7d: count(`SELECT count(*) AS n FROM users WHERE created_at >= ?`, t - 7 * DAY), disabled: count(`SELECT count(*) AS n FROM users WHERE disabled = 1`) },
      projects: {
        total: count(`SELECT count(*) AS n FROM projects`),
        published: count(`SELECT count(*) AS n FROM projects WHERE slug IS NOT NULL`),
        new7d: count(`SELECT count(*) AS n FROM projects WHERE created_at >= ?`, t - 7 * DAY),
        byStatus: statusMap,
      },
      messages: {
        total: count(`SELECT count(*) AS n FROM messages`),
        today: count(`SELECT count(*) AS n FROM messages WHERE created_at >= ?`, new Date().setHours(0, 0, 0, 0)),
        last7d: count(`SELECT count(*) AS n FROM messages WHERE created_at >= ?`, t - 7 * DAY),
      },
      builds: {
        total: count(`SELECT count(*) AS n FROM builds`),
        ok: count(`SELECT count(*) AS n FROM builds WHERE ok = 1`),
        fail: count(`SELECT count(*) AS n FROM builds WHERE ok = 0`),
      },
      usage: { ...llmUsage },
      recent,
      topUsers,
    })
  })

  app.get('/api/admin/users', (c) => {
    const ident = adminIdentity()
    const rows = db
      .prepare(
        `SELECT u.id, u.email, u.name, u.created_at, u.disabled,
           (SELECT count(*) FROM projects p WHERE p.owner_id = u.id) AS projects,
           (SELECT count(*) FROM messages m JOIN projects p ON p.id = m.project_id WHERE p.owner_id = u.id) AS messages,
           (SELECT max(s.created_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen
         FROM users u ORDER BY u.created_at ASC`,
      )
      .all() as {
      id: string
      email: string
      name: string
      created_at: number
      disabled: number
      projects: number
      messages: number
      last_seen: number | null
    }[]
    return c.json({
      adminEmail: ident?.email ?? null,
      users: rows.map((u) => ({ ...u, isAdmin: ident?.email.toLowerCase() === u.email.toLowerCase() })),
    })
  })

  app.patch('/api/admin/users/:id', async (c) => {
    const me = c.get('user')
    const id = c.req.param('id')
    const target = db.prepare(`SELECT id, email FROM users WHERE id = ?`).get(id) as
      | { id: string; email: string }
      | undefined
    if (!target) return c.json({ error: 'Pengguna tidak ditemukan.' }, 404)
    if (target.id === me.id) return c.json({ error: 'Akun sendiri tidak boleh diubah dari sini.' }, 400)
    const body = (await c.req.json().catch(() => ({}))) as { disabled?: boolean }
    if (typeof body.disabled !== 'boolean') return c.json({ error: 'Field disabled wajib boolean.' }, 400)
    db.prepare(`UPDATE users SET disabled = ? WHERE id = ?`).run(body.disabled ? 1 : 0, id)
    if (body.disabled) db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(id)
    return c.json({ ok: true, id, disabled: body.disabled })
  })

  app.delete('/api/admin/users/:id', (c) => {
    const me = c.get('user')
    const id = c.req.param('id')
    const target = db.prepare(`SELECT id, email FROM users WHERE id = ?`).get(id) as
      | { id: string; email: string }
      | undefined
    if (!target) return c.json({ error: 'Pengguna tidak ditemukan.' }, 404)
    if (target.id === me.id) return c.json({ error: 'Akun sendiri tidak boleh dihapus.' }, 400)
    const owned = db.prepare(`SELECT id FROM projects WHERE owner_id = ?`).all(id) as { id: string }[]
    for (const p of owned) {
      try {
        stopPreview(p.id)
      } catch {
        /* preview tidak jalan, lanjut hapus */
      }
      deleteProject(p.id)
    }
    db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(id)
    db.prepare(`DELETE FROM users WHERE id = ?`).run(id)
    return c.json({ ok: true, deletedProjects: owned.length })
  })

  app.get('/api/admin/projects', (c) => {
    const rows = db
      .prepare(
        `SELECT p.id, p.name, p.status, p.slug, p.created_at, p.updated_at, p.owner_id,
           u.email AS owner_email, u.name AS owner_name,
           (SELECT count(*) FROM messages m WHERE m.project_id = p.id) AS messages,
           (SELECT count(*) FROM files f WHERE f.project_id = p.id) AS files,
           (SELECT ok FROM builds b WHERE b.project_id = p.id ORDER BY b.id DESC LIMIT 1) AS last_build_ok
         FROM projects p LEFT JOIN users u ON u.id = p.owner_id ORDER BY p.updated_at DESC`,
      )
      .all()
    return c.json({ projects: rows })
  })

  app.delete('/api/admin/projects/:id', (c) => {
    const id = c.req.param('id')
    const row = db.prepare(`SELECT id FROM projects WHERE id = ?`).get(id)
    if (!row) return c.json({ error: 'Proyek tidak ditemukan.' }, 404)
    try {
      stopPreview(id)
    } catch {
      /* preview tidak jalan, lanjut hapus */
    }
    deleteProject(id)
    return c.json({ ok: true })
  })

  app.get('/api/admin/usage', (c) => {
    const days = last14Days()
    const perDay: Record<string, { messages: number; users: number; projects: number }> = {}
    for (const d of days) perDay[d] = { messages: 0, users: 0, projects: 0 }
    const since = Date.parse(`${days[0]}T00:00:00Z`)
    const msgRows = db
      .prepare(
        `SELECT date(created_at/1000, 'unixepoch') AS d, count(*) AS n FROM messages
         WHERE created_at >= ? GROUP BY d`,
      )
      .all(since) as { d: string; n: number }[]
    const userRows = db
      .prepare(
        `SELECT date(created_at/1000, 'unixepoch') AS d, count(*) AS n FROM users
         WHERE created_at >= ? GROUP BY d`,
      )
      .all(since) as { d: string; n: number }[]
    const projRows = db
      .prepare(
        `SELECT date(created_at/1000, 'unixepoch') AS d, count(*) AS n FROM projects
         WHERE created_at >= ? GROUP BY d`,
      )
      .all(since) as { d: string; n: number }[]
    for (const r of msgRows) if (perDay[r.d]) perDay[r.d].messages = r.n
    for (const r of userRows) if (perDay[r.d]) perDay[r.d].users = r.n
    for (const r of projRows) if (perDay[r.d]) perDay[r.d].projects = r.n
    const daily = days.map((d) => ({ date: d, ...perDay[d] }))

    const byUser = db
      .prepare(
        `SELECT u.email, u.name, count(m.id) AS messages
         FROM messages m JOIN projects p ON p.id = m.project_id JOIN users u ON u.id = p.owner_id
         GROUP BY u.id ORDER BY messages DESC LIMIT 10`,
      )
      .all()

    return c.json({
      llm: { ...llmUsage },
      daily,
      byUser,
      totals: {
        messages: count(`SELECT count(*) AS n FROM messages`),
        projects: count(`SELECT count(*) AS n FROM projects`),
        builds: count(`SELECT count(*) AS n FROM builds`),
      },
    })
  })

  app.get('/api/admin/health', async (c) => {
    const started = Date.now()
    let llm: { reachable: boolean; status?: number; latencyMs: number; error?: string }
    try {
      const res = await fetch(LLM_ENDPOINT, { method: 'GET', signal: AbortSignal.timeout(3000) })
      llm = { reachable: true, status: res.status, latencyMs: Date.now() - started }
    } catch (err) {
      llm = { reachable: false, latencyMs: Date.now() - started, error: (err as Error).message.slice(0, 200) }
    }
    let llmHost = '-'
    try {
      llmHost = new URL(LLM_ENDPOINT).host
    } catch {
      llmHost = 'tidak valid'
    }
    const dbPath = process.env.VB_DB ?? join(ROOT, 'data', 'vibebuilder.db')
    let dbSize = 0
    try {
      dbSize = statSync(dbPath).size
    } catch {
      /* abaikan */
    }
    const mem = process.memoryUsage()
    return c.json({
      ok: true,
      uptimeSec: Math.round(process.uptime()),
      node: process.version,
      platform: process.platform,
      memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal },
      dbSize,
      model: FAST_MODEL,
      strongModel: STRONG_MODEL,
      llm: { host: llmHost, keyConfigured: LLM_KEY_CONFIGURED, ...llm },
      previews: runningPreviews(),
      counts: {
        users: count(`SELECT count(*) AS n FROM users`),
        projects: count(`SELECT count(*) AS n FROM projects`),
        messages: count(`SELECT count(*) AS n FROM messages`),
        builds: count(`SELECT count(*) AS n FROM builds`),
        sessions: count(`SELECT count(*) AS n FROM sessions`),
      },
    })
  })

  app.get('/api/admin/settings', (c) => {
    const ident = adminIdentity()
    const dbPath = process.env.VB_DB ?? join(ROOT, 'data', 'vibebuilder.db')
    let llmHost = '-'
    try {
      llmHost = new URL(LLM_ENDPOINT).host
    } catch {
      llmHost = 'tidak valid'
    }
    let dbSize = 0
    try {
      dbSize = statSync(dbPath).size
    } catch {
      /* abaikan */
    }
    return c.json({
      model: FAST_MODEL,
      strongModel: STRONG_MODEL,
      llmHost,
      llmKeyConfigured: LLM_KEY_CONFIGURED,
      publicSuffix: process.env.VB_PUBLIC_SUFFIX ?? 'none',
      publicOrigin: process.env.VB_PUBLIC_ORIGIN ?? 'none',
      dbPath,
      dbSize,
      signupOpen: count(`SELECT count(*) AS n FROM users`) === 0,
      admin: ident,
      note: 'Model dan provider dibaca dari environment saat server start. Mengubahnya butuh edit env lalu restart server.',
    })
  })

  /* ---------------------------------------------------------------- */
  /* Halaman admin (Metis) — disajikan dari server, terpisah dari     */
  /* React builder. Data semuanya dari /api/admin/*, tanpa mock.       */
  /* ---------------------------------------------------------------- */

  const ADMIN_DIR = new URL('./admin/', import.meta.url).pathname

  const serveAdminFile = async (c: Context, file: string, contentType: string) => {
    const fs = await import('node:fs/promises')
    const body = await fs.readFile(`${ADMIN_DIR}${file}`, 'utf8').catch(() => null)
    if (body === null) return c.text('File admin tidak ditemukan.', 404)
    c.header('Cache-Control', 'no-store')
    c.header('Content-Type', contentType)
    return c.body(body)
  }

  app.get('/admin', (c) => serveAdminFile(c, 'admin.html', 'text/html; charset=utf-8'))
  app.get('/admin/admin.css', (c) => serveAdminFile(c, 'admin.css', 'text/css; charset=utf-8'))
  app.get('/admin/admin.js', (c) => serveAdminFile(c, 'admin.js', 'text/javascript; charset=utf-8'))
}

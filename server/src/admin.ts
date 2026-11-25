import type { Hono, Context, Next } from 'hono'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { db, deleteProject } from './db.ts'
import { stopPreview, runningPreviews } from './workspace.ts'
import { SESSION_COOKIE, readCookie, tokenHash, userByToken, type User } from './auth.ts'
import {
  llmUsage,
  FAST_MODEL,
  STRONG_MODEL,
  AUDIT_MODEL,
  adminSetting,
  effectiveModel,
  effectiveStrongModel,
  effectiveAuditModel,
  effectiveEndpoint,
  effectiveKeyConfigured,
  completeText,
} from './llm.ts'
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

/* Plan bawaan pertama kali — hanya dibuat bila tabel plans masih kosong. */
function ensureDefaultPlan() {
  if (count(`SELECT count(*) AS n FROM plans`) === 0) {
    db.prepare(
      `INSERT INTO plans (id, name, token_limit, price_idr, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('gratis', 'Gratis', 0, 0, 'Paket bawaan: tanpa batas token.', now(), now())
  }
}

/* Tampilan Pengaturan AI: nilai efektif + dari mana asalnya
   (db = diubah dari panel admin, env = environment, default = bawaan).
   API key TIDAK PERNAH dikembalikan nilainya — hanya status terpasang. */
function aiSettingsView() {
  const src = (key: string, envSet: boolean): 'db' | 'env' | 'default' =>
    adminSetting(key) !== undefined ? 'db' : envSet ? 'env' : 'default'
  const envKey = (process.env.VB_LLM_KEY ?? process.env.HERMES_9ROUTER_API_KEY ?? '') !== ''
  return {
    model: effectiveModel(),
    modelStrong: effectiveStrongModel(),
    modelAudit: effectiveAuditModel(),
    endpoint: effectiveEndpoint(),
    keyConfigured: effectiveKeyConfigured(),
    sources: {
      model: src('llm.model', !!process.env.VB_MODEL),
      modelStrong: src('llm.model_strong', !!process.env.VB_MODEL_STRONG),
      modelAudit: src('llm.model_audit', !!process.env.VB_MODEL_AUDIT),
      endpoint: src('llm.url', !!process.env.VB_LLM_URL),
      key: adminSetting('llm.key') !== undefined ? 'db' : envKey ? 'env' : 'default',
    },
    defaults: { model: FAST_MODEL, modelStrong: STRONG_MODEL, modelAudit: AUDIT_MODEL },
  }
}

/* ------------------------------------------------------------------ */
/* Endpoint admin                                                      */
/* ------------------------------------------------------------------ */

export function registerAdmin(app: Hono<AdminEnv>) {
  ensureDefaultPlan()
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
      plans: { total: count(`SELECT count(*) AS n FROM plans`) },
      tokenUsage: {
        totalTokens: (db.prepare(`SELECT coalesce(sum(prompt_tokens + completion_tokens), 0) AS n FROM token_usage`).get() as { n: number }).n,
        usersTracked: count(`SELECT count(DISTINCT user_id) AS n FROM token_usage`),
      },
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
           (SELECT coalesce(sum(t.prompt_tokens + t.completion_tokens), 0) FROM token_usage t WHERE t.user_id = u.id) AS tokens,
           (SELECT max(s.created_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen,
           up.plan_id AS plan_id, pl.name AS plan_name, pl.token_limit AS plan_limit
         FROM users u
         LEFT JOIN user_plans up ON up.user_id = u.id
         LEFT JOIN plans pl ON pl.id = up.plan_id
         ORDER BY u.created_at ASC`,
      )
      .all() as {
      id: string
      email: string
      name: string
      created_at: number
      disabled: number
      projects: number
      messages: number
      tokens: number
      last_seen: number | null
      plan_id: string | null
      plan_name: string | null
      plan_limit: number | null
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

    /* Token per pengguna — dicatat sejak pencatatan token_usage aktif
       (riwayat sebelum itu tidak ada datanya, ditampilkan 0). */
    const byUserTokens = db
      .prepare(
        `SELECT u.email, u.name,
           sum(t.prompt_tokens + t.completion_tokens) AS tokens,
           sum(t.prompt_tokens) AS prompt_tokens, sum(t.completion_tokens) AS completion_tokens
         FROM token_usage t JOIN users u ON u.id = t.user_id
         GROUP BY u.id ORDER BY tokens DESC LIMIT 10`,
      )
      .all()

    return c.json({
      llm: { ...llmUsage },
      daily,
      byUser,
      byUserTokens,
      totals: {
        messages: count(`SELECT count(*) AS n FROM messages`),
        projects: count(`SELECT count(*) AS n FROM projects`),
        builds: count(`SELECT count(*) AS n FROM builds`),
        tokens: (db.prepare(`SELECT coalesce(sum(prompt_tokens + completion_tokens), 0) AS n FROM token_usage`).get() as { n: number }).n,
      },
    })
  })

  /* ---------------------------------------------------------------- */
  /* Biaya LLM (Fitur 7)                                               */
  /* Statistik biaya dari token_usage yang sudah tercatat (kolom model  */
  /* memang dicatat llm.ts/recordTokenUsage, jadi rincian per model     */
  /* tersedia). Harga per model diisi admin di admin_settings key      */
  /* llm_prices; model tanpa harga tampil tanpa biaya ("-") — tidak    */
  /* ada harga karangan. Angka token di sini sama dengan               */
  /* /api/admin/usage (all-time) supaya bisa dicocokkan.               */
  /* ---------------------------------------------------------------- */

  type LlmPrice = { prompt_per_1k: number; completion_per_1k: number; currency: 'IDR' }
  type LlmPrices = Record<string, LlmPrice>

  function readLlmPrices(): LlmPrices {
    try {
      const raw = adminSetting('llm_prices')
      if (!raw) return {}
      const parsed = JSON.parse(raw) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      const out: LlmPrices = {}
      for (const [model, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v !== 'object' || !v) continue
        const p = (v as { prompt_per_1k?: unknown }).prompt_per_1k
        const cc = (v as { completion_per_1k?: unknown }).completion_per_1k
        if (typeof p !== 'number' || typeof cc !== 'number' || !Number.isFinite(p) || !Number.isFinite(cc) || p < 0 || cc < 0) continue
        out[model] = { prompt_per_1k: p, completion_per_1k: cc, currency: 'IDR' }
      }
      return out
    } catch {
      return {}
    }
  }

  function costFor(prompt: number, completion: number, price: LlmPrice | undefined): number | null {
    if (!price) return null
    return Math.round((prompt / 1000) * price.prompt_per_1k + (completion / 1000) * price.completion_per_1k)
  }

  function parseCostDays(c: Context): number {
    const raw = Number(c.req.query('days') ?? 30)
    if (!Number.isFinite(raw)) return 30
    if (raw === 0) return 0 /* 0 = semua riwayat */
    return Math.min(365, Math.max(1, Math.floor(raw)))
  }

  function costReport(days: number) {
    const prices = readLlmPrices()
    const until = now()
    const since = days > 0 ? until - days * DAY : 0
    const where = days > 0 ? `WHERE created_at >= ?` : ''
    const whereT = days > 0 ? `WHERE t.created_at >= ?` : ''
    const params: unknown[] = days > 0 ? [since] : []

    type ModelRow = { model: string; requests: number; prompt_tokens: number; completion_tokens: number }
    const modelRows = db
      .prepare(
        `SELECT model, count(*) AS requests, coalesce(sum(prompt_tokens), 0) AS prompt_tokens,
                coalesce(sum(completion_tokens), 0) AS completion_tokens
         FROM token_usage ${where} GROUP BY model ORDER BY prompt_tokens + completion_tokens DESC`,
      )
      .all(...(params as never[])) as ModelRow[]
    const byModel = modelRows.map((r) => {
      const price = prices[r.model]
      return {
        model: r.model,
        requests: r.requests,
        prompt_tokens: r.prompt_tokens,
        completion_tokens: r.completion_tokens,
        total_tokens: r.prompt_tokens + r.completion_tokens,
        cost_idr: costFor(r.prompt_tokens, r.completion_tokens, price),
        priced: !!price,
      }
    })

    type UserRow = { user_id: string; email: string | null; name: string | null; requests: number; prompt_tokens: number; completion_tokens: number }
    const userRows = db
      .prepare(
        `SELECT t.user_id AS user_id, u.email AS email, u.name AS name,
                count(*) AS requests, coalesce(sum(t.prompt_tokens), 0) AS prompt_tokens,
                coalesce(sum(t.completion_tokens), 0) AS completion_tokens
         FROM token_usage t LEFT JOIN users u ON u.id = t.user_id ${whereT}
         GROUP BY t.user_id ORDER BY prompt_tokens + completion_tokens DESC`,
      )
      .all(...(params as never[])) as UserRow[]
    /* Biaya per pengguna dihitung per model (harga bisa beda per model). */
    type UserModelRow = { user_id: string; model: string; prompt_tokens: number; completion_tokens: number }
    const userModelRows = db
      .prepare(
        `SELECT t.user_id AS user_id, t.model AS model,
                coalesce(sum(t.prompt_tokens), 0) AS prompt_tokens,
                coalesce(sum(t.completion_tokens), 0) AS completion_tokens
         FROM token_usage t ${whereT} GROUP BY t.user_id, t.model`,
      )
      .all(...(params as never[])) as UserModelRow[]
    const costByUser = new Map<string, { cost: number; hasPriced: boolean; unpriced: number }>()
    for (const r of userModelRows) {
      const cur = costByUser.get(r.user_id) ?? { cost: 0, hasPriced: false, unpriced: 0 }
      const c = costFor(r.prompt_tokens, r.completion_tokens, prices[r.model])
      if (c === null) cur.unpriced += r.prompt_tokens + r.completion_tokens
      else {
        cur.cost += c
        cur.hasPriced = true
      }
      costByUser.set(r.user_id, cur)
    }
    const byUser = userRows.map((r) => {
      const cc = costByUser.get(r.user_id) ?? { cost: 0, hasPriced: false, unpriced: 0 }
      return {
        user_id: r.user_id,
        email: r.email,
        name: r.name,
        requests: r.requests,
        prompt_tokens: r.prompt_tokens,
        completion_tokens: r.completion_tokens,
        total_tokens: r.prompt_tokens + r.completion_tokens,
        cost_idr: cc.hasPriced ? cc.cost : null,
        unpriced_tokens: cc.unpriced,
      }
    })

    const totals = byModel.reduce(
      (acc, r) => ({
        requests: acc.requests + r.requests,
        prompt_tokens: acc.prompt_tokens + r.prompt_tokens,
        completion_tokens: acc.completion_tokens + r.completion_tokens,
        total_tokens: acc.total_tokens + r.total_tokens,
        cost_idr: acc.cost_idr + (r.cost_idr ?? 0),
        hasPriced: acc.hasPriced || r.priced,
        unpriced_tokens: acc.unpriced_tokens + (r.priced ? 0 : r.total_tokens),
      }),
      { requests: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_idr: 0, hasPriced: false, unpriced_tokens: 0 },
    )
    const allTime = (db.prepare(
      `SELECT count(*) AS requests, coalesce(sum(prompt_tokens), 0) AS prompt_tokens,
              coalesce(sum(completion_tokens), 0) AS completion_tokens
       FROM token_usage`,
    ).get() as { requests: number; prompt_tokens: number; completion_tokens: number })
    return {
      days,
      since: days > 0 ? since : null,
      until,
      prices,
      byModel,
      byUser,
      totals: { ...totals, cost_idr: totals.hasPriced ? totals.cost_idr : null },
      allTime: { ...allTime, total_tokens: allTime.prompt_tokens + allTime.completion_tokens },
    }
  }

  function csvCell(v: unknown): string {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }

  app.get('/api/admin/cost', (c) => c.json(costReport(parseCostDays(c))))

  app.get('/api/admin/cost.csv', (c) => {
    const days = parseCostDays(c)
    const r = costReport(days)
    const lines: string[] = [
      'bagian,model_atau_pengguna,permintaan,prompt_tokens,completion_tokens,total_tokens,biaya_idr',
      ...r.byModel.map((m) =>
        ['per_model', m.model || '(tanpa model)', m.requests, m.prompt_tokens, m.completion_tokens, m.total_tokens, m.cost_idr ?? ''].map(csvCell).join(','),
      ),
      ...r.byUser.map((u) =>
        ['per_pengguna', u.email ?? `id:${u.user_id}`, u.requests, u.prompt_tokens, u.completion_tokens, u.total_tokens, u.cost_idr ?? ''].map(csvCell).join(','),
      ),
      ['total', '', r.totals.requests, r.totals.prompt_tokens, r.totals.completion_tokens, r.totals.total_tokens, r.totals.cost_idr ?? ''].map(csvCell).join(','),
    ]
    const label = days === 0 ? 'semua' : `${days}hari`
    /* c.text() menimpa Content-Type jadi text/plain — pakai c.body supaya
       header text/csv di bawah ini yang dipakai. */
    return c.body(lines.join('\n') + '\n', 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="biaya-llm-${label}.csv"`,
    })
  })

  app.put('/api/admin/cost/prices', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { prices?: unknown }
    if (!body.prices || typeof body.prices !== 'object' || Array.isArray(body.prices)) {
      return c.json({ error: 'Field prices wajib objek.' }, 400)
    }
    const cleaned: LlmPrices = {}
    for (const [model, v] of Object.entries(body.prices as Record<string, unknown>)) {
      const name = model.trim()
      if (!name || name.length > 120 || !/^[A-Za-z0-9][A-Za-z0-9._\-/:]*$/.test(name)) {
        return c.json({ error: `Nama model tidak valid: ${model}` }, 400)
      }
      if (typeof v !== 'object' || !v) return c.json({ error: `Harga model ${name} tidak valid.` }, 400)
      const p = Number((v as { prompt_per_1k?: unknown }).prompt_per_1k)
      const cc = Number((v as { completion_per_1k?: unknown }).completion_per_1k)
      if (!Number.isFinite(p) || !Number.isFinite(cc) || p < 0 || cc < 0) {
        return c.json({ error: `Harga model ${name} harus angka >= 0 (Rp per 1.000 token).` }, 400)
      }
      cleaned[name] = { prompt_per_1k: p, completion_per_1k: cc, currency: 'IDR' }
    }
    db.prepare(
      `INSERT INTO admin_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run('llm_prices', JSON.stringify(cleaned), now())
    return c.json({ ok: true, prices: cleaned })
  })

  app.get('/api/admin/health', async (c) => {
    const started = Date.now()
    const endpoint = effectiveEndpoint()
    let llm: { reachable: boolean; status?: number; latencyMs: number; error?: string }
    try {
      const res = await fetch(endpoint, { method: 'GET', signal: AbortSignal.timeout(3000) })
      llm = { reachable: true, status: res.status, latencyMs: Date.now() - started }
    } catch (err) {
      llm = { reachable: false, latencyMs: Date.now() - started, error: (err as Error).message.slice(0, 200) }
    }
    let llmHost = '-'
    try {
      llmHost = new URL(endpoint).host
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
      model: effectiveModel(),
      strongModel: effectiveStrongModel(),
      auditModel: effectiveAuditModel(),
      llm: { host: llmHost, keyConfigured: effectiveKeyConfigured(), ...llm },
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
      llmHost = new URL(effectiveEndpoint()).host
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
      ...aiSettingsView(),
      llmHost,
      publicSuffix: process.env.VB_PUBLIC_SUFFIX ?? 'none',
      publicOrigin: process.env.VB_PUBLIC_ORIGIN ?? 'none',
      dbPath,
      dbSize,
      signupOpen: count(`SELECT count(*) AS n FROM users`) === 0,
      admin: ident,
      note: 'Model dan provider bisa diubah dari halaman Pengaturan AI (disimpan di database, berlaku tanpa restart). Nilai bertanda "env" berasal dari environment server.',
    })
  })

  /* ---------------------------------------------------------------- */
  /* Pengaturan AI                                                     */
  /* Nilai sensitif (API key) tidak pernah dikembalikan — hanya status */
  /* terpasang. Kosongkan field untuk kembali memakai environment.     */
  /* ---------------------------------------------------------------- */

  app.get('/api/admin/ai-settings', (c) => c.json(aiSettingsView()))

  app.put('/api/admin/ai-settings', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      model?: string
      modelStrong?: string
      modelAudit?: string
      endpoint?: string
      key?: string
    }
    const setOrClear = (key: string, v: unknown, validate: (s: string) => string | null): string | null => {
      if (v === undefined) return null
      if (typeof v !== 'string') return `Field ${key} harus string.`
      const s = v.trim()
      if (s === '') {
        db.prepare(`DELETE FROM admin_settings WHERE key = ?`).run(key)
        return null
      }
      const err = validate(s)
      if (err) return err
      db.prepare(
        `INSERT INTO admin_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(key, s, now())
      return null
    }
    const modelOk = (s: string) =>
      s.length > 120 || !/^[A-Za-z0-9][A-Za-z0-9._\-/:]*$/.test(s) ? 'Nama model tidak valid (maks 120 karakter).' : null
    const urlOk = (s: string) => {
      try {
        const u = new URL(s)
        return u.protocol === 'http:' || u.protocol === 'https:' ? null : 'Endpoint harus URL http(s).'
      } catch {
        return 'Endpoint harus URL http(s) yang valid.'
      }
    }
    const keyOk = (s: string) => (s.length < 8 ? 'API key terlalu pendek (min 8 karakter).' : null)

    for (const [key, v, validate] of [
      ['llm.model', body.model, modelOk],
      ['llm.model_strong', body.modelStrong, modelOk],
      ['llm.model_audit', body.modelAudit, modelOk],
      ['llm.url', body.endpoint, urlOk],
      ['llm.key', body.key, keyOk],
    ] as const) {
      const err = setOrClear(key, v, validate)
      if (err) return c.json({ error: err }, 400)
    }
    return c.json({ ok: true, ...aiSettingsView() })
  })

  /* Tes koneksi LLM dengan konfigurasi efektif saat ini. */
  app.post('/api/admin/ai-settings/test', async (c) => {
    const me = c.get('user')
    const t0 = Date.now()
    try {
      const reply = await completeText('Jawab singkat saja: berapa 1+1?', effectiveModel(), 'Kamu asisten yang menjawab sangat singkat.', me.id)
      return c.json({ ok: true, model: effectiveModel(), latencyMs: Date.now() - t0, reply: reply.slice(0, 500) })
    } catch (err) {
      return c.json({ ok: false, model: effectiveModel(), latencyMs: Date.now() - t0, error: (err as Error).message.slice(0, 300) })
    }
  })

  /* ---------------------------------------------------------------- */
  /* Plan                                                              */
  /* token_limit 0 = tanpa batas. Kuota dipakai untuk pemantauan di     */
  /* panel (token tercatat per pengguna); chat belum dibatasi kuota.    */
  /* ---------------------------------------------------------------- */

  app.get('/api/admin/plans', (c) => {
    const plans = db
      .prepare(
        `SELECT p.*, (SELECT count(*) FROM user_plans up WHERE up.plan_id = p.id) AS users
         FROM plans p ORDER BY p.created_at ASC`,
      )
      .all()
    return c.json({ plans })
  })

  app.post('/api/admin/plans', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: string
      tokenLimit?: number
      priceIdr?: number
      description?: string
    }
    const name = (body.name ?? '').trim()
    if (!name || name.length > 80) return c.json({ error: 'Nama plan wajib diisi (maks 80 karakter).' }, 400)
    const tokenLimit = Math.max(0, Math.floor(Number(body.tokenLimit ?? 0) || 0))
    const priceIdr = Math.max(0, Math.floor(Number(body.priceIdr ?? 0) || 0))
    const description = String(body.description ?? '').slice(0, 500)
    const id = `plan_${Math.random().toString(36).slice(2, 8)}`
    db.prepare(
      `INSERT INTO plans (id, name, token_limit, price_idr, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, name, tokenLimit, priceIdr, description, now(), now())
    return c.json({ ok: true, id })
  })

  app.patch('/api/admin/plans/:id', async (c) => {
    const id = c.req.param('id')
    const row = db.prepare(`SELECT id FROM plans WHERE id = ?`).get(id)
    if (!row) return c.json({ error: 'Plan tidak ditemukan.' }, 404)
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: string
      tokenLimit?: number
      priceIdr?: number
      description?: string
    }
    const sets: string[] = []
    const params: unknown[] = []
    if (body.name !== undefined) {
      const name = String(body.name).trim()
      if (!name || name.length > 80) return c.json({ error: 'Nama plan wajib diisi (maks 80 karakter).' }, 400)
      sets.push('name = ?')
      params.push(name)
    }
    if (body.tokenLimit !== undefined) {
      sets.push('token_limit = ?')
      params.push(Math.max(0, Math.floor(Number(body.tokenLimit) || 0)))
    }
    if (body.priceIdr !== undefined) {
      sets.push('price_idr = ?')
      params.push(Math.max(0, Math.floor(Number(body.priceIdr) || 0)))
    }
    if (body.description !== undefined) {
      sets.push('description = ?')
      params.push(String(body.description).slice(0, 500))
    }
    if (!sets.length) return c.json({ error: 'Tidak ada field yang diubah.' }, 400)
    sets.push('updated_at = ?')
    params.push(now())
    db.prepare(`UPDATE plans SET ${sets.join(', ')} WHERE id = ?`).run(...(params as never[]), id)
    return c.json({ ok: true })
  })

  app.delete('/api/admin/plans/:id', (c) => {
    const id = c.req.param('id')
    const row = db.prepare(`SELECT id FROM plans WHERE id = ?`).get(id)
    if (!row) return c.json({ error: 'Plan tidak ditemukan.' }, 404)
    db.prepare(`DELETE FROM user_plans WHERE plan_id = ?`).run(id)
    db.prepare(`DELETE FROM plans WHERE id = ?`).run(id)
    return c.json({ ok: true })
  })

  app.post('/api/admin/users/:id/plan', async (c) => {
    const id = c.req.param('id')
    const target = db.prepare(`SELECT id FROM users WHERE id = ?`).get(id)
    if (!target) return c.json({ error: 'Pengguna tidak ditemukan.' }, 404)
    const body = (await c.req.json().catch(() => ({}))) as { planId?: string | null }
    const planId = body.planId ?? null
    if (planId !== null) {
      const plan = db.prepare(`SELECT id FROM plans WHERE id = ?`).get(planId)
      if (!plan) return c.json({ error: 'Plan tidak ditemukan.' }, 404)
      db.prepare(
        `INSERT INTO user_plans (user_id, plan_id, assigned_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET plan_id = excluded.plan_id, assigned_at = excluded.assigned_at`,
      ).run(id, planId, now())
    } else {
      db.prepare(`DELETE FROM user_plans WHERE user_id = ?`).run(id)
    }
    return c.json({ ok: true, planId })
  })

  /* ---------------------------------------------------------------- */
  /* Build, Pesan, Sesi                                                */
  /* ---------------------------------------------------------------- */

  app.get('/api/admin/builds', (c) => {
    const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 50) || 50))
    const rows = db
      .prepare(
        `SELECT b.id, b.project_id, b.ok, b.log, b.created_at, p.name AS project_name, u.email AS owner_email
         FROM builds b JOIN projects p ON p.id = b.project_id
         LEFT JOIN users u ON u.id = p.owner_id
         ORDER BY b.id DESC LIMIT ?`,
      )
      .all(limit)
    return c.json({ builds: rows })
  })

  app.get('/api/admin/messages', (c) => {
    const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 100) || 100))
    const q = (c.req.query('q') ?? '').trim()
    const where = q ? `WHERE m.content LIKE ?` : ''
    const params: unknown[] = q ? [`%${q}%`, limit] : [limit]
    const rows = db
      .prepare(
        `SELECT m.id, m.project_id, m.role, substr(m.content, 1, 300) AS excerpt, m.created_at,
           p.name AS project_name, u.email AS owner_email
         FROM messages m JOIN projects p ON p.id = m.project_id
         LEFT JOIN users u ON u.id = p.owner_id
         ${where} ORDER BY m.id DESC LIMIT ?`,
      )
      .all(...(params as never[]))
    return c.json({ messages: rows })
  })

  app.get('/api/admin/sessions', (c) => {
    const rows = db
      .prepare(
        `SELECT substr(s.token_hash, 1, 12) AS hash, s.user_id, s.created_at, s.expires_at, u.email, u.name
         FROM sessions s LEFT JOIN users u ON u.id = s.user_id
         ORDER BY s.created_at DESC LIMIT 200`,
      )
      .all() as { hash: string; user_id: string; created_at: number; expires_at: number; email: string | null; name: string | null }[]
    return c.json({ sessions: rows.map((r) => ({ ...r, active: r.expires_at > now() })) })
  })

  app.delete('/api/admin/sessions/:hash', (c) => {
    const hash = c.req.param('hash')
    if (!/^[a-f0-9]{12}$/.test(hash)) return c.json({ error: 'Hash sesi tidak valid.' }, 400)
    const row = db.prepare(`SELECT token_hash FROM sessions WHERE substr(token_hash, 1, 12) = ?`).get(hash) as
      | { token_hash: string }
      | undefined
    if (!row) return c.json({ error: 'Sesi tidak ditemukan.' }, 404)
    const me = c.get('user')
    const myToken = readCookie(c.req.header('cookie'), SESSION_COOKIE)
    if (myToken && tokenHash(myToken) === row.token_hash) {
      return c.json({ error: 'Sesi sendiri tidak boleh dicabut dari sini (pakai Logout).' }, 400)
    }
    db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(row.token_hash)
    return c.json({ ok: true })
  })

  /* ---------------------------------------------------------------- */
  /* Halaman admin (Metis) — disajikan dari server, terpisah dari     */
  /* React builder. Data semuanya dari /api/admin/*, tanpa mock.       */
  /* Halaman dibuat dari template Metis asli (lihat server/src/admin/  */
  /* VENDOR.md); tiap route adalah halaman sendiri.                    */
  /* ---------------------------------------------------------------- */

  const ADMIN_DIR = new URL('./admin/', import.meta.url).pathname
  const ADMIN_PAGES: Record<string, string> = {
    '': 'dashboard.html',
    users: 'users.html',
    projects: 'projects.html',
    plans: 'plans.html',
    usage: 'usage.html',
    builds: 'builds.html',
    biaya: 'cost.html',
    messages: 'messages.html',
    sessions: 'sessions.html',
    health: 'health.html',
    'ai-settings': 'ai-settings.html',
    settings: 'settings.html',
  }
  const ADMIN_ASSET_TYPES: Record<string, string> = {
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.json': 'application/json',
    '.map': 'application/json',
  }

  const serveAdminFile = async (c: Context, rel: string, contentType: string) => {
    const fs = await import('node:fs/promises')
    const body = await fs.readFile(`${ADMIN_DIR}${rel}`).catch(() => null)
    if (body === null) return c.text('File admin tidak ditemukan.', 404)
    c.header('Cache-Control', 'no-store')
    c.header('Content-Type', contentType)
    return c.body(body)
  }

  const ADMIN_HTML = 'text/html; charset=utf-8'
  for (const [slug, file] of Object.entries(ADMIN_PAGES)) {
    const path = slug === '' ? '/admin' : `/admin/${slug}`
    app.get(path, (c) => serveAdminFile(c, `pages/${file}`, ADMIN_HTML))
  }
  app.get('/admin/', (c) => c.redirect('/admin', 302))
  app.get('/admin/assets/admin.js', (c) => serveAdminFile(c, 'admin.js', 'text/javascript; charset=utf-8'))
  app.get('/admin/assets/admin-icons.css', (c) => serveAdminFile(c, 'admin-icons.css', 'text/css; charset=utf-8'))
  app.get('/admin/assets/*', (c) => {
    const rest = decodeURIComponent(c.req.path).replace(/^\/admin\/assets\//, '')
    if (!rest || rest.includes('..') || rest.startsWith('/')) return c.text('Tidak ditemukan.', 404)
    const dot = rest.lastIndexOf('.')
    const ext = dot >= 0 ? rest.slice(dot) : ''
    const type = ADMIN_ASSET_TYPES[ext]
    if (!type) return c.text('Tidak ditemukan.', 404)
    return serveAdminFile(c, `vendor/assets/${rest}`, type)
  })
}

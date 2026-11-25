import type { Hono, Context, Next } from 'hono'
import { copyFileSync, createReadStream, existsSync, readdirSync, renameSync, statSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { resolve4, resolveCname } from 'node:dns/promises'
import { DatabaseSync } from 'node:sqlite'
import { Readable } from 'node:stream'
import { randomBytes } from 'node:crypto'
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

/* ------------------------------------------------------------------ */
/* FITUR 1 — Log audit admin                                           */
/* Tabel audit_logs dibuat di awal registerAdmin (di bawah), bukan di  */
/* db.ts, supaya perubahan trek ini tetap di dalam server/src/admin.ts */
/* ------------------------------------------------------------------ */

function ensureAuditLogTable() {
  db.exec(`CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_email TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL,
    target_type TEXT NOT NULL DEFAULT '',
    target_id TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )`)
}

/* Tulis satu baris log audit. Email admin diambil dari user yang sudah
   diautentikasi requireAdmin. Gagal menulis log tidak boleh menggagalkan
   aksi admin yang sedang berjalan. */
function logAdmin(c: Context<AdminEnv>, action: string, targetType: string, targetId: string, detail: string) {
  try {
    const me = c.get('user') as User | undefined
    db.prepare(
      `INSERT INTO audit_logs (admin_email, action, target_type, target_id, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(me?.email ?? '', action, targetType, targetId, detail.slice(0, 500), now())
  } catch {
    /* abaikan */
  }
}

/* ------------------------------------------------------------------ */
/* FITUR 10 — Ambang peringatan kesehatan                              */
/* Tersimpan di admin_settings key 'alert_thresholds' (JSON); bila     */
/* belum ada dipakai default di bawah.                                 */
/* ------------------------------------------------------------------ */

function alertThresholds(): { buildFailCount: number; buildFailPct: number; diskPct: number } {
  const defaults = { buildFailCount: 3, buildFailPct: 50, diskPct: 85 }
  try {
    const raw = adminSetting('alert_thresholds')
    if (!raw) return defaults
    const parsed = JSON.parse(raw) as Partial<typeof defaults>
    return {
      buildFailCount: Math.max(1, Math.floor(Number(parsed.buildFailCount) || defaults.buildFailCount)),
      buildFailPct: Math.min(100, Math.max(1, Math.floor(Number(parsed.buildFailPct) || defaults.buildFailPct))),
      diskPct: Math.min(99, Math.max(50, Math.floor(Number(parsed.diskPct) || defaults.diskPct))),
    }
  } catch {
    return defaults
  }
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
  /* FITUR 3 — Moderasi proyek: tanda (flag) + penangguhan.
     Penangguhan TIDAK memakai nilai status (idle/working/building/error)
     supaya arti status yang sudah ada tidak berubah; kolom suspended
     sendiri yang menandainya. Penegakan di jalur publik (blokir
     preview/publish proyek ditangguhkan) TERTUNDA — butuh perubahan di
     app.ts/workspace.ts yang di luar lingkup trek ini. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_flags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      admin_email TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_project_flags_project ON project_flags(project_id);
  `)
  try {
    db.exec(`ALTER TABLE projects ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0`)
  } catch {
    /* sudah ada */
  }
  /* FITUR 6 — Domain kustom: pencatatan domain + status verifikasi DNS.
     Routing + SSL otomatis TERTUNDA — butuh pipeline deploy VPS yang
     belum diputuskan; tabel ini hanya mencatat dan memverifikasi DNS. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_domains (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      domain TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      verified_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_custom_domains_project ON custom_domains(project_id);
  `)
  /* Fitur 4 — Pengumuman: satu pengumuman aktif dalam satu waktu. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)

  ensureAuditLogTable()
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
    logAdmin(c, body.disabled ? 'user.disable' : 'user.enable', 'user', id, `${target.email} → ${body.disabled ? 'nonaktif' : 'aktif'}`)
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
    logAdmin(c, 'user.delete', 'user', id, `${target.email} (${owned.length} proyek ikut terhapus)`)
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
    const row = db.prepare(`SELECT id, name FROM projects WHERE id = ?`).get(id) as
      | { id: string; name: string }
      | undefined
    if (!row) return c.json({ error: 'Proyek tidak ditemukan.' }, 404)
    try {
      stopPreview(id)
    } catch {
      /* preview tidak jalan, lanjut hapus */
    }
    deleteProject(id)
    logAdmin(c, 'project.delete', 'project', id, row.name)
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
    /* Log audit: hanya nama field yang diubah, TIDAK PERNAH nilai key. */
    const changed = [
      ['llm.model', body.model],
      ['llm.model_strong', body.modelStrong],
      ['llm.model_audit', body.modelAudit],
      ['llm.url', body.endpoint],
      ['llm.key', body.key],
    ]
      .filter(([, v]) => v !== undefined)
      .map(([k]) => k)
    logAdmin(c, 'ai_settings.update', 'ai_settings', 'llm', changed.length ? `diubah: ${changed.join(', ')}` : 'disimpan (tanpa perubahan)')
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
    logAdmin(c, 'plan.create', 'plan', id, `${name} (Rp ${priceIdr})`)
    return c.json({ ok: true, id })
  })

  app.patch('/api/admin/plans/:id', async (c) => {
    const id = c.req.param('id')
    const row = db.prepare(`SELECT id, name FROM plans WHERE id = ?`).get(id) as
      | { id: string; name: string }
      | undefined
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
    logAdmin(c, 'plan.update', 'plan', id, row.name)
    return c.json({ ok: true })
  })

  app.delete('/api/admin/plans/:id', (c) => {
    const id = c.req.param('id')
    const row = db.prepare(`SELECT id, name FROM plans WHERE id = ?`).get(id) as
      | { id: string; name: string }
      | undefined
    if (!row) return c.json({ error: 'Plan tidak ditemukan.' }, 404)
    db.prepare(`DELETE FROM user_plans WHERE plan_id = ?`).run(id)
    db.prepare(`DELETE FROM plans WHERE id = ?`).run(id)
    logAdmin(c, 'plan.delete', 'plan', id, row.name)
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
    logAdmin(c, 'user.assign_plan', 'user', id, planId ? `plan ${planId}` : 'tanpa plan')
    return c.json({ ok: true, planId })
  })

  /* ---------------------------------------------------------------- */
  /* Fitur 4 — Pengumuman ke semua pengguna                            */
  /* Satu pengumuman aktif dalam satu waktu; mengaktifkan satu         */
  /* menonaktifkan yang lain. Banner di builder (platform/* +         */
  /* endpoint publik) BELUM dipasang — lihat laporan.                  */
  /* ---------------------------------------------------------------- */

  app.get('/api/admin/announcements', (c) => {
    const rows = db
      .prepare(`SELECT id, title, body, active, created_at, updated_at FROM announcements ORDER BY created_at DESC, id DESC`)
      .all()
    return c.json({ announcements: rows })
  })

  app.post('/api/admin/announcements', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { title?: string; body?: string }
    const title = String(body.title ?? '').trim()
    if (!title || title.length > 200) return c.json({ error: 'Judul wajib diisi (maks 200 karakter).' }, 400)
    const text = String(body.body ?? '').slice(0, 5000)
    const t = now()
    const res = db
      .prepare(`INSERT INTO announcements (title, body, active, created_at, updated_at) VALUES (?, ?, 0, ?, ?)`)
      .run(title, text, t, t)
    return c.json({ ok: true, id: Number(res.lastInsertRowid) })
  })

  app.put('/api/admin/announcements/:id', async (c) => {
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id)) return c.json({ error: 'ID tidak valid.' }, 400)
    const row = db.prepare(`SELECT id FROM announcements WHERE id = ?`).get(id)
    if (!row) return c.json({ error: 'Pengumuman tidak ditemukan.' }, 404)
    const body = (await c.req.json().catch(() => ({}))) as { title?: string; body?: string }
    const sets: string[] = []
    const params: unknown[] = []
    if (body.title !== undefined) {
      const title = String(body.title).trim()
      if (!title || title.length > 200) return c.json({ error: 'Judul wajib diisi (maks 200 karakter).' }, 400)
      sets.push('title = ?')
      params.push(title)
    }
    if (body.body !== undefined) {
      sets.push('body = ?')
      params.push(String(body.body).slice(0, 5000))
    }
    if (!sets.length) return c.json({ error: 'Tidak ada field yang diubah.' }, 400)
    sets.push('updated_at = ?')
    params.push(now())
    db.prepare(`UPDATE announcements SET ${sets.join(', ')} WHERE id = ?`).run(...(params as never[]), id)
    return c.json({ ok: true })
  })

  app.delete('/api/admin/announcements/:id', (c) => {
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id)) return c.json({ error: 'ID tidak valid.' }, 400)
    const row = db.prepare(`SELECT id FROM announcements WHERE id = ?`).get(id)
    if (!row) return c.json({ error: 'Pengumuman tidak ditemukan.' }, 404)
    db.prepare(`DELETE FROM announcements WHERE id = ?`).run(id)
    return c.json({ ok: true })
  })

  /* Aktifkan satu pengumuman (menonaktifkan semua yang lain). Body
     opsional { active: false } untuk menonaktifkan tanpa pengganti. */
  app.post('/api/admin/announcements/:id/activate', async (c) => {
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id)) return c.json({ error: 'ID tidak valid.' }, 400)
    const row = db.prepare(`SELECT id FROM announcements WHERE id = ?`).get(id)
    if (!row) return c.json({ error: 'Pengumuman tidak ditemukan.' }, 404)
    const body = (await c.req.json().catch(() => ({}))) as { active?: boolean }
    const active = body.active !== undefined ? !!body.active : true
    const t = now()
    if (active) {
      db.prepare(`UPDATE announcements SET active = 0, updated_at = ?`).run(t)
      db.prepare(`UPDATE announcements SET active = 1, updated_at = ? WHERE id = ?`).run(t, id)
    } else {
      db.prepare(`UPDATE announcements SET active = 0, updated_at = ? WHERE id = ?`).run(t, id)
    }
    return c.json({ ok: true, active })
  })

  /* ---------------------------------------------------------------- */
  /* Fitur 8 — Mode pemeliharaan                                       */
  /* Disimpan di admin_settings key maintenance_mode (JSON).            */
  /* Halaman maintenance untuk pengunjung butuh middleware di app.ts   */
  /* — BELUM dipasang, lihat laporan.                                  */
  /* ---------------------------------------------------------------- */

  function maintenanceView() {
    const raw = adminSetting('maintenance_mode')
    let parsed: { enabled?: boolean; message?: string; updated_at?: number } = {}
    if (raw) {
      try {
        parsed = JSON.parse(raw)
      } catch {
        /* nilai rusak: anggap mati */
      }
    }
    return {
      enabled: parsed.enabled === true,
      message: typeof parsed.message === 'string' ? parsed.message : '',
      updated_at: typeof parsed.updated_at === 'number' ? parsed.updated_at : null,
    }
  }

  app.get('/api/admin/maintenance', (c) => c.json(maintenanceView()))

  app.put('/api/admin/maintenance', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { enabled?: boolean; message?: string }
    if (typeof body.enabled !== 'boolean') return c.json({ error: 'Field enabled wajib boolean.' }, 400)
    const message = String(body.message ?? '').slice(0, 2000)
    const value = JSON.stringify({ enabled: body.enabled, message, updated_at: now() })
    db.prepare(
      `INSERT INTO admin_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run('maintenance_mode', value, now())
    return c.json({ ok: true, ...maintenanceView() })
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
    const owner = db.prepare(
      `SELECT u.email FROM sessions s LEFT JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    ).get(row.token_hash) as { email: string | null } | undefined
    db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(row.token_hash)
    logAdmin(c, 'session.revoke', 'session', hash, owner?.email ?? hash)
    return c.json({ ok: true })
  })

  /* ---------------------------------------------------------------- */
  /* FITUR 3 — Moderasi proyek                                       */
  /* Tandai (dengan alasan) / hapus tanda / tangguhkan / buka          */
  /* penangguhan. Penangguhan TIDAK dikaitkan dengan kuota/token       */
  /* (sistem akan memakai kredit; pemblokiran berbasis token_limit     */
  /* ditahan) dan TIDAK memblokir apa pun di jalur publik sampai       */
  /* penegakan di app.ts/workspace.ts dibangun (tertunda).             */
  /* ---------------------------------------------------------------- */

  app.get('/api/admin/moderation', (c) => {
    const rows = db
      .prepare(
        `SELECT p.id, p.name, p.status, p.slug, p.created_at, p.updated_at, p.owner_id,
           COALESCE(p.suspended, 0) AS suspended,
           u.email AS owner_email, u.name AS owner_name,
           (SELECT f.reason FROM project_flags f WHERE f.project_id = p.id ORDER BY f.id DESC LIMIT 1) AS flag_reason,
           (SELECT f.admin_email FROM project_flags f WHERE f.project_id = p.id ORDER BY f.id DESC LIMIT 1) AS flag_by,
           (SELECT f.created_at FROM project_flags f WHERE f.project_id = p.id ORDER BY f.id DESC LIMIT 1) AS flagged_at
         FROM projects p LEFT JOIN users u ON u.id = p.owner_id ORDER BY p.updated_at DESC`,
      )
      .all() as {
      id: string
      name: string
      status: string
      slug: string | null
      created_at: number
      updated_at: number
      owner_id: string | null
      suspended: number
      owner_email: string | null
      owner_name: string | null
      flag_reason: string | null
      flag_by: string | null
      flagged_at: number | null
    }[]
    return c.json({
      projects: rows.map((p) => ({ ...p, flagged: p.flag_reason !== null, suspended: p.suspended === 1 })),
    })
  })

  app.post('/api/admin/projects/:id/flag', async (c) => {
    const me = c.get('user')
    const id = c.req.param('id')
    const row = db.prepare(`SELECT id, name FROM projects WHERE id = ?`).get(id) as
      | { id: string; name: string }
      | undefined
    if (!row) return c.json({ error: 'Proyek tidak ditemukan.' }, 404)
    const body = (await c.req.json().catch(() => ({}))) as { reason?: string }
    const reason = String(body.reason ?? '').trim()
    if (!reason) return c.json({ error: 'Alasan penandaan wajib diisi.' }, 400)
    if (reason.length > 500) return c.json({ error: 'Alasan maksimal 500 karakter.' }, 400)
    db.prepare(`DELETE FROM project_flags WHERE project_id = ?`).run(id)
    const r = db
      .prepare(`INSERT INTO project_flags (project_id, admin_email, reason, created_at) VALUES (?, ?, ?, ?)`)
      .run(id, me.email, reason, now())
    return c.json({ ok: true, flagId: Number(r.lastInsertRowid) })
  })

  app.delete('/api/admin/projects/:id/flag', (c) => {
    const id = c.req.param('id')
    const row = db.prepare(`SELECT id FROM projects WHERE id = ?`).get(id)
    if (!row) return c.json({ error: 'Proyek tidak ditemukan.' }, 404)
    const r = db.prepare(`DELETE FROM project_flags WHERE project_id = ?`).run(id)
    if (Number(r.changes ?? 0) === 0) return c.json({ error: 'Proyek ini tidak ditandai.' }, 404)
    return c.json({ ok: true })
  })

  app.post('/api/admin/projects/:id/suspend', (c) => {
    const id = c.req.param('id')
    const row = db.prepare(`SELECT id FROM projects WHERE id = ?`).get(id)
    if (!row) return c.json({ error: 'Proyek tidak ditemukan.' }, 404)
    db.prepare(`UPDATE projects SET suspended = 1, updated_at = ? WHERE id = ?`).run(now(), id)
    try {
      stopPreview(id)
    } catch {
      /* preview tidak jalan, lanjut */
    }
    return c.json({ ok: true, suspended: true })
  })

  app.post('/api/admin/projects/:id/unsuspend', (c) => {
    const id = c.req.param('id')
    const row = db.prepare(`SELECT id FROM projects WHERE id = ?`).get(id)
    if (!row) return c.json({ error: 'Proyek tidak ditemukan.' }, 404)
    db.prepare(`UPDATE projects SET suspended = 0, updated_at = ? WHERE id = ?`).run(now(), id)
    return c.json({ ok: true, suspended: false })
  })

  /* ---------------------------------------------------------------- */
  /* FITUR 6 — Domain kustom                                           */
  /* Target DNS yang diharapkan: CNAME ke domain utama platform        */
  /* clidi.net (juga diterima <apa pun>.clidi.net). SSL: belum ada     */
  /* pipeline pemasangan — status SSL selalu dilaporkan                */
  /* "belum dipasang", JANGAN diklaim aktif.                           */
  /* ---------------------------------------------------------------- */

  const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i
  const EXPECTED_CNAME_SUFFIX = 'clidi.net'

  app.get('/api/admin/domains', (c) => {
    const rows = db
      .prepare(
        `SELECT d.id, d.project_id, d.domain, d.status, d.created_at, d.verified_at,
           p.name AS project_name, p.slug AS project_slug
         FROM custom_domains d LEFT JOIN projects p ON p.id = d.project_id
         ORDER BY d.created_at DESC`,
      )
      .all()
    return c.json({ domains: rows, expectedCname: EXPECTED_CNAME_SUFFIX, ssl: 'belum dipasang' })
  })

  app.post('/api/admin/domains', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { projectId?: string; domain?: string }
    const projectId = String(body.projectId ?? '').trim()
    const domain = String(body.domain ?? '')
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
    if (!projectId) return c.json({ error: 'Proyek wajib dipilih.' }, 400)
    const project = db.prepare(`SELECT id FROM projects WHERE id = ?`).get(projectId)
    if (!project) return c.json({ error: 'Proyek tidak ditemukan.' }, 404)
    if (!DOMAIN_RE.test(domain)) return c.json({ error: 'Format domain tidak valid.' }, 400)
    try {
      const r = db
        .prepare(`INSERT INTO custom_domains (project_id, domain, status, created_at) VALUES (?, ?, 'pending', ?)`)
        .run(projectId, domain, now())
      return c.json({ ok: true, id: Number(r.lastInsertRowid) })
    } catch {
      return c.json({ error: 'Domain sudah terdaftar.' }, 400)
    }
  })

  app.delete('/api/admin/domains/:id', (c) => {
    const id = c.req.param('id')
    const row = db.prepare(`SELECT id FROM custom_domains WHERE id = ?`).get(id)
    if (!row) return c.json({ error: 'Domain tidak ditemukan.' }, 404)
    db.prepare(`DELETE FROM custom_domains WHERE id = ?`).run(id)
    return c.json({ ok: true })
  })

  app.post('/api/admin/domains/:id/verify', async (c) => {
    const id = c.req.param('id')
    const row = db.prepare(`SELECT id, domain FROM custom_domains WHERE id = ?`).get(id) as
      | { id: number; domain: string }
      | undefined
    if (!row) return c.json({ error: 'Domain tidak ditemukan.' }, 404)
    const timeout = (ms: number) =>
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('DNS timeout')), ms))
    const [cnameRes, aRes] = await Promise.all([
      Promise.race([resolveCname(row.domain), timeout(5000)]).catch((e: Error) => ({ error: e.message })),
      Promise.race([resolve4(row.domain), timeout(5000)]).catch((e: Error) => ({ error: e.message })),
    ])
    const cnames: string[] = Array.isArray(cnameRes) ? cnameRes : []
    const addresses: string[] = Array.isArray(aRes) ? aRes : []
    const cnameError = !Array.isArray(cnameRes) ? (cnameRes as { error: string }).error : null
    const aError = !Array.isArray(aRes) ? (aRes as { error: string }).error : null
    const matched = cnames.some((t) => t.toLowerCase() === EXPECTED_CNAME_SUFFIX || t.toLowerCase().endsWith(`.${EXPECTED_CNAME_SUFFIX}`))
    if (matched) {
      db.prepare(`UPDATE custom_domains SET status = 'verified', verified_at = ? WHERE id = ?`).run(now(), id)
    }
    return c.json({
      ok: true,
      domain: row.domain,
      expectedCname: EXPECTED_CNAME_SUFFIX,
      cnames,
      addresses,
      cnameError,
      aError,
      matched,
      status: matched ? 'verified' : 'pending',
      note: matched
        ? 'CNAME cocok dengan target platform.'
        : 'Perlu penyesuaian manual: arahkan CNAME domain ke clidi.net, lalu periksa lagi.',
      ssl: 'belum dipasang',
    })
  })

  /* FITUR 5 — Cadangan & Pulihkan                                    */
  /* Unduh memakai VACUUM INTO (snapshot konsisten dari koneksi yang  */
  /* sedang jalan, termasuk isi WAL) lalu di-stream tanpa memuat       */
  /* seluruh file ke memori. Pulihkan: validasi dulu, simpan cadangan */
  /* otomatis DB aktif, ganti file secara atomik, lalu keluar supaya  */
  /* supervisor menghidupkan ulang server dengan DB baru. DB aktif    */
  /* TIDAK PERNAH dihapus tanpa cadangan otomatis di atas.             */
  /* ---------------------------------------------------------------- */

  const dbPath = () => process.env.VB_DB ?? join(ROOT, 'data', 'vibebuilder.db')
  const dataDir = () => dirname(dbPath())
  const BACKUP_NAME_RE = /^vibebuilder\.db\.bak-\d+$/
  const CORE_TABLES = ['users', 'projects', 'messages', 'files', 'builds', 'plans', 'token_usage', 'admin_settings']

  function backupFileName(d = new Date()): string {
    const p = (n: number) => String(n).padStart(2, '0')
    return `vibebuilder-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.db`
  }

  function listBackupFiles() {
    let names: string[] = []
    try {
      names = readdirSync(dataDir())
    } catch {
      return []
    }
    return names
      .filter((n) => n !== 'vibebuilder.db' && (BACKUP_NAME_RE.test(n) || /^vibebuilder-\d{8}-\d{4}\.db$/.test(n)))
      .sort()
      .reverse()
      .map((n) => {
        let size = 0
        let mtime = 0
        try {
          const st = statSync(join(dataDir(), n))
          size = st.size
          mtime = st.mtimeMs
        } catch {
          /* abaikan */
        }
        return { name: n, size, mtime, isAutoBackup: BACKUP_NAME_RE.test(n) }
      })
  }

  /* Buka file kandidat read-only, cek integritas + tabel inti. */
  function validateBackupDb(path: string): { ok: true } | { ok: false; error: string } {
    let check: DatabaseSync | null = null
    try {
      check = new DatabaseSync(path, { readOnly: true })
      const row = check.prepare(`PRAGMA integrity_check`).get() as { integrity_check: string } | undefined
      if (!row || row.integrity_check !== 'ok') return { ok: false, error: 'PRAGMA integrity_check gagal — file database rusak.' }
      const tables = new Set(
        (check.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((r) => r.name),
      )
      const missing = CORE_TABLES.filter((t) => !tables.has(t))
      if (missing.length) return { ok: false, error: `Tabel inti hilang: ${missing.join(', ')}.` }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: `File bukan database SQLite yang valid (${(err as Error).message.slice(0, 120)}).` }
    } finally {
      try {
        check?.close()
      } catch {
        /* abaikan */
      }
    }
  }

  /* Tukar DB aktif dengan file yang sudah divalidasi, lalu restart. */
  function swapDatabase(validatedPath: string, fromBackupFile: boolean): string {
    const ts = Date.now()
    const bakName = `vibebuilder.db.bak-${ts}`
    const bakPath = join(dataDir(), bakName)
    const active = dbPath()
    try {
      db.exec(`PRAGMA wal_checkpoint(TRUNCATE)`)
    } catch {
      /* checkpoint gagal bukan fatal — salinan tetap dibuat dari file utama */
    }
    copyFileSync(active, bakPath)
    if (fromBackupFile) copyFileSync(validatedPath, active)
    else renameSync(validatedPath, active)
    for (const suffix of ['-wal', '-shm']) {
      try {
        unlinkSync(`${active}${suffix}`)
      } catch {
        /* tidak ada / sudah terhapus */
      }
    }
    return bakName
  }

  /* Unduh cadangan: snapshot konsisten via VACUUM INTO, di-stream. */
  app.get('/api/admin/backup', (c) => {
    const tmp = join(tmpdir(), `vb-backup-${Date.now()}-${randomBytes(6).toString('hex')}.db`)
    try {
      db.prepare(`VACUUM INTO ?`).run(tmp)
    } catch (err) {
      try {
        unlinkSync(tmp)
      } catch {
        /* abaikan */
      }
      return c.json({ error: `Gagal membuat cadangan: ${(err as Error).message.slice(0, 200)}` }, 500)
    }
    let size = 0
    try {
      size = statSync(tmp).size
    } catch {
      return c.json({ error: 'Gagal membaca file cadangan.' }, 500)
    }
    const stream = createReadStream(tmp)
    stream.on('close', () => {
      try {
        unlinkSync(tmp)
      } catch {
        /* abaikan */
      }
    })
    stream.on('error', () => {
      try {
        unlinkSync(tmp)
      } catch {
        /* abaikan */
      }
    })
    return c.body(Readable.toWeb(stream) as unknown as BodyInit, 200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${backupFileName()}"`,
      'Content-Length': String(size),
    })
  })

  app.get('/api/admin/backup/list', (c) => {
    let dbSize = 0
    try {
      dbSize = statSync(dbPath()).size
    } catch {
      /* abaikan */
    }
    return c.json({
      dbSize,
      counts: {
        users: count(`SELECT count(*) AS n FROM users`),
        projects: count(`SELECT count(*) AS n FROM projects`),
        messages: count(`SELECT count(*) AS n FROM messages`),
        builds: count(`SELECT count(*) AS n FROM builds`),
      },
      files: listBackupFiles(),
    })
  })

  app.post('/api/admin/restore', async (c) => {
    const contentType = c.req.header('content-type') ?? ''
    let validatedPath: string | null = null
    let uploadedTmp: string | null = null
    let fromBackupFile = false
    try {
      if (contentType.includes('multipart/form-data')) {
        const form = await c.req.formData()
        const file = form.get('file')
        if (!file || typeof file !== 'object' || typeof (file as File).arrayBuffer !== 'function') {
          return c.json({ error: 'Field file wajib diisi (unggah file .db).' }, 400)
        }
        const f = file as File
        if (f.size === 0) return c.json({ error: 'File unggahan kosong.' }, 400)
        if (f.size > 200 * 1024 * 1024) return c.json({ error: 'File unggahan terlalu besar (maks 200 MB).' }, 400)
        uploadedTmp = join(dataDir(), `restore-${Date.now()}.db`)
        writeFileSync(uploadedTmp, Buffer.from(await f.arrayBuffer()))
        validatedPath = uploadedTmp
      } else {
        const body = (await c.req.json().catch(() => ({}))) as { backup?: string }
        const name = String(body.backup ?? '')
        if (!BACKUP_NAME_RE.test(name)) return c.json({ error: 'Nama cadangan otomatis tidak valid.' }, 400)
        const p = join(dataDir(), name)
        if (!existsSync(p)) return c.json({ error: 'File cadangan tidak ditemukan.' }, 404)
        validatedPath = p
        fromBackupFile = true
      }
      const check = validateBackupDb(validatedPath)
      if (!check.ok) {
        if (uploadedTmp) {
          try {
            unlinkSync(uploadedTmp)
          } catch {
            /* abaikan */
          }
        }
        return c.json({ error: `Cadangan tidak valid: ${check.error} Database aktif tidak diubah.` }, 400)
      }
      const bakName = swapDatabase(validatedPath, fromBackupFile)
      setTimeout(() => process.exit(0), 500)
      return c.json({ ok: true, restarting: true, autoBackup: bakName })
    } catch (err) {
      if (uploadedTmp) {
        try {
          unlinkSync(uploadedTmp)
        } catch {
          /* abaikan */
        }
      }
      return c.json({ error: `Gagal memulihkan: ${(err as Error).message.slice(0, 200)}` }, 500)
    }
  })

  /* ---------------------------------------------------------------- */
  /* FITUR 9 — Pembersihan Otomatis                                    */
  /* Yang dibersihkan: baris builds lebih lama dari retensi, dan sesi */
  /* login yang sudah kedaluwarsa. Preview TIDAK PERNAH dibunuh dari   */
  /* sini: preview adalah proses anak yang sedang dipakai — halaman    */
  /* hanya menampilkan jumlah preview yang berjalan (0 yang dihapus).  */
  /* Pengaturan + hasil terakhir disimpan di admin_settings            */
  /* (key cleanup_settings, JSON).                                     */
  /* ---------------------------------------------------------------- */

  type CleanupSettings = { retentionDays: number; auto: boolean; lastRunAt: number | null; lastRun: { at: number; builds: number; sessions: number; previews: number } | null }
  const CLEANUP_DEFAULTS: CleanupSettings = { retentionDays: 30, auto: false, lastRunAt: null, lastRun: null }

  function readCleanupSettings(): CleanupSettings {
    try {
      const raw = db.prepare(`SELECT value FROM admin_settings WHERE key = 'cleanup_settings'`).get() as { value: string } | undefined
      if (!raw) return { ...CLEANUP_DEFAULTS }
      const parsed = JSON.parse(raw.value) as Partial<CleanupSettings>
      return {
        retentionDays: Math.min(365, Math.max(1, Math.floor(Number(parsed.retentionDays) || 30))),
        auto: parsed.auto === true,
        lastRunAt: typeof parsed.lastRunAt === 'number' ? parsed.lastRunAt : null,
        lastRun: parsed.lastRun ?? null,
      }
    } catch {
      return { ...CLEANUP_DEFAULTS }
    }
  }

  function writeCleanupSettings(s: CleanupSettings) {
    db.prepare(
      `INSERT INTO admin_settings (key, value, updated_at) VALUES ('cleanup_settings', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(JSON.stringify(s), now())
  }

  function cleanupCounts(retentionDays: number) {
    const cutoff = now() - retentionDays * DAY
    return {
      builds: count(`SELECT count(*) AS n FROM builds WHERE created_at < ?`, cutoff),
      sessions: count(`SELECT count(*) AS n FROM sessions WHERE expires_at < ?`, now()),
      previewsRunning: runningPreviews().length,
    }
  }

  function runCleanup(retentionDays: number) {
    const cutoff = now() - retentionDays * DAY
    const builds = Number(db.prepare(`DELETE FROM builds WHERE created_at < ?`).run(cutoff).changes ?? 0)
    const sessions = Number(db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(now()).changes ?? 0)
    return { builds, sessions, previews: 0, previewsRunning: runningPreviews().length }
  }

  app.get('/api/admin/cleanup', (c) => {
    const settings = readCleanupSettings()
    return c.json({ settings, counts: cleanupCounts(settings.retentionDays), lastRun: settings.lastRun })
  })

  app.post('/api/admin/cleanup/run', (c) => {
    const settings = readCleanupSettings()
    const result = runCleanup(settings.retentionDays)
    const at = now()
    settings.lastRunAt = at
    settings.lastRun = { at, builds: result.builds, sessions: result.sessions, previews: result.previews }
    writeCleanupSettings(settings)
    return c.json({ ok: true, at, retentionDays: settings.retentionDays, deleted: result })
  })

  app.put('/api/admin/cleanup/settings', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { retentionDays?: number; auto?: boolean }
    const settings = readCleanupSettings()
    if (body.retentionDays !== undefined) {
      const d = Math.floor(Number(body.retentionDays))
      if (!Number.isFinite(d) || d < 1 || d > 365) return c.json({ error: 'Retensi harus 1–365 hari.' }, 400)
      settings.retentionDays = d
    }
    if (body.auto !== undefined) {
      if (typeof body.auto !== 'boolean') return c.json({ error: 'Field auto wajib boolean.' }, 400)
      settings.auto = body.auto
    }
    writeCleanupSettings(settings)
    return c.json({ ok: true, settings })
  })

  /* Berkala (sekali saat server start, di dalam registerAdmin): cek
     tiap jam; bila otomatis aktif dan sudah ≥24 jam sejak pembersihan
     terakhir (atau belum pernah), jalankan sekali. */
  if (!(globalThis as unknown as { __vbCleanupTimer?: boolean }).__vbCleanupTimer) {
    ;(globalThis as unknown as { __vbCleanupTimer?: boolean }).__vbCleanupTimer = true
    setInterval(() => {
      try {
        const s = readCleanupSettings()
        if (!s.auto) return
        if (s.lastRunAt && now() - s.lastRunAt < DAY) return
        const result = runCleanup(s.retentionDays)
        const at = now()
        s.lastRunAt = at
        s.lastRun = { at, builds: result.builds, sessions: result.sessions, previews: 0 }
        writeCleanupSettings(s)
      } catch {
        /* pembersihan berkala gagal diam-diam — jangan jatuhkan server */
      }
    }, 60 * 60 * 1000).unref()
  }

  /* ---------------------------------------------------------------- */

  /* FITUR 1 — Log audit admin (baca)                                  */
  /* FITUR 10 — Peringatan kesehatan (hitung live dari data nyata)     */
  /* ---------------------------------------------------------------- */

  app.get('/api/admin/audit', (c) => {
    const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 100) || 100))
    const q = (c.req.query('q') ?? '').trim()
    const action = (c.req.query('action') ?? '').trim()
    const where: string[] = []
    const params: unknown[] = []
    if (q) {
      where.push(`(admin_email LIKE ? OR action LIKE ? OR target_id LIKE ? OR detail LIKE ?)`)
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`)
    }
    if (action) {
      where.push(`action = ?`)
      params.push(action)
    }
    const rows = db
      .prepare(
        `SELECT id, admin_email, action, target_type, target_id, detail, created_at FROM audit_logs
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY id DESC LIMIT ?`,
      )
      .all(...(params as never[]), limit)
    return c.json({ logs: rows })
  })

  app.get('/api/admin/alerts', async (c) => {
    const t = now()
    const thresholds = alertThresholds()
    const alerts: { level: 'warning' | 'critical'; kind: string; message: string; at: number }[] = []

    /* (a) LLM — bila key belum dikonfigurasi, laporkan "tidak
       dikonfigurasi", BUKAN "mati". Baru bila key ada tapi endpoint tidak
       menjawab, laporkan LLM tidak terjangkau. */
    if (!effectiveKeyConfigured()) {
      alerts.push({
        level: 'warning',
        kind: 'llm_not_configured',
        message: 'LLM belum dikonfigurasi: API key belum dipasang di Pengaturan AI.',
        at: t,
      })
    } else {
      try {
        await fetch(effectiveEndpoint(), { method: 'GET', signal: AbortSignal.timeout(3000) })
      } catch (err) {
        alerts.push({
          level: 'critical',
          kind: 'llm_down',
          message: `LLM tidak terjangkau: ${(err as Error).message.slice(0, 120)}`,
          at: t,
        })
      }
    }

    /* (b) Error build melonjak dalam 1 jam terakhir vs ambang admin. */
    const buildRow = db.prepare(
      `SELECT count(*) AS total, coalesce(sum(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS failed
       FROM builds WHERE created_at >= ?`,
    ).get(t - 3600_000) as { total: number; failed: number }
    if (buildRow.total > 0) {
      const pct = Math.round((buildRow.failed / buildRow.total) * 100)
      if (buildRow.failed >= thresholds.buildFailCount || pct > thresholds.buildFailPct) {
        alerts.push({
          level: pct >= 80 ? 'critical' : 'warning',
          kind: 'build_fail_spike',
          message: `Build gagal melonjak: ${buildRow.failed} dari ${buildRow.total} build gagal dalam 1 jam terakhir (${pct}%).`,
          at: t,
        })
      }
    }

    /* (c) Disk hampir penuh (statfs pada direktori data). */
    try {
      const dbPath = process.env.VB_DB ?? join(ROOT, 'data', 'vibebuilder.db')
      const fs = statfsSync(dirname(dbPath))
      const total = fs.bsize * fs.blocks
      const avail = fs.bsize * fs.bavail
      if (total > 0) {
        const usedPct = Math.round(((total - avail) / total) * 100)
        if (usedPct > thresholds.diskPct) {
          alerts.push({
            level: usedPct >= 95 ? 'critical' : 'warning',
            kind: 'disk_full',
            message: `Disk hampir penuh: ${usedPct}% terpakai (ambang ${thresholds.diskPct}%).`,
            at: t,
          })
        }
      }
    } catch {
      /* statfs tidak tersedia — lewati cek disk */
    }

    return c.json({ alerts, thresholds })
  })

  /* ---------------------------------------------------------------- */  /* Halaman admin (Metis) — disajikan dari server, terpisah dari     */
  /* React builder. Data semuanya dari /api/admin/*, tanpa mock.       */
  /* Halaman dibuat dari template Metis asli (lihat server/src/admin/  */
  /* VENDOR.md); tiap route adalah halaman sendiri.                    */
  /* ---------------------------------------------------------------- */

  const ADMIN_DIR = new URL('./admin/', import.meta.url).pathname
  const ADMIN_PAGES: Record<string, string> = {
    '': 'dashboard.html',
    users: 'users.html',
    projects: 'projects.html',
    pemeliharaan: 'pemeliharaan.html',
    pengumuman: 'pengumuman.html',
    plans: 'plans.html',
    usage: 'usage.html',
    builds: 'builds.html',
    biaya: 'cost.html',
    domain: 'domain.html',
    messages: 'messages.html',
    moderasi: 'moderasi.html',
    sessions: 'sessions.html',
    health: 'health.html',
    cadangan: 'cadangan.html',
    pembersihan: 'pembersihan.html',
    'ai-settings': 'ai-settings.html',
    audit: 'audit.html',
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

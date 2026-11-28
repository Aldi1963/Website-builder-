import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ROOT } from './paths.ts'

const DB_PATH = process.env.VB_DB ?? join(ROOT, 'data', 'vibebuilder.db')

mkdirSync(dirname(DB_PATH), { recursive: true })

export const db = new DatabaseSync(DB_PATH)

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'idle',
  starter TEXT NOT NULL DEFAULT 'blank',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, path)
);

CREATE TABLE IF NOT EXISTS builds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ok INTEGER NOT NULL,
  log TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_project ON messages(project_id, id);

/* Riwayat aktivitas agent (file write/delete/mkdir, terminal build/install)
   yang tampil PERSISTEN di transcript chat ala Emergent. Sebelumnya event
   ini hanya hidup di React state (useActivity, maks 40 entri, hilang saat
   reload / reset tiap kirim pesan). Tabel ini sumber kebenarannya: server
   menulis tiap event saat run berjalan (lihat onEvent di app.ts), klien
   memuatnya bersama messages dan menggabungkannya kronologis. */
CREATE TABLE IF NOT EXISTS activity_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  action TEXT,
  detail TEXT NOT NULL DEFAULT '',
  ok INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_activity_events_project ON activity_events(project_id, id);
`)

try {
  db.exec(`ALTER TABLE projects ADD COLUMN starter TEXT NOT NULL DEFAULT 'blank'`)
} catch {
  /* kolom sudah tersedia */
}

/* ---- Admin: pengaturan override, plan, dan pencatatan token per user ---- */
/* Pengaturan AI: override database mengalahkan environment, environment
   mengalahkan default bawaan. Nilai sensitif (API key) tidak pernah
   dikembalikan API — hanya status terpasang/belum. */
db.exec(`
CREATE TABLE IF NOT EXISTS admin_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_limit INTEGER NOT NULL DEFAULT 0,
  price_idr INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_plans (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plan_id TEXT REFERENCES plans(id) ON DELETE SET NULL,
  assigned_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS token_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  model TEXT NOT NULL DEFAULT '',
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_token_usage_user ON token_usage(user_id, created_at);
`)

/* Jatah credit bulanan plan (fase 4, hybrid): Gratis 100/bln, Pro 2000/bln.
   0 = plan tanpa jatah credit. Kolom ditambah di tempat supaya DB yang
   sudah ada tetap jalan tanpa alat migrasi. */
try {
  db.exec(`ALTER TABLE plans ADD COLUMN monthly_credits INTEGER NOT NULL DEFAULT 0`)
} catch {
  /* sudah ada */
}

/* ---- Credit (fase 1): saldo dua bucket + riwayat pemakaian per panggilan ----
   1 credit = $0,001 biaya LLM. Saldo boleh pecahan (REAL). Bucket free
   (gratis, ada expiry + cap harian) dipotong dulu, lalu purchased, lalu
   plan_credits (jatah bulanan plan, dipakai fase 4). Tarif + cost_usd
   disimpan per panggilan supaya repricing tidak menulis ulang riwayat.
   Kolom provider (registry LLM, 25 Nov 2026): provider yang melayani
   panggilan itu — tarif selalu per (provider, model). */
db.exec(`
CREATE TABLE IF NOT EXISTS credits (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  free_balance REAL NOT NULL DEFAULT 0,
  free_expires_at INTEGER,
  purchased_balance REAL NOT NULL DEFAULT 0,
  purchased_expires_at INTEGER,
  plan_credits REAL NOT NULL DEFAULT 0,
  plan_credits_expires_at INTEGER,
  plan_credits_reset_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS credit_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  bucket TEXT,
  amount REAL NOT NULL,
  balance_after REAL NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  order_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, order_id)
);

CREATE TABLE IF NOT EXISTS credit_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model TEXT NOT NULL DEFAULT '',
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  rate_in REAL NOT NULL DEFAULT 0,
  rate_out REAL NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  credit REAL NOT NULL DEFAULT 0,
  shortfall_credit REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credit_usage_user ON credit_usage(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_credit_tx_user ON credit_transactions(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_credit_tx_free_day ON credit_transactions(user_id, bucket, kind, created_at);
`)

/* Provider per panggilan LLM (registry, 25 Nov 2026). Kolom ditambah di
   tempat supaya DB yang sudah ada tetap jalan tanpa alat migrasi. */
try {
  db.exec(`ALTER TABLE credit_usage ADD COLUMN provider TEXT NOT NULL DEFAULT ''`)
} catch {
  /* sudah ada */
}

/* ---- Credit (fase 2): order top-up QRIS + jejak webhook ----
   credit_orders: satu baris per order top-up. status: pending (menunggu
   bayar) / paid / expired (lewat masa berlaku QRIS tanpa bayar) /
   cancelled (dibatalkan pengguna; webhook lunas yang datang sesudahnya
   TIDAK dikreditkan). qr_payload = string QR EMV dari gateway (field
   qr_url) — bukan URL gambar. credit_webhook_events: jejak tiap webhook
   masuk (termasuk yang ditolak/gagal) untuk audit admin. */
db.exec(`
CREATE TABLE IF NOT EXISTS credit_orders (
  order_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  package TEXT NOT NULL,
  amount_idr INTEGER NOT NULL,
  credits REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  qr_payload TEXT,
  payment_url TEXT,
  gateway_status TEXT,
  created_at INTEGER NOT NULL,
  paid_at INTEGER,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credit_orders_user ON credit_orders(user_id, created_at);

CREATE TABLE IF NOT EXISTS credit_webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL DEFAULT '',
  event TEXT NOT NULL DEFAULT '',
  signature_valid INTEGER NOT NULL DEFAULT 0,
  result TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credit_webhook_events_order ON credit_webhook_events(order_id, created_at);
`)

/* ---- Redeem code (28 Nov 2026) ----
   redeem_codes: satu baris per kode. code_norm = kode tanpa tanda hubung/
   spasi, huruf besar (UNIQUE — pagar duplikat di level DB). allowed_user_ids
   = JSON array user_id yang boleh memakai (kosong = siapa saja).
   redeem_redemptions: satu baris per penukaran. TIDAK ada UNIQUE
   (code_id, user_id): per_user_limit bisa > 1, jadi pagarnya adalah
   hitungan di dalam transaksi (BEGIN IMMEDIATE) di redeem.ts. */
db.exec(`
CREATE TABLE IF NOT EXISTS redeem_codes (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  code_norm TEXT NOT NULL UNIQUE,
  credits REAL NOT NULL,
  max_uses INTEGER NOT NULL DEFAULT 1,
  uses INTEGER NOT NULL DEFAULT 0,
  per_user_limit INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  allowed_user_ids TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_redeem_codes_active ON redeem_codes(active, created_at);

CREATE TABLE IF NOT EXISTS redeem_redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_id TEXT NOT NULL REFERENCES redeem_codes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credits REAL NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_redeem_redemptions_code ON redeem_redemptions(code_id, created_at);
CREATE INDEX IF NOT EXISTS idx_redeem_redemptions_user ON redeem_redemptions(code_id, user_id);
`)

/* Publish state lives on the project row. The column is added in place so an
   existing database keeps working without a migration tool. */
try {
  db.exec(`ALTER TABLE projects ADD COLUMN slug TEXT`)
} catch {
  /* sudah ada */
}
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_slug ON projects(slug)`)

/* Ownership. Nullable so pre-auth projects survive; they are claimed by the
   first account that signs up, which is the only sensible migration here. */
try {
  db.exec(`ALTER TABLE projects ADD COLUMN owner_id TEXT`)
} catch {
  /* sudah ada */
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id)`)

export type Project = {
  id: string
  name: string
  prompt: string
  status: string
  starter: string
  slug: string | null
  owner_id: string | null
  created_at: number
  updated_at: number
}

export function createProject(id: string, name: string, prompt: string, ownerId: string, starter = 'blank'): Project {
  const now = Date.now()
  db.prepare(
    `INSERT INTO projects (id, name, prompt, status, owner_id, created_at, updated_at, starter) VALUES (?, ?, ?, 'idle', ?, ?, ?, ?)`,
  ).run(id, name, prompt, ownerId, now, now, starter)
  return getProject(id)!
}

export function getProject(id: string): Project | undefined {
  return db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as Project | undefined
}

export function listProjects(ownerId: string): Project[] {
  return db
    .prepare(`SELECT * FROM projects WHERE owner_id = ? ORDER BY updated_at DESC`)
    .all(ownerId) as Project[]
}

/* Projects created before accounts existed have no owner. The first person to
   sign up inherits them, otherwise they would be unreachable forever. */
export function claimOrphanProjects(ownerId: string): number {
  const r = db.prepare(`UPDATE projects SET owner_id = ? WHERE owner_id IS NULL`).run(ownerId)
  return Number(r.changes ?? 0)
}

export function userOwnsProject(projectId: string, ownerId: string): boolean {
  const row = db.prepare(`SELECT 1 AS ok FROM projects WHERE id = ? AND owner_id = ?`).get(projectId, ownerId)
  return Boolean(row)
}

/* Pengaturan per-proyek: custom domain + secret ENV (kunci disimpan dengan
   awalan secret_ agar mudah difilter saat menyuntikkan env ke preview). */
db.exec(`CREATE TABLE IF NOT EXISTS project_settings (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (project_id, key)
);`)

export function setSetting(projectId: string, key: string, value: string) {
  db.prepare(
    `INSERT INTO project_settings (project_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(project_id, key) DO UPDATE SET value = excluded.value`,
  ).run(projectId, key, value)
}

export function getSetting(projectId: string, key: string): string | undefined {
  const row = db.prepare(`SELECT value FROM project_settings WHERE project_id = ? AND key = ?`).get(projectId, key) as
    | { value: string }
    | undefined
  return row?.value
}

export function deleteSetting(projectId: string, key: string) {
  db.prepare(`DELETE FROM project_settings WHERE project_id = ? AND key = ?`).run(projectId, key)
}

export function listSettings(projectId: string): { key: string; value: string }[] {
  return db.prepare(`SELECT key, value FROM project_settings WHERE project_id = ? ORDER BY key`).all(projectId) as {
    key: string
    value: string
  }[]
}

export function projectByDomain(domain: string): Project | undefined {
  return db
    .prepare(
      `SELECT p.* FROM projects p JOIN project_settings s ON s.project_id = p.id
       WHERE s.key = 'custom_domain' AND LOWER(s.value) = LOWER(?)`,
    )
    .get(domain) as Project | undefined
}

export function setStatus(id: string, status: string) {
  db.prepare(`UPDATE projects SET status = ?, updated_at = ? WHERE id = ?`).run(status, Date.now(), id)
}

export function renameProject(id: string, name: string) {
  db.prepare(`UPDATE projects SET name = ?, updated_at = ? WHERE id = ?`).run(name, Date.now(), id)
}

export function publishProject(id: string, slug: string) {
  db.prepare(`UPDATE projects SET slug = ?, updated_at = ? WHERE id = ?`).run(slug, Date.now(), id)
}

export function unpublishProject(id: string) {
  db.prepare(`UPDATE projects SET slug = NULL, updated_at = ? WHERE id = ?`).run(Date.now(), id)
}

export function projectBySlug(slug: string): Project | undefined {
  return db.prepare(`SELECT * FROM projects WHERE slug = ?`).get(slug) as Project | undefined
}

/* Sitemap: hanya app yang benar-benar terbit (slug tidak null). */
export function listPublishedSlugs(): string[] {
  return (db.prepare(`SELECT slug FROM projects WHERE slug IS NOT NULL AND slug != '' ORDER BY slug`).all() as { slug: string }[]).map((r) => r.slug)
}

export function deleteProject(id: string) {
  /* Hapus menyeluruh: semua record yang ber-relasi dengan proyek, lalu
     record proyeknya sendiri. Dipakai endpoint DELETE /api/projects/:id
     dan pembersihan massal. Tabel tanpa FK ke projects ikut dibersihkan
     agar tidak ada data yatim. */
  const related = [
    `DELETE FROM messages WHERE project_id = ?`,
    `DELETE FROM activity_events WHERE project_id = ?`,
    `DELETE FROM files WHERE project_id = ?`,
    `DELETE FROM builds WHERE project_id = ?`,
    `DELETE FROM project_settings WHERE project_id = ?`,
    `DELETE FROM marketplace_listings WHERE project_id = ?`,
  ]
  db.exec('BEGIN')
  try {
    for (const sql of related) {
      try { db.prepare(sql).run(id) } catch { /* tabel mungkin belum ada — abaikan */ }
    }
    db.prepare(`DELETE FROM projects WHERE id = ?`).run(id)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

export type Message = { id: number; role: string; content: string; created_at: number }

export function addMessage(projectId: string, role: string, content: string): Message {
  const now = Date.now()
  const r = db
    .prepare(`INSERT INTO messages (project_id, role, content, created_at) VALUES (?, ?, ?, ?)`)
    .run(projectId, role, content, now)
  return { id: Number(r.lastInsertRowid), role, content, created_at: now }
}

export function listMessages(projectId: string): Message[] {
  return db
    .prepare(`SELECT id, role, content, created_at FROM messages WHERE project_id = ? ORDER BY id ASC`)
    .all(projectId) as Message[]
}

export type ActivityEvent = {
  id: number
  kind: string
  label: string
  action: string | null
  detail: string
  ok: number | null
  created_at: number
}

/* kind 'file': label = path file, action = write/delete/mkdir, detail kosong.
   kind 'terminal': label = judul perintah (mis. 'npm run build'),
   detail = log (dipotong pengirim), ok = 1/0. */
export function addActivityEvent(
  projectId: string,
  ev: { kind: string; label: string; action?: string | null; detail?: string; ok?: boolean | null },
): ActivityEvent {
  const now = Date.now()
  const ok = ev.ok === undefined || ev.ok === null ? null : ev.ok ? 1 : 0
  const r = db
    .prepare(
      `INSERT INTO activity_events (project_id, kind, label, action, detail, ok, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(projectId, ev.kind, ev.label, ev.action ?? null, ev.detail ?? '', ok, now)
  return {
    id: Number(r.lastInsertRowid),
    kind: ev.kind,
    label: ev.label,
    action: ev.action ?? null,
    detail: ev.detail ?? '',
    ok,
    created_at: now,
  }
}

export function listActivityEvents(projectId: string): ActivityEvent[] {
  return db
    .prepare(
      `SELECT id, kind, label, action, detail, ok, created_at FROM activity_events
       WHERE project_id = ? ORDER BY id ASC`,
    )
    .all(projectId) as ActivityEvent[]
}

export function putFile(projectId: string, path: string, content: string) {
  db.prepare(
    `INSERT INTO files (project_id, path, content, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(project_id, path) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
  ).run(projectId, path, content, Date.now())
}

export function removeFile(projectId: string, path: string) {
  db.prepare(`DELETE FROM files WHERE project_id = ? AND path = ?`).run(projectId, path)
}

export function getFile(projectId: string, path: string): string | undefined {
  const row = db
    .prepare(`SELECT content FROM files WHERE project_id = ? AND path = ?`)
    .get(projectId, path) as { content: string } | undefined
  return row?.content
}

export function listFiles(projectId: string): { path: string; updated_at: number }[] {
  return db
    .prepare(`SELECT path, updated_at FROM files WHERE project_id = ? ORDER BY path ASC`)
    .all(projectId) as { path: string; updated_at: number }[]
}

export function recordBuild(projectId: string, ok: boolean, log: string) {
  db.prepare(`INSERT INTO builds (project_id, ok, log, created_at) VALUES (?, ?, ?, ?)`).run(
    projectId,
    ok ? 1 : 0,
    log,
    Date.now(),
  )
}

export function lastBuild(projectId: string) {
  return db
    .prepare(`SELECT id, ok, log, created_at FROM builds WHERE project_id = ? ORDER BY id DESC LIMIT 1`)
    .get(projectId) as { id: number; ok: number; log: string; created_at: number } | undefined
}

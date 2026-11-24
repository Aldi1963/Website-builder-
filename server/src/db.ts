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
  slug: string | null
  owner_id: string | null
  created_at: number
  updated_at: number
}

export function createProject(id: string, name: string, prompt: string, ownerId: string): Project {
  const now = Date.now()
  db.prepare(
    `INSERT INTO projects (id, name, prompt, status, owner_id, created_at, updated_at) VALUES (?, ?, ?, 'idle', ?, ?, ?)`,
  ).run(id, name, prompt, ownerId, now, now)
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

export function deleteProject(id: string) {
  db.prepare(`DELETE FROM projects WHERE id = ?`).run(id)
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

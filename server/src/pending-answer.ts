import { db } from './db.ts'

/* Jawaban atas pertanyaan agent yang menunggu input user. Satu pertanyaan
   aktif per proyek — run baru menggantikan yang lama, run yang dijawab
   menghabiskannya. Tabel dibuat di sini supaya trek ini tidak menyentuh
   file milik trek lain. */
db.exec(`CREATE TABLE IF NOT EXISTS pending_answers (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  hint TEXT,
  created_at INTEGER NOT NULL
);`)

export type PendingAnswer = {
  projectId: string
  question: string
  hint: string | null
  createdAt: number
}

export function savePendingAnswer(projectId: string, question: string, hint?: string) {
  db.prepare(
    `INSERT INTO pending_answers (project_id, question, hint, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET question = excluded.question, hint = excluded.hint, created_at = excluded.created_at`,
  ).run(projectId, question, hint ?? null, Date.now())
}

export function getPendingAnswer(projectId: string): PendingAnswer | undefined {
  const row = db
    .prepare(`SELECT project_id, question, hint, created_at FROM pending_answers WHERE project_id = ?`)
    .get(projectId) as { project_id: string; question: string; hint: string | null; created_at: number } | undefined
  if (!row) return undefined
  return { projectId: row.project_id, question: row.question, hint: row.hint, createdAt: row.created_at }
}

export function clearPendingAnswer(projectId: string) {
  db.prepare(`DELETE FROM pending_answers WHERE project_id = ?`).run(projectId)
}

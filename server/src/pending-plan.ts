import { db } from './db.ts'

/* Rencana yang menunggu persetujuan — disimpan supaya tidak hilang bila user
   keluar sebelum menyetujui. Satu rencana per proyek: run baru menggantikan
   yang lama, run yang disetujui menghabiskannya. Tabel dibuat di sini (bukan
   di db.ts) supaya trek ini tidak menyentuh file milik trek lain. */
db.exec(`CREATE TABLE IF NOT EXISTS pending_plans (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);`)

export type PendingPlanData = {
  ringkasan: string
  langkah: { judul: string; detail: string }[]
  berkas: string[]
  asumsi: string[]
  imageIds?: string[]
}

export type PendingPlan = {
  projectId: string
  prompt: string
  plan: PendingPlanData
  createdAt: number
}

export function savePendingPlan(projectId: string, prompt: string, plan: PendingPlanData) {
  db.prepare(
    `INSERT INTO pending_plans (project_id, prompt, plan_json, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET prompt = excluded.prompt, plan_json = excluded.plan_json, created_at = excluded.created_at`,
  ).run(projectId, prompt, JSON.stringify(plan), Date.now())
}

export function getPendingPlan(projectId: string): PendingPlan | undefined {
  const row = db
    .prepare(`SELECT project_id, prompt, plan_json, created_at FROM pending_plans WHERE project_id = ?`)
    .get(projectId) as { project_id: string; prompt: string; plan_json: string; created_at: number } | undefined
  if (!row) return undefined
  try {
    const plan = JSON.parse(row.plan_json) as PendingPlanData
    if (!plan || typeof plan.ringkasan !== 'string' || !Array.isArray(plan.langkah)) return undefined
    return { projectId: row.project_id, prompt: row.prompt, plan, createdAt: row.created_at }
  } catch {
    return undefined
  }
}

export function clearPendingPlan(projectId: string) {
  db.prepare(`DELETE FROM pending_plans WHERE project_id = ?`).run(projectId)
}

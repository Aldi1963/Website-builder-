import { db } from './db.ts'

export type ChecklistItem = { text: string; done: boolean }

export type ProjectTaskState = {
  goal: string
  items: ChecklistItem[]
  updatedAt: number
}

export function getTaskState(projectId: string): ProjectTaskState | null {
  const row = db.prepare('select goal, items, updated_at from project_task_state where project_id=?').get(projectId) as any
  if (!row) return null
  try {
    return { goal: row.goal ?? '', items: JSON.parse(row.items ?? '[]'), updatedAt: row.updated_at }
  } catch { return null }
}

export function saveTaskState(projectId: string, state: ProjectTaskState) {
  db.prepare(
    `INSERT INTO project_task_state (project_id, goal, items, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET goal=excluded.goal, items=excluded.items, updated_at=excluded.updated_at`,
  ).run(projectId, state.goal, JSON.stringify(state.items.slice(0, 30)), Date.now())
}

export function clearTaskState(projectId: string) {
  db.prepare('delete from project_task_state where project_id=?').run(projectId)
}

export function taskStateBrief(projectId: string): string {
  const s = getTaskState(projectId)
  if (!s) return ''
  const done = s.items.filter((i) => i.done).length
  const lines = s.items.slice(0, 12).map((i) => `${i.done ? '✓' : '○'} ${i.text}`).join('\n')
  return `\n\nPEKERJAAN SEBELUMNYA (lintas sesi) — tujuan: ${s.goal}\nProgres: ${done}/${s.items.length} selesai\n${lines}\nLanjutkan dari yang belum ✓; jangan mengulang yang sudah selesai tanpa alasan.`
}

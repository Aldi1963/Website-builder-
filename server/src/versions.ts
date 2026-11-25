/* Version history: snapshot otomatis per giliran agent + restore.
   File-based di data/versions/<projectId>/v<N>.json supaya tidak perlu migrasi DB. */
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECTS_DIR } from './paths.ts'
import { listFiles, getFile } from './db.ts'
import { writeProjectFile } from './workspace.ts'

const EXCLUDED_DIRS = new Set(['.screenshots'])

function walkProject(dir: string, prefix = ''): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.versions' || EXCLUDED_DIRS.has(entry.name)) continue
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...walkProject(join(dir, entry.name), rel))
    else {
      try { out.push({ path: rel, content: readFileSync(join(dir, entry.name), 'utf8') }) } catch { /* skip unreadable */ }
    }
  }
  return out
}

export type VersionSnapshot = {
  id: number
  label: string
  created_at: number
  files: { path: string; content: string }[]
  prompt: string
}

function versionsDir(projectId: string) {
  return join(PROJECTS_DIR, projectId, '.versions')
}

export function snapshotVersion(projectId: string, label: string): number {
  const dir = versionsDir(projectId)
  mkdirSync(dir, { recursive: true })
  const existing = readdirSync(dir).filter((f) => f.startsWith('v') && f.endsWith('.json'))
  const id = existing.length + 1
  const projectRoot = join(PROJECTS_DIR, projectId)
  const files = walkProject(projectRoot)
  const snap: VersionSnapshot = { id, label: label.slice(0, 120), created_at: Date.now(), files, prompt: label }
  writeFileSync(join(dir, `v${id}.json`), JSON.stringify(snap), 'utf8')
  return id
}

export function listVersions(projectId: string): { id: number; label: string; created_at: number; files: number }[] {
  const dir = versionsDir(projectId)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.startsWith('v') && f.endsWith('.json'))
    .map((f) => {
      try {
        const s = JSON.parse(readFileSync(join(dir, f), 'utf8')) as VersionSnapshot
        return { id: s.id, label: s.label, created_at: s.created_at, files: s.files.length }
      } catch {
        return null
      }
    })
    .filter((x): x is { id: number; label: string; created_at: number; files: number } => x !== null)
    .sort((a, b) => b.id - a.id)
}

export function restoreVersion(projectId: string, versionId: number): { ok: boolean; restored: number } {
  const file = join(versionsDir(projectId), `v${versionId}.json`)
  if (!existsSync(file)) return { ok: false, restored: 0 }
  const snap = JSON.parse(readFileSync(file, 'utf8')) as VersionSnapshot
  let restored = 0
  for (const f of snap.files) {
    writeProjectFile(projectId, f.path, f.content)
    restored++
  }
  return { ok: true, restored }
}

export function getVersionDiff(projectId: string, versionId: number) {
  const file = join(versionsDir(projectId), `v${versionId}.json`)
  if (!existsSync(file)) return null
  const snap = JSON.parse(readFileSync(file, 'utf8')) as VersionSnapshot
  const current = new Map(listFiles(projectId).map((f) => [f.path, getFile(projectId, f.path) ?? '']))
  const then = new Map(snap.files.map((f) => [f.path, f.content]))
  const changed: { path: string; kind: 'added' | 'removed' | 'modified' }[] = []
  for (const [path, content] of then) {
    if (!current.has(path)) changed.push({ path, kind: 'removed' })
    else if (current.get(path) !== content) changed.push({ path, kind: 'modified' })
  }
  for (const path of current.keys()) if (!then.has(path)) changed.push({ path, kind: 'added' })
  return { version: snap.id, label: snap.label, created_at: snap.created_at, changed }
}

/** Unified diff sederhana (LCS) untuk satu file: before vs after. */
export function diffLines(before: string, after: string): string[] {
  const a = before.split('\n')
  const b = after.split('\n')
  const n = a.length, m = b.length
  // LCS DP (file kode biasanya < 2000 baris; batasi agar hemat memori)
  if (n * m > 4_000_000) {
    return [`--- (diff dilewati: file terlalu besar: ${n}+${m} baris)`]
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: string[] = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push(`- ${a[i]}`); i++ }
    else { out.push(`+ ${b[j]}`); j++ }
  }
  while (i < n) { out.push(`- ${a[i]}`); i++ }
  while (j < m) { out.push(`+ ${b[j]}`); j++ }
  return out
}

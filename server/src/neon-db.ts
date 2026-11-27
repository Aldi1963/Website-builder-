/**
 * Adapter Neon serverless Postgres untuk database per-project VibeBuilder.
 *
 * Aktif HANYA bila kredensial Neon tersedia di admin_settings (diisi dari panel
 * admin) atau, sebagai fallback instalasi lama, di environment. Tanpa keduanya
 * semua fungsi mengembalikan false/null sehingga managed-db.ts tetap memakai
 * Postgres lokal bawaan. Nilai rahasia tidak pernah dikembalikan API / ditulis
 * ke log; hanya string koneksi yang disuntikkan ke proses preview.
 *
 * Neon API v2:
 *   GET    /projects/{id}/branches
 *   POST   /projects/{id}/branches/{br}/roles
 *   POST   /projects/{id}/branches/{br}/databases
 *   GET    /projects/{id}/connection_uri
 *   DELETE /projects/{id}/branches/{br}/databases/{name}
 *   DELETE /projects/{id}/branches/{br}/roles/{name}
 */

import { db } from './db.ts'

const API_BASE = process.env.NEON_API_BASE ?? 'https://console.neon.tech/api/v2'
const ROLE_PREFIX = process.env.NEON_ROLE_PREFIX ?? 'vb_'

export type NeonSettings = {
  apiKey: string
  projectId: string
  branchId: string
}

/** Kredensial dibaca segar dari DB agar perubahan di panel admin langsung aktif. */
export function neonSettings(): NeonSettings {
  const read = (key: string): string => {
    try {
      const row = db.prepare(`SELECT value FROM admin_settings WHERE key = ?`).get(key) as { value: string } | undefined
      return row?.value ?? ''
    } catch {
      return ''
    }
  }
  return {
    apiKey: read('neon.api_key') || process.env.NEON_API_KEY || '',
    projectId: read('neon.project_id') || process.env.NEON_PROJECT_ID || '',
    branchId: read('neon.branch_id') || process.env.NEON_BRANCH_ID || '',
  }
}

export function isNeonConfigured(): boolean {
  const s = neonSettings()
  // Project ID tidak wajib: Neon personal API key bisa dipakai untuk mencari
  // project milik akun otomatis lewat GET /projects.
  return Boolean(s.apiKey)
}

/** Ambil daftar project milik API key (tanpa menyimpan/menampilkan key). */
export async function neonListProjects(apiKey?: string): Promise<Array<{ id: string; name: string }>> {
  const key = apiKey || neonSettings().apiKey
  if (!key) throw new Error('Neon API key belum diisi.')
  const res = await rawFetch(key, '/projects')
  const body = await res.json() as { projects?: Array<{ id: string; name: string }> }
  return (body.projects ?? []).map((p) => ({ id: p.id, name: p.name }))
}

/** Simpan project + branch hasil deteksi ke admin_settings. */
export async function neonAutoDetect(apiKey?: string): Promise<{ projectId: string; projectName: string; branchId: string }> {
  const key = apiKey || neonSettings().apiKey
  const projects = await neonListProjects(key)
  if (!projects.length) throw new Error('Tidak ada project Neon pada akun ini. Buat project di Neon Console dulu.')
  const project = projects[0]
  let branchId = neonSettings().branchId
  if (!branchId) {
    try {
      const res = await rawFetch(key, `/projects/${encodeURIComponent(project.id)}/branches`)
      const body = await res.json() as { branches?: Array<{ id: string; primary?: boolean; default?: boolean }> }
      branchId = body.branches?.find((b) => b.primary || b.default)?.id ?? body.branches?.[0]?.id ?? ''
    } catch { /* branch akan dicari lagi saat provisioning */ }
  }
  const write = (k: string, v: string) => {
    if (!v) return
    db.prepare(`INSERT INTO admin_settings (key, value, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(k, v, Date.now())
  }
  write('neon.project_id', project.id)
  write('neon.branch_id', branchId)
  cachedBranch = null
  return { projectId: project.id, projectName: project.name, branchId }
}

async function rawFetch(apiKey: string, path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${API_BASE.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...(init.headers ?? {}),
    },
  })
  if (!res.ok) throw new Error(`Neon API ${res.status} pada ${path.split('?')[0]}`)
  return res
}

function apiPath(settings: NeonSettings, path: string): string {
  return `${API_BASE.replace(/\/$/, '')}/projects/${encodeURIComponent(settings.projectId)}${path}`
}

async function neonFetch(settings: NeonSettings, path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(apiPath(settings, path), {
    ...init,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`,
      ...(init.headers ?? {}),
    },
  })
  if (!res.ok) {
    // Jangan sertakan body respons: bisa mengandung connection string.
    throw new Error(`Neon API ${res.status} pada ${path.split('?')[0]}`)
  }
  return res
}

function safeName(projectId: string): string {
  return projectId.replace(/[^a-z0-9_]/gi, '').toLowerCase().slice(0, 32)
}

export function neonNames(projectId: string): { role: string; database: string } {
  const suffix = safeName(projectId)
  return { role: `${ROLE_PREFIX}${suffix}`, database: `${ROLE_PREFIX}${suffix}` }
}

let cachedBranch: { settingsKey: string; branchId: string } | null = null
async function defaultBranchId(settings: NeonSettings): Promise<string> {
  const key = `${settings.projectId}:${settings.branchId}`
  if (cachedBranch?.settingsKey === key) return cachedBranch.branchId
  if (settings.branchId) {
    cachedBranch = { settingsKey: key, branchId: settings.branchId }
    return settings.branchId
  }
  const res = await neonFetch(settings, '/branches')
  const body = await res.json() as { branches?: Array<{ id: string; primary?: boolean; default?: boolean }> }
  const branch = body.branches?.find((b) => b.primary || b.default) ?? body.branches?.[0]
  if (!branch) throw new Error('Neon: tidak ada branch pada project ini.')
  cachedBranch = { settingsKey: key, branchId: branch.id }
  return branch.id
}

/** Pastikan role + database Neon ada; kembalikan kredensial project. */
export async function neonProvision(projectId: string): Promise<{ role: string; database: string; password: string }> {
  let settings = neonSettings()
  if (!settings.projectId) {
    await neonAutoDetect(settings.apiKey)
    settings = neonSettings()
  }
  db.prepare(`CREATE TABLE IF NOT EXISTS project_databases (project_id TEXT PRIMARY KEY, role TEXT, database TEXT, password TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`).run()
  const { role, database } = neonNames(projectId)
  const saved = db.prepare(`SELECT role, database, password FROM project_databases WHERE project_id = ?`).get(projectId) as
    | { role: string; database: string; password: string }
    | undefined

  const branch = await defaultBranchId(settings)
  let password = saved?.password ?? ''

  const rolesRes = await neonFetch(settings, `/branches/${encodeURIComponent(branch)}/roles`)
  const rolesBody = await rolesRes.json() as { roles?: Array<{ name: string }> }
  const roleExists = rolesBody.roles?.some((r) => r.name === role) ?? false

  if (!roleExists || !password) {
    const path = roleExists
      ? `/branches/${encodeURIComponent(branch)}/roles/${encodeURIComponent(role)}/reset_password`
      : `/branches/${encodeURIComponent(branch)}/roles`
    const res = await neonFetch(settings, path, roleExists ? { method: 'POST' } : {
      method: 'POST',
      body: JSON.stringify({ role: { name: role } }),
    })
    const body = await res.json() as { role?: { password?: string }; password?: string }
    const fresh = body.role?.password ?? body.password
    if (!fresh) throw new Error('Neon: password role tidak dikembalikan API.')
    password = fresh
  }

  const dbRes = await neonFetch(settings, `/branches/${encodeURIComponent(branch)}/databases`)
  const dbBody = await dbRes.json() as { databases?: Array<{ name: string; owner_name: string }> }
  const dbRow = dbBody.databases?.find((d) => d.name === database)
  if (!dbRow) {
    await neonFetch(settings, `/branches/${encodeURIComponent(branch)}/databases`, {
      method: 'POST',
      body: JSON.stringify({ database: { name: database, owner_name: role } }),
    })
  } else if (dbRow.owner_name !== role) {
    throw new Error(`Neon: database ${database} dimiliki role lain (${dbRow.owner_name}).`)
  }

  db.prepare(`CREATE TABLE IF NOT EXISTS project_databases (project_id TEXT PRIMARY KEY, role TEXT, database TEXT, password TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`).run()
  db.prepare(`INSERT INTO project_databases (project_id, role, database, password) VALUES (?,?,?,?)
              ON CONFLICT(project_id) DO UPDATE SET role=excluded.role, database=excluded.database, password=excluded.password`)
    .run(projectId, role, database, password)

  return { role, database, password }
}

/** Connection string Neon(project) dengan password role terbaru. */
export async function neonConnectionUrl(projectId: string): Promise<string | null> {
  if (!isNeonConfigured()) return null
  try {
    const settings = neonSettings()
    const { role, database, password } = await neonProvision(projectId)
    const params = new URLSearchParams({ database_name: database, role_name: role, pooled: 'true' })
    const res = await neonFetch(settings, `/connection_uri?${params.toString()}`)
    const body = await res.json() as { uri?: string }
    if (!body.uri) throw new Error('Neon: connection_uri kosong.')
    const url = new URL(body.uri)
    url.password = password
    if (!url.searchParams.has('sslmode')) url.searchParams.set('sslmode', 'require')
    return url.toString()
  } catch {
    return null
  }
}

export async function neonDropProject(projectId: string): Promise<{ ok: boolean; error?: string }> {
  if (!isNeonConfigured()) return { ok: false, error: 'Neon belum dikonfigurasi.' }
  try {
    let settings = neonSettings()
    if (!settings.projectId) {
      await neonAutoDetect(settings.apiKey)
      settings = neonSettings()
    }
    const { role, database } = neonNames(projectId)
    const branch = await defaultBranchId(settings)
    await neonFetch(settings, `/branches/${encodeURIComponent(branch)}/databases/${encodeURIComponent(database)}`, { method: 'DELETE' })
    await neonFetch(settings, `/branches/${encodeURIComponent(branch)}/roles/${encodeURIComponent(role)}`, { method: 'DELETE' }).catch(() => {})
    db.prepare(`CREATE TABLE IF NOT EXISTS project_databases (project_id TEXT PRIMARY KEY, role TEXT, database TEXT, password TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`).run()
    db.prepare(`DELETE FROM project_databases WHERE project_id = ?`).run(projectId)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export function _resetNeonCacheForTests(): void {
  cachedBranch = null
}

export type Project = {
  id: string
  name: string
  prompt: string
  status: string
  starter?: string
  slug: string | null
  created_at: number
  updated_at: number
}

export type Message = {
  id: number
  role: 'user' | 'assistant' | string
  content: string
  created_at: number
}

export type FileEntry = { path: string; updated_at: number }

export type PendingPlan = {
  prompt: string
  plan: { ringkasan: string; langkah: PlanStep[]; berkas: string[]; asumsi: string[] }
  createdAt: number
}

export type PlanStep = { judul: string; detail: string }
export type AuditFinding = { tingkat: string; kategori: string; berkas: string; baris: number; masalah: string; perbaikan: string }
export type AgentEvent =
  | { type: 'status'; text: string }
  | { type: 'plan'; ringkasan: string; langkah: PlanStep[]; berkas: string[]; asumsi: string[] }
  | { type: 'audit'; nilai: number; temuan: AuditFinding[]; catatan: string }
  | { type: 'file'; path: string; action: 'write' | 'delete' | 'mkdir' }
  | { type: 'build'; ok: boolean; log: string }
  | { type: 'install'; ok: boolean; log: string }
  | { type: 'assistant'; text: string }
  | { type: 'screenshot'; url: string; name: string }
  | { type: 'awaiting_confirmation'; ringkasan: string }
  | { type: 'error'; text: string }

export type User = { id: string; email: string; name: string; created_at: number }

const BASE = ''

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    let msg = text
    try {
      const parsed = JSON.parse(text) as { error?: string }
      if (parsed?.error) msg = parsed.error
    } catch {
      /* bukan JSON, pakai teks mentah */
    }
    const err = new Error(msg || `Permintaan gagal (${res.status}).`) as Error & { status?: number }
    err.status = res.status
    throw err
  }
  return (await res.json()) as T
}

export const auth = {
  me: () => req<{ user: User | null; signupOpen: boolean }>('/api/auth/me'),
  login: (email: string, password: string, remember = true) =>
    req<{ ok: boolean; user: User }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password, remember }),
    }),
  forgotPassword: (email: string) =>
    req<{ ok: boolean; message: string }>('/api/auth/forgot', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  resetPassword: (token: string, password: string) =>
    req<{ ok: boolean; message: string }>('/api/auth/reset', {
      method: 'POST',
      body: JSON.stringify({ token, password }),
    }),
  signup: (email: string, name: string, password: string) =>
    req<{ ok: boolean; user: User }>('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ email, name, password }),
    }),
  logout: () => req<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
}

export const api = {
  health: () => req<{ ok: boolean; model: string; uptime: number }>('/api/health'),
  listProjects: () => req<{ projects: Project[] }>('/api/projects'),
  createProject: (name: string, prompt = '', starter: 'blank' | 'lms' | 'tiket' = 'blank') =>
    req<{ project: Project }>('/api/projects', { method: 'POST', body: JSON.stringify({ name, prompt, starter }) }),
  getProject: (id: string) =>
    req<{ project: Project; messages: Message[]; files: FileEntry[]; previewPort: number; pendingPlan: PendingPlan | null }>(`/api/projects/${id}`),
  renameProject: (id: string, name: string) =>
    req<{ project: Project }>(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  deleteProject: (id: string) => req<{ ok: boolean }>(`/api/projects/${id}`, { method: 'DELETE' }),
  cancelPendingPlan: (id: string) => req<{ ok: boolean }>(`/api/projects/${id}/pending-plan`, { method: 'DELETE' }),
  files: (id: string) => req<{ files: FileEntry[] }>(`/api/projects/${id}/files`),
  file: (id: string, path: string) =>
    req<{ path: string; content: string }>(`/api/projects/${id}/file?path=${encodeURIComponent(path)}`),
  database: (id: string) =>
    req<{ managed: boolean; engine?: string; database?: string; tables: DbTable[]; error?: string; note?: string }>(
      `/api/projects/${id}/database`,
    ),
  dbQuery: (id: string, sql: string, limit = 100) =>
    req<{ ok: boolean; columns?: string[]; rows?: Record<string, unknown>[]; rowCount?: number; truncated?: boolean; error?: string }>(
      `/api/projects/${id}/database/query`,
      { method: 'POST', body: JSON.stringify({ sql, limit }) },
    ),
  databaseTable: (id: string, name: string, search = '', page = 0, perPage = 25) =>
    req<{ ok: boolean; table?: string; page?: number; perPage?: number; total?: number; pageCount?: number;
      columns?: Array<{ name: string; type: string; nullable: boolean; default: string | null }>;
      rows?: Record<string, unknown>[]; error?: string }>(
      `/api/projects/${id}/database/table?name=${encodeURIComponent(name)}&search=${encodeURIComponent(search)}&page=${page}&perPage=${perPage}`,
    ),
  databaseExport: (id: string) =>
    req<{ ok: boolean; sql?: string; tables?: number; error?: string }>(
      `/api/projects/${id}/database/export`,
    ),
  saveFile: (id: string, path: string, content: string) =>
    req<{ ok: boolean; path: string }>(`/api/projects/${id}/file`, {
      method: 'PUT',
      body: JSON.stringify({ path, content }),
    }),
  build: (id: string) =>
    req<{ ok: boolean; log: string }>(`/api/projects/${id}/build`, { method: 'POST' }),
  preview: (id: string) =>
    req<{ ok: boolean; port: number; url: string }>(`/api/projects/${id}/preview`, { method: 'POST' }),
  previewStatus: (id: string) =>
    req<{ running: boolean; port: number }>(`/api/projects/${id}/preview/status`),
  publish: (id: string, slug?: string) =>
    req<{ ok: boolean; slug: string; url: string; port: number; error?: string }>(
      `/api/projects/${id}/publish`,
      { method: 'POST', body: JSON.stringify({ slug }) },
    ),
  unpublish: (id: string) => req<{ ok: boolean }>(`/api/projects/${id}/publish`, { method: 'DELETE' }),
  discovery: (prompt: string) =>
    req<{ ready: boolean; questions: string[]; assumptions: string[] }>('/api/discovery', {
      method: 'POST',
      body: JSON.stringify({ prompt }),
    }),
  /* Daftar model LLM yang boleh dipakai (publik, tanpa auth). Dipakai
     picker model — lihat platform/src/models.ts untuk cache + fallback. */
  llmModels: () => req<{ models: import('./models').PublicModel[] }>('/api/llm/models'),
  screenshot: (id: string) =>
    req<{ ok: boolean; screenshot: { name: string; url: string; created_at: number; bytes: number } }>(`/api/projects/${id}/screenshots`, { method: 'POST' }),
  screenshots: (id: string) =>
    req<{ screenshots: { name: string; url: string; created_at: number; bytes: number }[] }>(`/api/projects/${id}/screenshots`),
  settings: (id: string) => req<ProjectSettings>(`/api/projects/${id}/settings`),
  setDomain: (id: string, domain: string) =>
    req<{ ok: boolean; customDomain: string }>(`/api/projects/${id}/domain`, {
      method: 'PUT',
      body: JSON.stringify({ domain }),
    }),
  setSecret: (id: string, key: string, value: string) =>
    req<{ ok: boolean; key: string }>(`/api/projects/${id}/secrets`, {
      method: 'PUT',
      body: JSON.stringify({ key, value }),
    }),
  deleteSecret: (id: string, key: string) =>
    req<{ ok: boolean }>(`/api/projects/${id}/secrets/${encodeURIComponent(key)}`, { method: 'DELETE' }),
  setGithub: (id: string, repo: string, token: string, branch: string) =>
    req<{ ok: boolean; repo: string; branch: string; tokenSaved: boolean }>(`/api/projects/${id}/github`, {
      method: 'PUT',
      body: JSON.stringify({ repo, token, branch }),
    }),
  syncGithub: (id: string, repo: string, branch: string, token: string) =>
    req<{ ok: boolean; repo: string; branch: string; pushed: number; skipped: number; error?: string; commitUrl?: string }>(
      `/api/projects/${id}/github/sync`,
      {
        method: 'POST',
        body: JSON.stringify({ repo, branch, token }),
      },
    ),
  marketplace: (category?: string) =>
    req<{ listings: MarketplaceListing[]; categories: string[] }>(
      `/api/marketplace${category ? `?category=${encodeURIComponent(category)}` : ''}`,
    ),
  publishToMarketplace: (id: string, title: string, description: string, category: string) =>
    req<{ ok: boolean; listing: MarketplaceListing }>(`/api/projects/${id}/marketplace`, {
      method: 'PUT',
      body: JSON.stringify({ title, description, category }),
    }),
  unpublishFromMarketplace: (id: string) =>
    req<{ ok: boolean }>(`/api/projects/${id}/marketplace`, { method: 'DELETE' }),
  forkListing: (listingId: number) =>
    req<{ ok: boolean; projectId: string; name: string }>(`/api/marketplace/${listingId}/fork`, { method: 'POST' }),
  usage: () => req<{ requests: number; promptTokens: number; completionTokens: number }>('/api/usage'),
}

export type ProjectSettings = {
  customDomain: string
  secrets: { key: string; hint: string }[]
  overview: { name: string; status: string; slug: string | null; files: number; createdAt: number }
}

/* Satu tabel di database Postgres terkelola proyek (dipakai panel Database). */
export type DbTable = {
  name: string
  columns: string[]
  rows: Record<string, string | number | boolean>[]
  note?: string
}

export type MarketplaceListing = {
  id: number
  project_id: string
  title: string
  description: string
  category: string
  owner_id: string | null
  fork_count: number
  created_at: number
}

export type ChatHandlers = {
  onStatus?: (text: string) => void
  onPlan?: (event: Extract<AgentEvent, { type: 'plan' }>) => void
  onAudit?: (event: Extract<AgentEvent, { type: 'audit' }>) => void
  onFile?: (path: string, action: 'write' | 'delete' | 'mkdir') => void
  onBuild?: (ok: boolean, log: string) => void
  onInstall?: (ok: boolean, log: string) => void
  onAssistantDelta?: (text: string) => void
  onAssistant?: (text: string) => void
  onScreenshot?: (url: string, name: string) => void
  onAwaitingConfirmation?: (ringkasan: string) => void
  onError?: (text: string) => void
  onPublished?: (slug: string, url: string) => void
  onDone?: () => void
}

/** Unduh seluruh file proyek sebagai ZIP. */
export async function exportProjectZip(projectId: string): Promise<void> {
  const res = await fetch(`/api/projects/${projectId}/export`)
  if (!res.ok) {
    let msg = `Gagal mengekspor (${res.status}).`
    try {
      const parsed = (await res.json()) as { error?: string }
      if (parsed?.error) msg = parsed.error
    } catch { /* bukan JSON */ }
    throw new Error(msg)
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'proyek.zip'
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export async function chatStream(
  projectId: string,
  message: string,
  h: ChatHandlers,
  signal?: AbortSignal,
  opts?: { model?: string; planMode?: boolean; confirmPlan?: boolean; confirmed?: boolean },
) {
  const res = await fetch(`/api/projects/${projectId}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, model: opts?.model, planMode: opts?.planMode, confirmPlan: opts?.confirmPlan, confirmed: opts?.confirmed }),
    signal,
  })
  if (!res.ok || !res.body) throw new Error(`chat gagal: ${res.status}`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const chunks = buffer.split('\n\n')
    buffer = chunks.pop() ?? ''

    for (const chunk of chunks) {
      const eventLine = chunk.split('\n').find((l) => l.startsWith('event:'))
      const dataLine = chunk.split('\n').find((l) => l.startsWith('data:'))
      if (!eventLine || !dataLine) continue
      const event = eventLine.slice(6).trim()
      let payload: any
      try {
        payload = JSON.parse(dataLine.slice(5).trim())
      } catch {
        continue
      }
      if (event === 'status') h.onStatus?.(payload.text)
      else if (event === 'plan') h.onPlan?.(payload)
      else if (event === 'audit') h.onAudit?.(payload)
      else if (event === 'file') h.onFile?.(payload.path, payload.action)
      else if (event === 'build') h.onBuild?.(payload.ok, payload.log)
      else if (event === 'install') h.onInstall?.(payload.ok, payload.log)
      else if (event === 'assistant_delta') h.onAssistantDelta?.(payload.text)
      else if (event === 'assistant') h.onAssistant?.(payload.text)
      else if (event === 'screenshot') h.onScreenshot?.(payload.url, payload.name)
      else if (event === 'awaiting_confirmation') h.onAwaitingConfirmation?.(payload.ringkasan)
      else if (event === 'published') h.onPublished?.(payload.slug, payload.url)
      else if (event === 'error') h.onError?.(payload.text)
      else if (event === 'done') h.onDone?.()
    }
  }
}

export function formatTime(ts: number) {
  const d = new Date(ts)
  return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
}

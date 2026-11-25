export type Project = {
  id: string
  name: string
  prompt: string
  status: string
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

export type PlanStep = { judul: string; detail: string }
export type AuditFinding = { tingkat: string; kategori: string; berkas: string; baris: number; masalah: string; perbaikan: string }
export type AgentEvent =
  | { type: 'status'; text: string }
  | { type: 'plan'; ringkasan: string; langkah: PlanStep[]; berkas: string[]; asumsi: string[] }
  | { type: 'audit'; nilai: number; temuan: AuditFinding[]; catatan: string }
  | { type: 'file'; path: string; action: 'write' | 'delete' }
  | { type: 'build'; ok: boolean; log: string }
  | { type: 'assistant'; text: string }
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
  login: (email: string, password: string) =>
    req<{ ok: boolean; user: User }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
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
  createProject: (name: string, prompt = '') =>
    req<{ project: Project }>('/api/projects', { method: 'POST', body: JSON.stringify({ name, prompt }) }),
  getProject: (id: string) =>
    req<{ project: Project; messages: Message[]; files: FileEntry[]; previewPort: number }>(`/api/projects/${id}`),
  renameProject: (id: string, name: string) =>
    req<{ project: Project }>(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  deleteProject: (id: string) => req<{ ok: boolean }>(`/api/projects/${id}`, { method: 'DELETE' }),
  files: (id: string) => req<{ files: FileEntry[] }>(`/api/projects/${id}/files`),
  file: (id: string, path: string) =>
    req<{ path: string; content: string }>(`/api/projects/${id}/file?path=${encodeURIComponent(path)}`),
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
}

export type ChatHandlers = {
  onStatus?: (text: string) => void
  onPlan?: (event: Extract<AgentEvent, { type: 'plan' }>) => void
  onAudit?: (event: Extract<AgentEvent, { type: 'audit' }>) => void
  onFile?: (path: string, action: 'write' | 'delete') => void
  onBuild?: (ok: boolean, log: string) => void
  onAssistantDelta?: (text: string) => void
  onAssistant?: (text: string) => void
  onError?: (text: string) => void
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

export async function chatStream(projectId: string, message: string, h: ChatHandlers, signal?: AbortSignal) {
  const res = await fetch(`/api/projects/${projectId}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message }),
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
      else if (event === 'assistant_delta') h.onAssistantDelta?.(payload.text)
      else if (event === 'assistant') h.onAssistant?.(payload.text)
      else if (event === 'error') h.onError?.(payload.text)
      else if (event === 'done') h.onDone?.()
    }
  }
}

export function formatTime(ts: number) {
  const d = new Date(ts)
  return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
}

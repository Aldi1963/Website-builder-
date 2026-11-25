import { BASE_SYSTEM } from './prompts.ts'
import { db } from './db.ts'

export type ChatMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string; tool_calls?: ToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string; name?: string }

export type ToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

const ENDPOINT = process.env.VB_LLM_URL ?? 'http://127.0.0.1:20128/v1/chat/completions'
const API_KEY = process.env.VB_LLM_KEY ?? process.env.HERMES_9ROUTER_API_KEY ?? ''

/* Diekspos hanya sebagai info (host + apakah key terpasang), bukan nilainya. */
export const LLM_ENDPOINT = ENDPOINT
export const LLM_KEY_CONFIGURED = API_KEY.length > 0

export const FAST_MODEL = process.env.VB_MODEL ?? 'cx/gpt-5.6-luna'
export const STRONG_MODEL = process.env.VB_MODEL_STRONG ?? FAST_MODEL
export const AUDIT_MODEL = process.env.VB_MODEL_AUDIT ?? 'cx/gpt-5.6-luna-review'

/* ---- Konfigurasi AI efektif: override database (diatur dari panel admin)
   mengalahkan environment, environment mengalahkan default bawaan. ---- */
export function adminSetting(key: string): string | undefined {
  try {
    const row = db.prepare('SELECT value FROM admin_settings WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value
  } catch {
    return undefined
  }
}

export function effectiveModel(): string { return adminSetting('llm.model') ?? FAST_MODEL }
export function effectiveStrongModel(): string { return adminSetting('llm.model_strong') ?? STRONG_MODEL }
export function effectiveAuditModel(): string { return adminSetting('llm.model_audit') ?? AUDIT_MODEL }
export function effectiveEndpoint(): string { return adminSetting('llm.url') ?? ENDPOINT }
export function effectiveKey(): string { return adminSetting('llm.key') ?? API_KEY }
export function effectiveKeyConfigured(): boolean { return effectiveKey().length > 0 }

/* Pemakaian gateway sejak proses server start — ditampilkan di chip Token. */
export const llmUsage = { requests: 0, promptTokens: 0, completionTokens: 0 }

function trackUsage(u: unknown) {
  const o = u as { prompt_tokens?: number; completion_tokens?: number } | undefined
  if (!o || typeof o !== 'object') return
  llmUsage.requests += 1
  llmUsage.promptTokens += Number(o.prompt_tokens ?? 0)
  llmUsage.completionTokens += Number(o.completion_tokens ?? 0)
}

/* Pencatatan token per pengguna (dipakai panel admin Plan/Usage).
   Gagal catat tidak boleh menggagalkan chat. */
function recordTokenUsage(userId: string, model: string, u: unknown) {
  const o = u as { prompt_tokens?: number; completion_tokens?: number } | undefined
  if (!o || typeof o !== 'object') return
  try {
    db.prepare(
      'INSERT INTO token_usage (user_id, model, prompt_tokens, completion_tokens, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(userId, model, Number(o.prompt_tokens ?? 0), Number(o.completion_tokens ?? 0), Date.now())
  } catch { /* abaikan */ }
}

type Choice = { message?: ChatMessage & { role: 'assistant' }; delta?: Partial<ChatMessage> & { role?: string } }

/**
 * Sebagian upstream mengabaikan `stream:false` dan membalas SSE. Gabungkan delta
 * chunk jadi satu message utuh agar jalur non-stream dan stream punya satu bentuk.
 */
function parseSse(raw: string, noteUsage: (u: unknown) => void = trackUsage): { choices: Choice[]; usage?: unknown } {
  let content = ''
  const calls: ToolCall[] = []
  const byIndex = new Map<number, ToolCall>()
  let usage: unknown

  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    let chunk: any
    try {
      chunk = JSON.parse(payload)
    } catch {
      continue
    }
    if (chunk.usage) { usage = chunk.usage; noteUsage(chunk.usage) }
    const d = chunk.choices?.[0]?.delta
    if (!d) continue
    if (typeof d.content === 'string') content += d.content
    for (const tc of d.tool_calls ?? []) {
      const idx = tc.index ?? 0
      const cur = byIndex.get(idx) ?? {
        id: tc.id ?? `call_${idx}`,
        type: 'function' as const,
        function: { name: '', arguments: '' },
      }
      if (tc.id) cur.id = tc.id
      if (tc.function?.name) cur.function.name = tc.function.name
      if (tc.function?.arguments) cur.function.arguments += tc.function.arguments
      byIndex.set(idx, cur)
    }
  }

  for (const tc of [...byIndex.values()].sort((a, b) => 0)) if (tc.function.name) calls.push(tc)
  const message: any = { role: 'assistant', content }
  if (calls.length) message.tool_calls = calls
  return { choices: [{ message }], usage }
}

export async function complete(
  messages: ChatMessage[],
  opts: { model?: string; tools?: unknown[]; temperature?: number; maxTokens?: number; onDelta?: (text: string) => void | Promise<void>; userId?: string } = {},
): Promise<{ message: ChatMessage & { role: 'assistant' }; usage?: unknown }> {
  /* Konfigurasi diselesaikan per panggilan supaya perubahan dari panel admin
     berlaku tanpa restart server. */
  const endpoint = effectiveEndpoint()
  const apiKey = effectiveKey()
  const model = opts.model ?? effectiveModel()
  const noteUsage = (u: unknown) => {
    trackUsage(u)
    if (opts.userId) recordTokenUsage(opts.userId, model, u)
  }
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.maxTokens ?? 8192,
    stream: Boolean(opts.onDelta),
  }
  if (opts.tools?.length) {
    body.tools = opts.tools
    body.tool_choice = 'auto'
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`LLM ${res.status}: ${text.slice(0, 400)}`)
  }

  if (!res.body) throw new Error('LLM response tanpa body')
  const contentType = res.headers.get('content-type') ?? ''
  const looksStream = contentType.includes('text/event-stream')

  // Streaming: teruskan setiap delta teks ke onDelta sambil menampung hasil utuh.
  if (looksStream && opts.onDelta) {
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let full = ''
    const toolBuf = new Map<number, ToolCall>()
    let usage: unknown
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n')
      buffer = parts.pop() ?? ''
      for (const line of parts) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        let chunk: any
        try { chunk = JSON.parse(payload) } catch { continue }
        if (chunk.usage) { usage = chunk.usage; noteUsage(chunk.usage) }
        const d = chunk.choices?.[0]?.delta
        if (!d) continue
        if (typeof d.content === 'string' && d.content) {
          full += d.content
          await opts.onDelta(d.content)
        }
        for (const tc of d.tool_calls ?? []) {
          const idx = tc.index ?? 0
          const cur = toolBuf.get(idx) ?? { id: tc.id ?? `call_${idx}`, type: 'function' as const, function: { name: '', arguments: '' } }
          if (tc.id) cur.id = tc.id
          if (tc.function?.name) cur.function.name = tc.function.name
          if (tc.function?.arguments) cur.function.arguments += tc.function.arguments
          toolBuf.set(idx, cur)
        }
      }
    }
    const calls = [...toolBuf.values()].filter((t) => t.function.name)
    const message: any = { role: 'assistant', content: full }
    if (calls.length) message.tool_calls = calls
    if (!full && !calls.length) throw new Error('LLM stream mengembalikan konten kosong')
    return { message, usage }
  }

  // Non-stream (atau delta tanpa onDelta): kumpulkan semuanya lalu kembalikan sekali.
  const raw = await res.text()
  let json: { choices?: Choice[]; usage?: unknown }
  if (raw.trimStart().startsWith('data:')) {
    json = parseSse(raw, noteUsage)
  } else {
    try {
      json = JSON.parse(raw)
    } catch {
      json = parseSse(raw, noteUsage)
    }
  }

  const message = json.choices?.[0]?.message
  if (!message) throw new Error(`LLM response tanpa message: ${raw.slice(0, 200)}`)
  if (json.usage) noteUsage(json.usage)
  if (typeof message.content !== 'string' && !message.tool_calls?.length) {
    const finish = (json.choices?.[0] as any)?.finish_reason ?? 'unknown'
    throw new Error(`LLM mengembalikan konten kosong (finish_reason=${finish}); coba model lain atau naikkan max_tokens.`)
  }
  return { message, usage: json.usage }
}

export async function completeText(prompt: string, model = FAST_MODEL, system = BASE_SYSTEM, userId?: string) {
  const { message } = await complete(
    [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
    { model, userId },
  )
  return typeof message.content === 'string' ? message.content : ''
}

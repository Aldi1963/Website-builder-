import { BASE_SYSTEM } from './prompts.ts'

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

export const FAST_MODEL = process.env.VB_MODEL ?? 'cx/gpt-5.6-luna'
export const STRONG_MODEL = process.env.VB_MODEL_STRONG ?? FAST_MODEL

type Choice = { message?: ChatMessage & { role: 'assistant' }; delta?: Partial<ChatMessage> & { role?: string } }

/**
 * Sebagian upstream mengabaikan `stream:false` dan membalas SSE. Gabungkan delta
 * chunk jadi satu message utuh agar jalur non-stream dan stream punya satu bentuk.
 */
function parseSse(raw: string): { choices: Choice[]; usage?: unknown } {
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
    if (chunk.usage) usage = chunk.usage
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
  opts: { model?: string; tools?: unknown[]; temperature?: number; maxTokens?: number } = {},
): Promise<{ message: ChatMessage & { role: 'assistant' }; usage?: unknown }> {
  const body: Record<string, unknown> = {
    model: opts.model ?? FAST_MODEL,
    messages,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.maxTokens ?? 8192,
    stream: false,
  }
  if (opts.tools?.length) {
    body.tools = opts.tools
    body.tool_choice = 'auto'
  }

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...(API_KEY ? { authorization: `Bearer ${API_KEY}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`LLM ${res.status}: ${text.slice(0, 400)}`)
  }

  const raw = await res.text()
  let json: { choices?: Choice[]; usage?: unknown }
  if (raw.trimStart().startsWith('data:')) {
    json = parseSse(raw)
  } else {
    try {
      json = JSON.parse(raw)
    } catch {
      json = parseSse(raw)
    }
  }

  const message = json.choices?.[0]?.message
  if (!message) throw new Error(`LLM response tanpa message: ${raw.slice(0, 200)}`)
  if (typeof message.content !== 'string' && !message.tool_calls?.length) {
    const finish = json.choices?.[0]?.finish_reason ?? json.choices?.[0]?.delta?.reasoning_details?.length ? 'reasoning' : 'unknown'
    throw new Error(`LLM mengembalikan konten kosong (finish_reason=${finish}); coba model lain atau naikkan max_tokens.`)
  }
  return { message, usage: json.usage }
}

export async function completeText(prompt: string, model = FAST_MODEL, system = BASE_SYSTEM) {
  const { message } = await complete(
    [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
    { model },
  )
  return typeof message.content === 'string' ? message.content : ''
}

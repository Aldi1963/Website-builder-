import { BASE_SYSTEM } from './prompts.ts'
import { db } from './db.ts'
import { userById } from './auth.ts'
import { checkCallRate, checkDailyCap, deduct, getBalance, minBalanceToCall, type UsageInput } from './credits.ts'
import { resolveProviderModel, withGaterLimits, type ResolvedModel } from './providers.ts'

/* Content bisa berupa string biasa ATAU array part multimodal (text + image_url)
   untuk model vision. Loop self-healing mengirim screenshot preview lewat bentuk
   array ini; upstream OpenAI-compatible menerima {type:'image_url', image_url:{url}}
   di mana url bisa data-URL base64. Message tool tetap string (tak mendukung gambar). */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export type ChatMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string | ContentPart[]; tool_calls?: ToolCall[] }
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
   Gagal catat tidak boleh menggagalkan chat. User yang tidak ada
   (akun dihapus) tidak dicatat — token_usage sudah punya 2 user_id
   yatim dari sebelum guard ini, jangan tambah lagi. */
function recordTokenUsage(userId: string, model: string, u: unknown) {
  const o = u as { prompt_tokens?: number; completion_tokens?: number } | undefined
  if (!o || typeof o !== 'object') return
  try {
    if (!userById(userId)) {
      console.error(`[llm] token_usage dilewati: user ${userId} tidak ada`)
      return
    }
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

/* ---- Gate + metering credit (fase 1, ditambah anti-abuse fase 5) ----
   Panggilan DENGAN userId (chat builder + review): saldo dicek SEBELUM
   fetch (minimal 10 credit), lalu cap harian total (CREDIT_LIMIT_HARIAN)
   dan batas laju panggilan/jam (CREDIT_LIMIT_PANGGILAN_JAM); maks. 1 run
   bersamaan per pengguna (CREDIT_RUN_BERSAMAAN); review maks. 1× per run
   bila pemanggil meneruskan runId + kind 'review'. Usage final dipotong
   tepat sekali sesudah respons — juga saat LLM error setelah usage
   sebagian diterima. Panggilan TANPA userId (mis. /api/discovery): tanpa
   gate, tanpa potong (biaya sistem, ditanggung owner). noteUsage bisa
   terpanggil berkali-kali (tiap chunk SSE yang membawa usage); yang dipakai
   hanya usage TERAKHIR (= total final dari upstream), dan deduct()
   dipanggil tepat sekali. */
export function creditHabisError(balance: number): Error {
  const err = new Error(
    `Credit habis — saldo ${balance.toFixed(1)} credit, minimal ${minBalanceToCall()} credit untuk memakai AI. Top up credit untuk melanjutkan.`,
  )
  ;(err as Error & { code: string }).code = 'CREDIT_HABIS'
  return err
}

/* ---- Anti-abuse fase 5: 1 run bersamaan per pengguna ----
   Panggilan dalam satu run bersifat berurutan (agent menunggu tiap
   complete() sebelum memanggil lagi), jadi penjaga ini hanya menolak run
   KEDUA yang tumpang tindih — mis. pengguna membuka dua chat dan
   mengirim bersamaan. Tanpa userId (discovery, tes admin) tidak dijaga. */
const activeRuns = new Set<string>()

export function concurrentRunError(): Error {
  const err = new Error(
    'Masih ada proses AI yang berjalan untuk akun ini — tunggu sampai selesai, lalu coba lagi.',
  )
  ;(err as Error & { code: string }).code = 'CREDIT_RUN_BERSAMAAN'
  return err
}

/* ---- Mekanisme batas turn + review per run (fase 5) ----
   Batasan ini HIDUP di loop agent (agent.ts — MILIK HERMES, belum
   tersambung; lihat catatan di bawah). Yang disediakan di sini:
   - registerTurn(runId): hitung 1 turn; lempar RUN_MAX_TURN bila > 30.
   - registerReviewCall(runId): hitung 1 review; lempar
     REVIEW_MAX_1_PER_RUN bila review ke-2 dalam run yang sama.
     complete() memanggilnya sendiri bila opts.kind === 'review' dan
     opts.runId terisi, jadi begitu agent.ts meneruskan runId + kind,
     batas review langsung aktif tanpa perubahan lain di sini.
   - shouldSkipReview(change): heuristik edit sepele (≤1 file dan ≤10
     baris berubah) — agent.ts yang memutuskan memakainya sebelum review.
   Entri run dibersihkan malas setelah 2 jam tidak disentuh. */
export const MAX_TURNS_PER_RUN = 30
export const MAX_REVIEW_PER_RUN = 1
/* Edit sepele: review boleh dilewati bila perubahan sekecil ini. */
export const TRIVIAL_EDIT_MAX_FILES = 1
export const TRIVIAL_EDIT_MAX_LINES = 10

type RunTrack = { turns: number; reviews: number; lastSeen: number }
const runTracks = new Map<string, RunTrack>()
const RUN_TRACK_TTL_MS = 2 * 60 * 60 * 1000

function pruneRunTracks(now = Date.now()) {
  for (const [id, t] of runTracks) if (now - t.lastSeen > RUN_TRACK_TTL_MS) runTracks.delete(id)
}

function trackFor(runId: string): RunTrack {
  pruneRunTracks()
  let t = runTracks.get(runId)
  if (!t) {
    t = { turns: 0, reviews: 0, lastSeen: Date.now() }
    runTracks.set(runId, t)
  }
  t.lastSeen = Date.now()
  return t
}

export function registerTurn(runId: string): number {
  const t = trackFor(runId)
  t.turns += 1
  if (t.turns > MAX_TURNS_PER_RUN) {
    const err = new Error(
      `Run ini sudah melewati batas ${MAX_TURNS_PER_RUN} turn — hentikan dan mulai chat baru dengan instruksi yang lebih ringkas.`,
    )
    ;(err as Error & { code: string }).code = 'RUN_MAX_TURN'
    throw err
  }
  return t.turns
}

export function turnsUsed(runId: string): number {
  return runTracks.get(runId)?.turns ?? 0
}

export function registerReviewCall(runId: string): number {
  const t = trackFor(runId)
  t.reviews += 1
  if (t.reviews > MAX_REVIEW_PER_RUN) {
    const err = new Error(
      `Review sudah dilakukan ${MAX_REVIEW_PER_RUN}× dalam run ini — review tambahan tidak diizinkan.`,
    )
    ;(err as Error & { code: string }).code = 'REVIEW_MAX_1_PER_RUN'
    throw err
  }
  return t.reviews
}

export function reviewsUsed(runId: string): number {
  return runTracks.get(runId)?.reviews ?? 0
}

export function endRunTracking(runId: string) {
  runTracks.delete(runId)
}

export function shouldSkipReview(change: { filesChanged: number; linesAdded: number; linesRemoved: number }): boolean {
  const lines = Math.max(0, change.linesAdded) + Math.max(0, change.linesRemoved)
  return change.filesChanged <= TRIVIAL_EDIT_MAX_FILES && lines <= TRIVIAL_EDIT_MAX_LINES
}

export async function complete(
  messages: ChatMessage[],
  opts: {
    model?: string
    tools?: unknown[]
    temperature?: number
    maxTokens?: number
    onDelta?: (text: string) => void | Promise<void>
    userId?: string
    /* Fase 5: runId + kind dipakai mekanisme batas review/turn per run.
       Tanpa runId, batas review tidak bisa dilacak dan dilewati. */
    runId?: string
    kind?: 'chat' | 'review'
  } = {},
): Promise<{ message: ChatMessage & { role: 'assistant' }; usage?: unknown }> {
  /* Resolusi registry (provider, model): endpoint + key + tarif.
     Menolak SEBELUM panggilan LLM bila provider/model nonaktif, model
     hanya /messages, tanpa tarif, atau key belum terpasang — tanpa
     biaya, error jelas (kode MODEL_NONAKTIF / MODEL_MESSAGES_ONLY /
     MODEL_TANPA_TARIF / MODEL_TANPA_KEY). Model tak dikenal di registry
     fallback ke endpoint 9router tapi tetap ditolak karena tanpa tarif
     (anti-rugi: tidak ada fallback tarif luna). */
  const model = opts.model ?? effectiveModel()
  const resolved = resolveProviderModel(model)
  const endpoint = resolved.endpoint
  const apiKey = resolved.apiKey

  /* Gate: cek saldo dulu — JANGAN lakukan panggilan LLM bila saldo kurang. */
  if (opts.userId) {
    const bal = getBalance(opts.userId)
    if (bal.total < minBalanceToCall()) throw creditHabisError(bal.total)
    /* Fase 5: cap harian total + batas laju panggilan — juga sebelum LLM. */
    checkDailyCap(opts.userId)
    checkCallRate(opts.userId)
  }

  /* Fase 5: maks. 1 run bersamaan per pengguna — dilepas di finally. */
  const guarded = Boolean(opts.userId)
  if (guarded && activeRuns.has(opts.userId as string)) throw concurrentRunError()
  if (guarded) activeRuns.add(opts.userId as string)
  try {
    /* Fase 5: review maks. 1× per run (bila runId diteruskan pemanggil).
       Di dalam try supaya guard dilepas bila registrasi ini menolak. */
    if (opts.userId && opts.kind === 'review' && opts.runId) registerReviewCall(opts.runId)
    return await completeInner(messages, opts, endpoint, apiKey, model, resolved)
  } finally {
    if (guarded) activeRuns.delete(opts.userId as string)
  }
}

async function completeInner(
  messages: ChatMessage[],
  opts: { model?: string; tools?: unknown[]; temperature?: number; maxTokens?: number; onDelta?: (text: string) => void | Promise<void>; userId?: string; runId?: string; kind?: 'chat' | 'review' },
  endpoint: string,
  apiKey: string,
  model: string,
  resolved: ResolvedModel,
): Promise<{ message: ChatMessage & { role: 'assistant' }; usage?: unknown }> {

  /* Usage final (terakhir yang diterima) — dipotong tepat sekali,
     dengan provider + tarif registry yang dipakai panggilan ini. */
  let finalUsage: UsageInput | undefined
  const settle = () => {
    if (!opts.userId || !finalUsage) return
    try {
      deduct(opts.userId, model, finalUsage, resolved.providerId)
    } catch (e) {
      /* Gagal catat tidak boleh menggagalkan chat yang sudah berhasil. */
      console.error('[credits] deduct gagal:', e)
    }
  }
  const noteUsage = (u: unknown) => {
    trackUsage(u)
    if (opts.userId) recordTokenUsage(opts.userId, model, u)
    const o = u as UsageInput | undefined
    if (o && typeof o === 'object' && (typeof o.prompt_tokens === 'number' || typeof o.completion_tokens === 'number')) {
      finalUsage = o
    }
  }
  try {
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

  const payload = JSON.stringify(body)
  const attempt = () =>
    fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: payload,
      signal: AbortSignal.timeout(180_000),
    })
  /* Gater: pembatas konservatif (maks 5 bersamaan + ~40 RPM) + satu
     retry ringan bila 429/503. Provider lain: langsung. */
  let res: Response
  if (resolved.isGater) {
    res = await withGaterLimits(async () => {
      let r = await attempt()
      if (r.status === 429 || r.status === 503) {
        await new Promise((rr) => setTimeout(rr, 1000))
        r = await attempt()
      }
      return r
    })
  } else {
    res = await attempt()
  }

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
    settle()
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
  settle()
  return { message, usage: json.usage }
  } catch (err) {
    /* LLM error setelah usage sebagian diterima: potong usage itu. */
    settle()
    throw err
  }
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

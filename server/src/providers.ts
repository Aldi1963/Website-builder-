import { db } from './db.ts'
import { COMMANDCODE_MODELS } from './providers-seed.ts'
import type { Hono, MiddlewareHandler } from 'hono'

/* ---- Registry provider LLM VibeBuilder ----
   Satu registry berkunci (provider, model) — ID model bisa sama antar
   provider (mis. 'deepseek-v4-flash' ada di sumopod DAN gater), jadi
   tarif + endpoint + key SELALU diselesaikan per pasangan itu.
   Disimpan di admin_settings key 'llm.providers' (JSON). Key API TIDAK
   PERNAH disimpan di registry: key hidup di admin_settings
   'llm.key.<provider>' (diatur admin) atau environment (keyEnv) — dan
   TIDAK PERNAH dikembalikan API mana pun, TIDAK PERNAH dicetak di log.
   Model TANPA tarif (rate null) = TIDAK BOLEH dipakai: resolveProviderModel
   menolak sebelum panggilan LLM, JANGAN fallback ke tarif luna
   (prinsip anti-rugi). Tarif $0 (model gratis) SAH: potongan 0. */

export type ProviderModel = {
  id: string
  name?: string
  active: boolean
  /* Tarif USD per 1 juta token. null = harga belum diketahui → model
     tidak boleh dipakai sampai tarif diisi. 0 = gratis. */
  rateInUsdPer1M: number | null
  rateOutUsdPer1M: number | null
  /* Override endpoint chat-completions penuh (bila ada). Default:
     <baseUrl>/chat/completions. */
  endpoint?: string
  notes?: string
  /* Hanya endpoint /messages (Anthropic) — butuh client Anthropic
     yang belum dibangun; selalu ditolak di resolveProviderModel. */
  messagesOnly?: boolean
  /* Gater: tools:true terkonfirmasi di GET /v1/models. Model tanpa
     tools terkonfirmasi berisiko gagal di loop agen (tool_calls). */
  toolsConfirmed?: boolean
  contextLength?: number
  source?: string
}

export type Provider = {
  id: string
  name: string
  baseUrl: string
  /* Nama environment variable tempat key dibaca bila tidak ada key
     tersimpan di admin_settings. */
  keyEnv: string
  active: boolean
  notes?: string
  models: ProviderModel[]
}

export type Registry = { version: 1; providers: Provider[] }

export const REGISTRY_KEY = 'llm.providers'
export const IDR_PER_USD = 18300

function setting(key: string): string | undefined {
  try {
    const row = db.prepare('SELECT value FROM admin_settings WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value
  } catch {
    return undefined
  }
}

function putSetting(key: string, value: string) {
  db.prepare(
    `INSERT INTO admin_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, Date.now())
}

/* ---- Seed awal ---- */

const NINE_ROUTER: Provider = {
  id: '9router',
  name: '9router',
  /* Base gateway LOKAL (pola llm.ts yang ada): 9router berjalan di VM
     ini pada 127.0.0.1:20128 dan di-forward ke VPS — JANGAN ganti ke
     https://ai.clipku.com/v1 tanpa verifikasi, itu mengubah jalur live.
     Upstream publik 9router adalah ai.clipku.com. Endpoint chat efektif
     = admin llm.url ?? env VB_LLM_URL ?? base ini + /chat/completions. */
  baseUrl: 'http://127.0.0.1:20128/v1',
  keyEnv: 'VB_LLM_KEY',
  active: true,
  notes: 'Provider default builder. Key dari admin llm.key (override) atau env VB_LLM_KEY / HERMES_9ROUTER_API_KEY; endpoint dari admin llm.url (override) atau env VB_LLM_URL. Upstream publik: https://ai.clipku.com/v1.',
  models: [
    { id: 'cx/gpt-5.6-luna', name: 'GPT-5.6 Luna (cx)', active: true, rateInUsdPer1M: 1, rateOutUsdPer1M: 6, source: 'vibebuilder-credit-2026-11-25' },
    { id: 'cx/gpt-5.6-luna-review', name: 'GPT-5.6 Luna Review (cx)', active: true, rateInUsdPer1M: 2.5, rateOutUsdPer1M: 15, source: 'vibebuilder-credit-2026-11-25' },
  ],
}

const SUMOPOD: Provider = {
  id: 'sumopod',
  name: 'Sumopod',
  baseUrl: 'https://ai.sumopod.com/v1',
  keyEnv: 'SUMOPOD_API_KEY',
  active: false,
  notes: 'Belum ada key — user harus buat akun + top up AI Balance + buat key di ai.sumopod.com, lalu tempel lewat admin panel. Tarif dari katalog README 27 Okt 2026 — bisa tertinggal + diskon kedaluwarsa, perlu sinkronisasi saat key terpasang. Hanya 14 dari ~52 model ter-seed (yang tarifnya tercatat); sisanya ditemukan via sinkronisasi GET /v1/models. ID model tanpa prefix vendor — wajib di-namespace per provider.',
  models: [
    { id: 'deepseek-v4-flash', active: true, rateInUsdPer1M: 0.14, rateOutUsdPer1M: 0.28, source: 'sumopod-readme-2026-10-27' },
    { id: 'deepseek-v4-pro', active: true, rateInUsdPer1M: 0.43, rateOutUsdPer1M: 0.87, source: 'sumopod-readme-2026-10-27' },
    { id: 'kimi-k2.6', active: true, rateInUsdPer1M: 0.08, rateOutUsdPer1M: 0.35, source: 'sumopod-readme-2026-10-27' },
    { id: 'glm-5.1', active: true, rateInUsdPer1M: 0.1, rateOutUsdPer1M: 0.32, source: 'sumopod-readme-2026-10-27' },
    { id: 'gpt-5.2', active: true, rateInUsdPer1M: 1.75, rateOutUsdPer1M: 14, source: 'sumopod-readme-2026-10-27' },
    { id: 'gpt-5-nano', active: true, rateInUsdPer1M: 0.05, rateOutUsdPer1M: 0.4, source: 'sumopod-readme-2026-10-27' },
    { id: 'claude-opus-4-6', active: true, rateInUsdPer1M: 5, rateOutUsdPer1M: 25, source: 'sumopod-readme-2026-10-27' },
    { id: 'claude-sonnet-4-6', active: true, rateInUsdPer1M: 3, rateOutUsdPer1M: 15, source: 'sumopod-readme-2026-10-27' },
    { id: 'claude-haiku-4-5', active: true, rateInUsdPer1M: 0.7, rateOutUsdPer1M: 3.5, source: 'sumopod-readme-2026-10-27' },
    { id: 'gemini-2.5-flash', active: true, rateInUsdPer1M: 0.3, rateOutUsdPer1M: 2.5, source: 'sumopod-readme-2026-10-27' },
    { id: 'nemotron-3-nano-30b', active: true, rateInUsdPer1M: 0, rateOutUsdPer1M: 0, notes: 'Gratis (Cloudeka) — tarif $0, potongan 0.', source: 'sumopod-readme-2026-10-27' },
    { id: 'gpt-oss-20b', active: true, rateInUsdPer1M: 0, rateOutUsdPer1M: 0, notes: 'Gratis (Cloudeka) — tarif $0, potongan 0.', source: 'sumopod-readme-2026-10-27' },
    { id: 'qwen3-30b-a3b-instruct-2507', active: true, rateInUsdPer1M: 0, rateOutUsdPer1M: 0, notes: 'Gratis (Cloudeka) — tarif $0, potongan 0.', source: 'sumopod-readme-2026-10-27' },
    { id: 'glm-4.7-fp8', active: true, rateInUsdPer1M: 0, rateOutUsdPer1M: 0, notes: 'Gratis (Cloudeka) — tarif $0, potongan 0.', source: 'sumopod-readme-2026-10-27' },
  ],
}

/* Gater: 35 model, daftar identik dengan GET /v1/models (riset 25 Nov
   2026 20:14 WIB, diff kosong). TANPA HARGA — tarif per token tidak ada
   di dokumentasi publik mana pun (model bisnis Gater = paket akses
   berbasis waktu: Rp3.000/1 hari, Rp7.500/3 hari, Rp14.000/7 hari dari
   posting Threads 11 Nov — BELUM terverifikasi). Model tanpa tarif =
   tidak boleh dipakai. Varian -uncen DITAWARKAN juga (keputusan user
   25 Nov ~20:16) — seed aktif seperti model lain, pemakaian tetap
   menunggu harga. toolsConfirmed dari /v1/models: hanya 9 model yang
   menyatakan tools:true; sisanya belum terkonfirmasi dukung tool_calls
   (peringatan untuk run agen). */
const GATER_TOOLS: Record<string, boolean> = {
  S5: true,
  'deepseek-v4.1-flash-1017-uncen': true,
  'glm-5.3': true,
  'mimo-v2.5': true,
  'plamo-3.1-prime': true,
  'qwen3.7-plus': true,
  'qwen3.7-plus-uncen': true,
  'qwen3.8-flash-uncen': true,
  'step-5-preview': true,
}
const GATER_CONTEXT: Record<string, number> = {
  'gpt-6-luna': 1050000,
  'deepseek-v4.1-flash-1017': 128000,
  'deepseek-v4.1-flash': 128000,
  'deepseek-v4.1-flash-1017-uncen': 1000000,
  'claude-haiku-5.5': 200000,
  auto: 200000,
}
const GATER_NOTES: Record<string, string> = {
  'glm-5.3': 'Sempat MODEL_UNAVAILABLE / RATE_LIMIT di sisi Gater, 25 Nov 2026.',
}
const GATER_IDS = [
  'S5', 'atria-dawn', 'auto', 'claude-haiku-5.5', 'deepseek-v4-flash', 'deepseek-v4.1-flash',
  'deepseek-v4.1-flash-1017', 'deepseek-v4.1-flash-1017-uncen', 'ernie-5.5-flash-preview',
  'exaone-v2.5', 'glm-5-3-flash', 'glm-5.3', 'gpt-6-luna', 'hungerg', 'hy3', 'hy4-flash',
  'ling-3.2-flash', 'longcat-2.5', 'mercury-3', 'mimo-v2.5', 'mimo-v2.6.flash',
  'minimax-m3.1-flash', 'nemotron-3.5-super', 'nex-n2.6', 'plamo-3.1-prime', 'qwen-3.8-27b',
  'qwen3.7-plus', 'qwen3.7-plus-uncen', 'qwen3.8-flash', 'qwen3.8-flash-uncen',
  'sensenova-6.8-flash', 'solar-mini4', 'solar-pro4', 'step-3.7-flash', 'step-5-preview',
]

const GATER: Provider = {
  id: 'gater',
  name: 'Gater',
  baseUrl: 'https://api.gater.ai.id/v1',
  keyEnv: 'GATER_API_KEY',
  active: false,
  notes: 'HARGA PER MODEL TIDAK DITEMUKAN di dokumentasi publik — TANPA HARGA model TIDAK BOLEH dipakai (risiko rugi). Batas per key (konservatif, dipakai pembatas): maks 5 koneksi bersamaan + ~40 RPM; config Hermes mencatat 10 IP, 5 koneksi, 500 RPM (antre di atas 100 RPM), situs resmi menyebut RPM normal 50/mnt (antre mulai 40), model premium 15/mnt/key. Tes koneksi hanya GET /v1/models — /v1/key, /v1/credits, /v1/me, /v1/usage, /v1/balance semua 404. Nama model Luna di sini gpt-6-luna, BUKAN cx/gpt-5.6-luna (9router).',
  models: GATER_IDS.map((id) => ({
    id,
    active: true,
    rateInUsdPer1M: null,
    rateOutUsdPer1M: null,
    toolsConfirmed: GATER_TOOLS[id] ?? false,
    ...(GATER_CONTEXT[id] ? { contextLength: GATER_CONTEXT[id] } : {}),
    ...(GATER_NOTES[id] ? { notes: GATER_NOTES[id] } : {}),
    source: 'gater-models-2026-11-25',
  })),
}

const COMMANDCODE: Provider = {
  id: 'commandcode',
  name: 'CommandCode',
  baseUrl: 'https://api.commandcode.ai/provider/v1',
  keyEnv: 'COMMANDCODE_API_KEY',
  active: false,
  notes: 'TERBLOKIR — paket Go $1/bln tidak termasuk akses API: chat ditolak 403 upgrade_required (terverifikasi langsung 25 Nov 2026). Butuh upgrade ke GOAT $10/bln (juga membuka API, credit pool + rolling window) atau Provider $15/bln (+$1,01 fee, termasuk $15 credit, PAYG tanpa markup — rute paling bersih). Model gratis (:free) tetap terblokir — blokir di level paket, bukan model. Auth Bearer (untuk /messages boleh juga x-api-key); header opsional x-cmd-zdr: 1.',
  models: COMMANDCODE_MODELS,
}

export function defaultRegistry(): Registry {
  return {
    version: 1,
    providers: [
      structuredClone(NINE_ROUTER),
      structuredClone(COMMANDCODE),
      structuredClone(SUMOPOD),
      structuredClone(GATER),
    ],
  }
}

/* ---- Muat / simpan registry ---- */

let cache: Registry | null = null

function validRate(v: unknown): number | null | undefined {
  if (v === null) return null
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v
  return undefined
}

function sanitizeRegistry(raw: unknown): Registry | null {
  if (!raw || typeof raw !== 'object') return null
  const providers = (raw as { providers?: unknown }).providers
  if (!Array.isArray(providers)) return null
  const out: Provider[] = []
  for (const p of providers) {
    if (!p || typeof p !== 'object') continue
    const id = (p as { id?: unknown }).id
    const baseUrl = (p as { baseUrl?: unknown }).baseUrl
    const models = (p as { models?: unknown }).models
    if (typeof id !== 'string' || !id || typeof baseUrl !== 'string' || !baseUrl || !Array.isArray(models)) continue
    const cleanModels: ProviderModel[] = []
    for (const m of models) {
      if (!m || typeof m !== 'object') continue
      const mid = (m as { id?: unknown }).id
      if (typeof mid !== 'string' || !mid) continue
      const rin = validRate((m as { rateInUsdPer1M?: unknown }).rateInUsdPer1M)
      const rout = validRate((m as { rateOutUsdPer1M?: unknown }).rateOutUsdPer1M)
      if (rin === undefined || rout === undefined) continue
      const mm = m as Partial<ProviderModel>
      cleanModels.push({
        id: mid,
        ...(typeof mm.name === 'string' ? { name: mm.name } : {}),
        active: mm.active !== false,
        rateInUsdPer1M: rin,
        rateOutUsdPer1M: rout,
        ...(typeof mm.endpoint === 'string' ? { endpoint: mm.endpoint } : {}),
        ...(typeof mm.notes === 'string' ? { notes: mm.notes } : {}),
        ...(mm.messagesOnly === true ? { messagesOnly: true } : {}),
        ...(typeof mm.toolsConfirmed === 'boolean' ? { toolsConfirmed: mm.toolsConfirmed } : {}),
        ...(typeof mm.contextLength === 'number' ? { contextLength: mm.contextLength } : {}),
        ...(typeof mm.source === 'string' ? { source: mm.source } : {}),
      })
    }
    const pp = p as Partial<Provider>
    out.push({
      id,
      name: typeof pp.name === 'string' && pp.name ? pp.name : id,
      baseUrl,
      keyEnv: typeof pp.keyEnv === 'string' && pp.keyEnv ? pp.keyEnv : '',
      active: pp.active !== false,
      ...(typeof pp.notes === 'string' ? { notes: pp.notes } : {}),
      models: cleanModels,
    })
  }
  if (!out.length) return null
  return { version: 1, providers: out }
}

export function getRegistry(): Registry {
  if (cache) return cache
  const raw = setting(REGISTRY_KEY)
  if (raw) {
    try {
      const parsed = sanitizeRegistry(JSON.parse(raw))
      if (parsed) {
        cache = parsed
        return parsed
      }
    } catch {
      /* JSON rusak → seed ulang di bawah */
    }
  }
  const seed = defaultRegistry()
  saveRegistry(seed)
  syncLlmPricesFromRegistry(seed)
  cache = seed
  return seed
}

export function saveRegistry(reg: Registry): Registry {
  const clean = sanitizeRegistry(reg)
  if (!clean) throw new Error('Registry provider tidak valid.')
  putSetting(REGISTRY_KEY, JSON.stringify(clean))
  cache = clean
  return clean
}

export function resetRegistryCache() {
  cache = null
}

/* ---- Key + endpoint per provider (key TIDAK PERNAH dikembalikan) ---- */

export function providerKey(provider: Provider): string {
  if (provider.id === '9router') {
    /* Kompatibilitas legacy: override admin llm.key mengalahkan env.
       llm.key.9router (ditulis endpoint admin PUT …/key) dibaca juga —
       tanpa ini key 9router yang disimpan lewat panel Provider LLM
       tidak pernah terbaca (sebelumnya hanya llm.key/env yang dicek). */
    return (
      setting('llm.key') ??
      setting('llm.key.9router') ??
      process.env.VB_LLM_KEY ??
      process.env.HERMES_9ROUTER_API_KEY ??
      ''
    ).trim()
  }
  const stored = setting(`llm.key.${provider.id}`)
  if (stored !== undefined) return stored.trim()
  return (provider.keyEnv ? (process.env[provider.keyEnv] ?? '') : '').trim()
}

export function providerKeyConfigured(provider: Provider): boolean {
  return providerKey(provider).length > 0
}

export function providerBaseUrl(provider: Provider): string {
  return provider.baseUrl
}

function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + path
}

/* Endpoint chat-completions efektif. 9router MENGIKUTI rantai legacy
   llm.ts persis: admin llm.url ?? env VB_LLM_URL ?? gateway lokal —
   llm.url/VB_LLM_URL adalah URL chat LENGKAP (termasuk
   /chat/completions), bukan base. Provider lain: base + path. */
export function providerChatEndpoint(provider: Provider, model?: ProviderModel): string {
  if (model?.endpoint) return model.endpoint
  if (provider.id === '9router') {
    const override = (setting('llm.url') ?? process.env.VB_LLM_URL ?? '').trim()
    if (override) return override
  }
  return joinUrl(providerBaseUrl(provider), '/chat/completions')
}

export function providerModelsUrl(provider: Provider): string {
  if (provider.id === '9router') {
    /* Uji terhadap gateway yang benar-benar dipakai chat. */
    return providerChatEndpoint(provider).replace(/\/chat\/completions\/?$/, '') + '/models'
  }
  return joinUrl(providerBaseUrl(provider), '/models')
}

/* ---- Pencarian (provider, model) ---- */

export function getProvider(providerId: string): Provider | undefined {
  return getRegistry().providers.find((p) => p.id === providerId)
}

export function findModel(modelId: string): { provider: Provider; model: ProviderModel } | undefined {
  const reg = getRegistry()
  const matches: { provider: Provider; model: ProviderModel }[] = []
  for (const p of reg.providers) {
    const m = p.models.find((x) => x.id === modelId)
    if (m) matches.push({ provider: p, model: m })
  }
  if (!matches.length) return undefined
  if (matches.length === 1) return matches[0]
  /* ID sama di beberapa provider (mis. 'gpt-6-luna' di commandcode DAN
     gater): pilih yang BISA dipakai — provider aktif, model aktif,
     punya tarif, bukan messages-only; 9router didahulukan bila seri
     (legacy). Pemakaian lewat UI selalu membawa provider eksplisit. */
  const score = ({ provider: p, model: m }: { provider: Provider; model: ProviderModel }) =>
    (p.active ? 4 : 0) +
    (m.active ? 2 : 0) +
    (m.rateInUsdPer1M !== null && m.rateOutUsdPer1M !== null ? 1 : 0) -
    (m.messagesOnly ? 2 : 0)
  return [...matches].sort(
    (a, b) => score(b) - score(a) || (a.provider.id === '9router' ? -1 : b.provider.id === '9router' ? 1 : 0),
  )[0]
}

export function findModelIn(providerId: string, modelId: string): { provider: Provider; model: ProviderModel } | undefined {
  const p = getProvider(providerId)
  if (!p) return undefined
  const m = p.models.find((x) => x.id === modelId)
  return m ? { provider: p, model: m } : undefined
}

/* Tarif registry untuk (provider, model). null = tidak ada tarif. */
export function ratesForProviderModel(
  providerId: string,
  modelId: string,
): { rateIn: number; rateOut: number } | null {
  const found = findModelIn(providerId, modelId)
  if (!found) return null
  const { rateInUsdPer1M: rin, rateOutUsdPer1M: rout } = found.model
  if (rin === null || rout === null) return null
  return { rateIn: rin, rateOut: rout }
}

/* ---- Resolve model → endpoint + key + tarif (dipakai llm.ts) ---- */

export class ProviderError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

function inactiveError(provider: Provider, model: ProviderModel): ProviderError {
  return new ProviderError(
    'MODEL_NONAKTIF',
    `Model nonaktif — ${model.id} di provider ${provider.name} sedang dimatikan. Pilih model aktif lain atau hubungi admin.`,
  )
}

export type ResolvedModel = {
  providerId: string
  providerName: string
  modelId: string
  endpoint: string
  apiKey: string
  rateIn: number
  rateOut: number
  isGater: boolean
}

export function resolveProviderModel(modelId: string): ResolvedModel {
  const found = findModel(modelId)
  if (!found) {
    /* Model tak dikenal: fallback endpoint/key 9router (legacy) — tapi
       tanpa tarif tetap DITOLAK di bawah (anti-rugi). */
    const nine = getProvider('9router')
    const where = nine ? ` (fallback ${nine.name})` : ''
    throw new ProviderError(
      'MODEL_TANPA_TARIF',
      `Model tanpa tarif — ${modelId} tidak ada di registry provider${where}, jadi tidak bisa dipakai sebelum admin mendaftarkan tarifnya.`,
    )
  }
  const { provider, model } = found
  if (!provider.active) throw inactiveError(provider, model)
  if (!model.active) throw inactiveError(provider, model)
  if (model.messagesOnly) {
    throw new ProviderError(
      'MODEL_MESSAGES_ONLY',
      `Model ini hanya mendukung endpoint /messages (Anthropic) — ${model.id} di provider ${provider.name} butuh client Anthropic yang belum dibangun. Pilih model chat-completions lain.`,
    )
  }
  if (model.rateInUsdPer1M === null || model.rateOutUsdPer1M === null) {
    throw new ProviderError(
      'MODEL_TANPA_TARIF',
      `Model tanpa tarif — ${model.id} di provider ${provider.name} belum punya harga per token, jadi belum bisa dipakai. Admin harus mengisi tarifnya dulu.`,
    )
  }
  const key = providerKey(provider)
  if (!key) {
    throw new ProviderError(
      'MODEL_TANPA_KEY',
      `API key provider ${provider.name} belum terpasang — ${model.id} belum bisa dipakai. Admin harus menempel key ${provider.name} di panel admin dulu.`,
    )
  }
  return {
    providerId: provider.id,
    providerName: provider.name,
    modelId: model.id,
    endpoint: providerChatEndpoint(provider, model),
    apiKey: key,
    rateIn: model.rateInUsdPer1M,
    rateOut: model.rateOutUsdPer1M,
    isGater: provider.id === 'gater',
  }
}

/* ---- Pembatas Gater (konservatif) ----
   Maks 5 panggilan bersamaan + jeda antar panggilan ≥1500 ms (~40 RPM).
   Dipakai llm.ts hanya untuk provider gater. */
const GATER_MAX_CONCURRENT = 5
const GATER_MIN_INTERVAL_MS = 1500
let gaterActive = 0
let gaterLastStart = 0

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function withGaterLimits<T>(fn: () => Promise<T>): Promise<T> {
  for (;;) {
    const now = Date.now()
    const waitInterval = Math.max(0, GATER_MIN_INTERVAL_MS - (now - gaterLastStart))
    if (gaterActive < GATER_MAX_CONCURRENT && waitInterval === 0) break
    await sleep(Math.min(100, Math.max(50, waitInterval)))
  }
  gaterActive += 1
  gaterLastStart = Date.now()
  try {
    return await fn()
  } finally {
    gaterActive -= 1
  }
}

/* ---- Daftar publik (GET /api/llm/models): HANYA model yang boleh
   dipakai — provider aktif + model aktif + punya tarif + bukan
   messages-only. Tanpa key, tanpa model nonaktif. ---- */

export type PublicModel = {
  provider: string
  providerName: string
  id: string
  name?: string
  rateInUsdPer1M: number
  rateOutUsdPer1M: number
  toolsConfirmed?: boolean
  contextLength?: number
  notes?: string
}

export function publicModels(): PublicModel[] {
  const out: PublicModel[] = []
  for (const p of getRegistry().providers) {
    if (!p.active) continue
    for (const m of p.models) {
      if (!m.active || m.messagesOnly) continue
      if (m.rateInUsdPer1M === null || m.rateOutUsdPer1M === null) continue
      out.push({
        provider: p.id,
        providerName: p.name,
        id: m.id,
        ...(m.name ? { name: m.name } : {}),
        rateInUsdPer1M: m.rateInUsdPer1M,
        rateOutUsdPer1M: m.rateOutUsdPer1M,
        ...(typeof m.toolsConfirmed === 'boolean' ? { toolsConfirmed: m.toolsConfirmed } : {}),
        ...(typeof m.contextLength === 'number' ? { contextLength: m.contextLength } : {}),
        ...(m.notes ? { notes: m.notes } : {}),
      })
    }
  }
  return out
}

/* ---- Tampilan registry untuk admin (tanpa key — hanya status) ---- */

export function registryView(): { providers: (Omit<Provider, 'models'> & { keyConfigured: boolean; models: ProviderModel[] })[] } {
  return {
    providers: getRegistry().providers.map((p) => ({
      id: p.id,
      name: p.name,
      baseUrl: providerBaseUrl(p),
      keyEnv: p.keyEnv,
      active: p.active,
      ...(p.notes ? { notes: p.notes } : {}),
      keyConfigured: providerKeyConfigured(p),
      models: p.models,
    })),
  }
}

/* ---- Operasi admin (dipakai endpoint + builder UI nanti) ---- */

export function setProviderActive(providerId: string, active: boolean): Provider {
  const reg = getRegistry()
  const p = reg.providers.find((x) => x.id === providerId)
  if (!p) throw new Error(`Provider tidak dikenal: ${providerId}`)
  p.active = active
  saveRegistry(reg)
  return p
}

export function setModelActive(providerId: string, modelId: string, active: boolean): ProviderModel {
  const reg = getRegistry()
  const p = reg.providers.find((x) => x.id === providerId)
  const m = p?.models.find((x) => x.id === modelId)
  if (!p || !m) throw new Error(`Model tidak dikenal: ${providerId}/${modelId}`)
  m.active = active
  saveRegistry(reg)
  return m
}

export function setModelRate(
  providerId: string,
  modelId: string,
  rateIn: number | null,
  rateOut: number | null,
): ProviderModel {
  const check = (v: number | null) => v === null || (Number.isFinite(v) && v >= 0)
  if (!check(rateIn) || !check(rateOut)) throw new Error('Tarif harus angka >= 0 atau null (belum diketahui).')
  const reg = getRegistry()
  const p = reg.providers.find((x) => x.id === providerId)
  const m = p?.models.find((x) => x.id === modelId)
  if (!p || !m) throw new Error(`Model tidak dikenal: ${providerId}/${modelId}`)
  m.rateInUsdPer1M = rateIn
  m.rateOutUsdPer1M = rateOut
  saveRegistry(reg)
  return m
}

/* Simpan key provider (admin_settings llm.key.<provider>). Key kosong =
   hapus key tersimpan (kembali ke env). TIDAK PERNAH mengembalikan key. */
export function setProviderKey(providerId: string, key: string): { keyConfigured: boolean } {
  const p = getProvider(providerId)
  if (!p) throw new Error(`Provider tidak dikenal: ${providerId}`)
  const k = key.trim()
  if (k === '') {
    db.prepare(`DELETE FROM admin_settings WHERE key = ?`).run(`llm.key.${providerId}`)
  } else {
    if (k.length < 8) throw new Error('API key terlalu pendek (min 8 karakter).')
    putSetting(`llm.key.${providerId}`, k)
  }
  resetRegistryCache()
  return { keyConfigured: providerKeyConfigured(getProvider(providerId)!) }
}

/* ---- llm_prices (halaman Biaya LLM) ----
   Rp per 1.000 token = USD/1M × 18.300 / 1.000. Hanya MENAMBAH key yang
   belum ada (tidak menimpa harga yang sudah diisi admin). Model tanpa
   tarif TIDAK diisi angka karangan. Perhatian: llm_prices berkunci ID
   model saja (tanpa provider) — ID yang sama di dua provider (mis.
   deepseek-v4-flash di sumopod + gater) berbagi satu harga di halaman
   Biaya; pemotongan credit tetap memakai registry per provider. */
export function syncLlmPricesFromRegistry(reg: Registry = getRegistry()): { added: number; skipped: number } {
  let prices: Record<string, { prompt_per_1k: number; completion_per_1k: number; currency: 'IDR' }> = {}
  try {
    const raw = setting('llm_prices')
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) prices = parsed as typeof prices
    }
  } catch {
    /* abaikan */
  }
  const r2 = (n: number) => Math.round(n * 100) / 100
  let added = 0
  let skipped = 0
  for (const p of reg.providers) {
    for (const m of p.models) {
      if (m.rateInUsdPer1M === null || m.rateOutUsdPer1M === null) continue
      if (prices[m.id]) {
        skipped++
        continue
      }
      prices[m.id] = {
        prompt_per_1k: r2((m.rateInUsdPer1M * IDR_PER_USD) / 1000),
        completion_per_1k: r2((m.rateOutUsdPer1M * IDR_PER_USD) / 1000),
        currency: 'IDR',
      }
      added++
    }
  }
  if (added > 0) putSetting('llm_prices', JSON.stringify(prices))
  return { added, skipped }
}

/* ---- Tes koneksi ringan + sinkronisasi daftar model ----
   GET {baseUrl}/models dengan key provider (bila ada). Tanpa chat
   berbayar. Untuk gater ini satu-satunya endpoint tes yang jalan
   (/v1/key, /v1/credits, /v1/me, /v1/usage, /v1/balance semua 404). */

export type ProviderTestResult = { ok: boolean; status?: number; models?: number; error?: string }

export async function testProviderConnection(providerId: string): Promise<ProviderTestResult> {
  const p = getProvider(providerId)
  if (!p) return { ok: false, error: `Provider tidak dikenal: ${providerId}` }
  const key = providerKey(p)
  try {
    const res = await fetch(providerModelsUrl(p), {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { ok: false, status: res.status, error: `GET /models balas ${res.status}: ${text.slice(0, 200)}` }
    }
    const json = (await res.json().catch(() => null)) as { data?: unknown[] } | null
    const models = Array.isArray(json?.data) ? json.data.length : undefined
    return { ok: true, status: res.status, models }
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 200) }
  }
}

export type UpstreamModel = { id: string; name?: string; contextLength?: number; endpoints?: string[] }

export async function syncProviderModels(providerId: string): Promise<{
  provider: string
  upstream: UpstreamModel[]
  inRegistry: number
  missing: string[]
  error?: string
}> {
  const p = getProvider(providerId)
  if (!p) throw new Error(`Provider tidak dikenal: ${providerId}`)
  const key = providerKey(p)
  const res = await fetch(providerModelsUrl(p), {
    method: 'GET',
    headers: {
      accept: 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`GET /models balas ${res.status}: ${text.slice(0, 200)}`)
  }
  const json = (await res.json().catch(() => null)) as { data?: Record<string, unknown>[] } | null
  const upstream: UpstreamModel[] = (Array.isArray(json?.data) ? json.data : []).flatMap((m) => {
    if (!m || typeof m.id !== 'string') return []
    const u: UpstreamModel = { id: m.id }
    if (typeof m.name === 'string') u.name = m.name
    if (typeof m.context_length === 'number') u.contextLength = m.context_length
    if (Array.isArray(m.supported_endpoints)) u.endpoints = m.supported_endpoints.filter((e): e is string => typeof e === 'string')
    return [u]
  })
  const have = new Set(p.models.map((m) => m.id))
  return {
    provider: p.id,
    upstream,
    inRegistry: upstream.filter((u) => have.has(u.id)).length,
    missing: upstream.filter((u) => !have.has(u.id)).map((u) => u.id),
  }
}

/* ---- Route ----
   Didaftarkan dari registerAdmin (admin.ts) — app.ts TIDAK disentuh.
   requireAdmin diteruskan sebagai parameter supaya tidak ada impor
   sirkular admin.ts <-> providers.ts. */

const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]*$/
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/:]*$/

export function registerProviderRoutes(app: Hono<any>, requireAdmin: MiddlewareHandler<any, any, any, any>) {
  /* Seed saat boot supaya registry + llm_prices sudah terisi sebelum
     ada panggilan pertama. */
  getRegistry()

  /* Publik, tanpa auth berat (pola /api/usage): hanya model yang boleh
     dipakai, tanpa key. */
  app.get('/api/llm/models', (c) => c.json({ models: publicModels() }))

  app.get('/api/admin/llm/providers', requireAdmin, (c) => c.json(registryView()))

  app.put('/api/admin/llm/providers/:providerId', requireAdmin, async (c) => {
    const providerId = c.req.param('providerId')
    const body = (await c.req.json().catch(() => ({}))) as { active?: unknown }
    if (!PROVIDER_ID_RE.test(providerId)) return c.json({ error: 'Provider tidak valid.' }, 400)
    if (typeof body.active !== 'boolean') return c.json({ error: 'Field active wajib boolean.' }, 400)
    try {
      const p = setProviderActive(providerId, body.active)
      return c.json({ ok: true, provider: { id: p.id, active: p.active } })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 404)
    }
  })

  app.put('/api/admin/llm/providers/:providerId/models/:modelId', requireAdmin, async (c) => {
    const providerId = c.req.param('providerId')
    const modelId = decodeURIComponent(c.req.param('modelId'))
    const body = (await c.req.json().catch(() => ({}))) as {
      active?: unknown
      rateInUsdPer1M?: unknown
      rateOutUsdPer1M?: unknown
    }
    if (!PROVIDER_ID_RE.test(providerId) || !MODEL_ID_RE.test(modelId) || modelId.length > 120) {
      return c.json({ error: 'Provider/model tidak valid.' }, 400)
    }
    try {
      if (typeof body.active === 'boolean') {
        const m = setModelActive(providerId, modelId, body.active)
        return c.json({ ok: true, model: { id: m.id, active: m.active } })
      }
      if (body.rateInUsdPer1M !== undefined || body.rateOutUsdPer1M !== undefined) {
        const cur = findModelIn(providerId, modelId)?.model
        if (!cur) return c.json({ error: `Model tidak dikenal: ${providerId}/${modelId}` }, 404)
        const rin = body.rateInUsdPer1M === null ? null : Number(body.rateInUsdPer1M)
        const rout = body.rateOutUsdPer1M === null ? null : Number(body.rateOutUsdPer1M)
        const m = setModelRate(
          providerId,
          modelId,
          body.rateInUsdPer1M === undefined ? cur.rateInUsdPer1M : rin,
          body.rateOutUsdPer1M === undefined ? cur.rateOutUsdPer1M : rout,
        )
        return c.json({ ok: true, model: { id: m.id, rateInUsdPer1M: m.rateInUsdPer1M, rateOutUsdPer1M: m.rateOutUsdPer1M } })
      }
      return c.json({ error: 'Field active atau tarif wajib diisi.' }, 400)
    } catch (e) {
      const msg = (e as Error).message
      return c.json({ error: msg }, msg.includes('tidak dikenal') ? 404 : 400)
    }
  })

  app.put('/api/admin/llm/providers/:providerId/key', requireAdmin, async (c) => {
    const providerId = c.req.param('providerId')
    const body = (await c.req.json().catch(() => ({}))) as { key?: unknown }
    if (!PROVIDER_ID_RE.test(providerId)) return c.json({ error: 'Provider tidak valid.' }, 400)
    if (typeof body.key !== 'string') return c.json({ error: 'Field key wajib string (kosongkan untuk menghapus).' }, 400)
    try {
      const r = setProviderKey(providerId, body.key)
      return c.json({ ok: true, ...r })
    } catch (e) {
      const msg = (e as Error).message
      return c.json({ error: msg }, msg.includes('tidak dikenal') ? 404 : 400)
    }
  })

  app.post('/api/admin/llm/providers/:providerId/test', requireAdmin, async (c) => {
    const providerId = c.req.param('providerId')
    if (!PROVIDER_ID_RE.test(providerId)) return c.json({ error: 'Provider tidak valid.' }, 400)
    return c.json(await testProviderConnection(providerId))
  })

  app.post('/api/admin/llm/providers/:providerId/sync', requireAdmin, async (c) => {
    const providerId = c.req.param('providerId')
    if (!PROVIDER_ID_RE.test(providerId)) return c.json({ error: 'Provider tidak valid.' }, 400)
    try {
      return c.json(await syncProviderModels(providerId))
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502)
    }
  })

  app.post('/api/admin/llm/prices/sync', requireAdmin, (c) => {
    return c.json({ ok: true, ...syncLlmPricesFromRegistry() })
  })
}

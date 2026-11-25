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
  baseUrl: 'https://ai.clipku.com/v1',
  keyEnv: 'VB_LLM_KEY',
  active: true,
  notes: 'Provider default builder. Key dari admin llm.key (override) atau env VB_LLM_KEY / HERMES_9ROUTER_API_KEY; endpoint dari admin llm.url (override).',
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
  notes: 'HARGA PER MODEL TIDAK DITEMUKAN di dokumentasi publik — TANPA HARGA model TIDAK BOLEH dipakai (risiko rugi). PRO habis 2 Des 2026 13:38 WIB; sesudahnya tidak ada pernyataan resmi — kemungkinan akses berhenti total, bukan turun ke free; tidak ada tier gratis yang disebut di mana pun. Batas per key (konservatif, dipakai pembatas): maks 5 koneksi bersamaan + ~40 RPM; config Hermes mencatat 10 IP, 5 koneksi, 500 RPM (antre di atas 100 RPM), situs resmi menyebut RPM normal 50/mnt (antre mulai 40), model premium 15/mnt/key. Tes koneksi hanya GET /v1/models — /v1/key, /v1/credits, /v1/me, /v1/usage, /v1/balance semua 404. Nama model Luna di sini gpt-6-luna, BUKAN cx/gpt-5.6-luna (9router).',
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

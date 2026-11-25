import { api } from './api'

/* ---- Pemilih model dinamis VibeBuilder ----
   Daftar model diambil dari GET /api/llm/models (server, tanpa auth,
   HANYA model yang boleh dipakai: provider aktif + model aktif + punya
   tarif + bukan messages-only — tanpa key). Model review internal
   (…-review) TIDAK ditampilkan di picker, walau endpoint mengembalikannya.

   FORMAT PENYIMPANAN (localStorage 'vb-model'):
   - 'auto' → server memakai default-nya (cx/gpt-5.6-luna).
   - '<provider>:<modelId>' mis. '9router:cx/gpt-5.6-luna' — provider
     dibawa supaya pilihan tidak ambigu bila ID sama di dua provider.
   - Nilai lama (bare id, mis. 'cx/gpt-5.6-luna') tetap dibaca sebagai
     legacy: provider dicari dari katalog bila unik.
   FORMAT WIRE (yang dikirim ke server): HANYA bare model id, karena
   server saat ini TIDAK PUNYA format wire untuk provider — chat body
   hanya membawa `model: string`, resolveProviderModel()/findModel()
   menyelesaikan ambiguitas lewat skor (provider aktif, model aktif,
   punya tarif, 9router didahulukan). Jadi bila satu ID aktif di dua
   provider sekaligus, server yang memilih — UI TIDAK BISA memaksa
   provider tertentu. Perlu penyesuaian server (mis. field `provider`
   di body chat, atau resolveProviderModel() mem-parse "provider:id")
   sebelum picker bisa menjamin provider pilihan. Lihat
   modelIdForServer() — di sanalah prefix provider sengaja dilepas. */

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

export type ModelOption = {
  /** Nilai yang disimpan di localStorage: 'auto' atau '<provider>:<id>'. */
  id: string
  name: string
  note: string
  provider?: string
  /** Bare model id yang dikirim ke server (tanpa prefix provider). */
  modelId?: string
  available?: boolean
}

export const MODEL_AUTO = 'auto'
/** Default server bila 'auto' — efektif saat ini (llm.ts FAST_MODEL). */
export const MODEL_DEFAULT_ID = 'cx/gpt-5.6-luna'

export const selectionKey = (provider: string, modelId: string): string => `${provider}:${modelId}`

export type ParsedSelection =
  | { kind: 'auto' }
  | { kind: 'model'; provider?: string; id: string }

/** Urai nilai tersimpan: 'auto' | 'provider:id' | legacy bare id. */
export function parseSelection(value: string): ParsedSelection {
  if (!value || value === MODEL_AUTO) return { kind: 'auto' }
  const i = value.indexOf(':')
  if (i > 0) return { kind: 'model', provider: value.slice(0, i), id: value.slice(i + 1) }
  return { kind: 'model', id: value }
}

/** Bare model id untuk wire — auto → undefined (server pakai default). */
export function modelIdForServer(selection: string): string | undefined {
  const p = parseSelection(selection)
  return p.kind === 'auto' ? undefined : p.id
}

/** Model review internal (dipakai audit agent) — jangan tampil di picker. */
export function isReviewModel(m: { id: string }): boolean {
  return m.id.toLowerCase().includes('review')
}

/* 1 credit = $0,001 biaya LLM → credit per 1rb token = tarif USD/1Jt
   token (angka yang sama). Mis. luna $1/$6 per 1Jt = 1 credit masuk,
   6 credit keluar per 1rb token. Cocok dengan llm_prices
   (Rp18,30/109,80 per 1rb token, kurs Rp18.300). */
export function rateNote(m: Pick<PublicModel, 'rateInUsdPer1M' | 'rateOutUsdPer1M'>): string {
  const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, ''))
  if (m.rateInUsdPer1M === 0 && m.rateOutUsdPer1M === 0) return 'Gratis'
  if (m.rateInUsdPer1M === m.rateOutUsdPer1M) return `${fmt(m.rateInUsdPer1M)} credit / 1rb token`
  return `${fmt(m.rateInUsdPer1M)}–${fmt(m.rateOutUsdPer1M)} credit / 1rb token`
}

export function toPickerOptions(models: PublicModel[]): ModelOption[] {
  const opts: ModelOption[] = [
    { id: MODEL_AUTO, name: 'Auto', note: `Server memakai default (${MODEL_DEFAULT_ID})` },
  ]
  for (const m of models) {
    if (isReviewModel(m)) continue
    opts.push({
      id: selectionKey(m.provider, m.id),
      name: m.name ?? m.id,
      note: `${m.providerName} · ${rateNote(m)}${m.notes ? ` — ${m.notes}` : ''}`,
      provider: m.provider,
      modelId: m.id,
      available: true,
    })
  }
  return opts
}

/* Katalog lama — HANYA fallback bila endpoint gagal, supaya builder
   tidak mati total. Isinya sama seperti sebelum picker dinamis. */
export const FALLBACK_MODEL_CATALOG: ModelOption[] = [
  { id: 'auto', name: 'Auto', note: 'Selalu pilih model terbaik', available: true },
  { id: 'ag/claude-opus-5-5', name: 'Claude Opus 5.5', note: 'Model paling cerdas Anthropic', available: false },
  { id: 'ag/claude-sonnet-5-5', name: 'Claude Sonnet 5.5', note: 'Seimbang untuk kerja harian', available: false },
  { id: '9router:cx/gpt-6-luna', name: 'GPT-6 Luna', note: 'Kuat untuk coding & penalaran', modelId: 'cx/gpt-6-luna', available: true },
  { id: '9router:cx/gpt-5.6-luna', name: 'GPT-5.6 Luna', note: 'Cepat dan andal', modelId: 'cx/gpt-5.6-luna', available: true },
]

/** Apakah nilai tersimpan masih ada di daftar pilihan (auto selalu sah). */
export function isSelectionAvailable(selection: string, options: ModelOption[]): boolean {
  if (parseSelection(selection).kind === 'auto') return true
  const p = parseSelection(selection)
  if (p.kind !== 'model') return true
  return options.some((o) => {
    if (o.id === selection) return true
    const op = parseSelection(o.id)
    if (op.kind === 'model' && op.id === p.id) {
      /* Nilai legacy (bare id): cocok bila provider sama atau belum
         tentu — bila katalog punya ID itu, anggap tersedia. */
      if (!p.provider) return true
      return op.provider === p.provider
    }
    return false
  })
}

/* ---- Cache singkat daftar model (60 detik) + dedupe request ---- */

const CACHE_TTL_MS = 60_000
let cached: { at: number; options: ModelOption[] } | null = null
let inflight: Promise<PickerModelsResult> | null = null

export type PickerModelsResult = { options: ModelOption[]; fromFallback: boolean }

export function clearPickerModelsCache() {
  cached = null
}

/** Ambil daftar pilihan model; fallback ke katalog lama bila endpoint gagal. */
export async function getPickerModels(): Promise<PickerModelsResult> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { options: cached.options, fromFallback: false }
  }
  if (!inflight) {
    inflight = (async (): Promise<PickerModelsResult> => {
      try {
        const { models } = await api.llmModels()
        const options = toPickerOptions(models)
        cached = { at: Date.now(), options }
        return { options, fromFallback: false }
      } catch {
        /* Endpoint gagal — pakai katalog lama supaya picker tetap jalan. */
        return { options: FALLBACK_MODEL_CATALOG, fromFallback: true }
      } finally {
        inflight = null
      }
    })()
  }
  return inflight
}

/* ---- Klasifikasi error LLM (teks dari server, tanpa err.code) ---- */

export type ModelErrorInfo = {
  title: string
  hint: string
  /** 'settings' → tombol buka Pengaturan (pilih model lain); 'topup' → tombol Top-up. */
  action?: 'settings' | 'topup'
}

/** Cocokkan substring pesan error server → judul + pesan + aksi yang jelas. */
export function classifyModelError(content: string): ModelErrorInfo | null {
  if (content.includes('Credit habis')) {
    return {
      title: 'credit habis',
      hint: 'Saldo credit di bawah batas minimal untuk memakai AI.',
      action: 'topup',
    }
  }
  if (content.includes('Model nonaktif')) {
    return {
      title: 'model nonaktif',
      hint: 'Model ini dimatikan admin. Pilih model aktif lain di Pengaturan — pilihan lama otomatis kembali ke Auto.',
      action: 'settings',
    }
  }
  if (content.includes('Model tanpa tarif')) {
    return {
      title: 'model belum bisa dipakai',
      hint: 'Model ini belum punya tarif per token, jadi belum bisa dipakai. Pilih model lain atau hubungi admin untuk mengisi tarifnya.',
    }
  }
  if (content.includes('hanya mendukung endpoint /messages')) {
    return {
      title: 'model tidak didukung',
      hint: 'Model ini hanya mendukung endpoint /messages (Anthropic) dan butuh client yang belum dibangun. Pilih model chat-completions lain.',
    }
  }
  if (content.includes('API key provider')) {
    return {
      title: 'key provider belum terpasang',
      hint: 'Admin harus menempel API key provider ini di panel admin dulu sebelum modelnya bisa dipakai.',
    }
  }
  return null
}

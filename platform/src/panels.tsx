import { useEffect, useRef, useState } from 'react'
import { Button } from '@cloudflare/kumo/components/button'
import { Input } from '@cloudflare/kumo/components/input'
import { Switch } from '@cloudflare/kumo/components/switch'
import { Badge } from '@cloudflare/kumo/components/badge'
import { Tabs } from '@cloudflare/kumo/components/tabs'
import { Dialog } from '@cloudflare/kumo/components/dialog'
import { Icon, Activity, Spinner, useAutoScroll, useCopy } from './ui'
import { ActivityFeed, TerminalBlock, type ActivityEntry } from './activity'
import { api, type AuditFinding, type PlanStep, type ProjectSettings } from './api'
import {
  FALLBACK_MODEL_CATALOG,
  MODEL_AUTO,
  classifyModelError,
  getPickerModels,
  isSelectionAvailable,
  parseSelection,
  type ModelOption,
} from './models'

export type ChatItem = { role: string; content: string; id?: number }

/* Blok terminal & chip file yang muncul DI DALAM thread chat (ala Emergent:
   output perintah agent terlihat sebagai bagian percakapan, klik chip file
   membuka file tersebut di tab Kode). */
export type InlineEvent =
  | { kind: 'terminal'; title: string; log: string; ok: boolean }
  | { kind: 'file'; path: string; action: 'write' | 'delete' | 'mkdir' }

export function InlineEvents({ events, onOpenFile }: { events: InlineEvent[]; onOpenFile?: (path: string) => void }) {
  if (!events.length) return null
  return (
    <div className="flex flex-col gap-2">
      {events.map((e, i) =>
        e.kind === 'terminal' ? (
          <TerminalBlock key={i} title={e.title} log={e.log} ok={e.ok} />
        ) : (
          <button
            key={i}
            type="button"
            onClick={() => onOpenFile?.(e.path)}
            className="flex w-full items-center gap-2 rounded-lg border border-edge bg-surface px-3 py-2 text-left transition-colors hover:border-quiet"
            title={onOpenFile ? `Buka ${e.path} di tab Kode` : e.path}
          >
            <Icon name={e.action === 'delete' ? 'trash' : 'file'} size={12} className="shrink-0 text-quiet" />
            <span className="font-mono text-[10px] uppercase text-quiet">{e.action}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-body">{e.path}</span>
            {onOpenFile && <Icon name="open" size={11} className="shrink-0 text-quiet" />}
          </button>
        ),
      )}
    </div>
  )
}
export type ChatPlan = { ringkasan: string; langkah: PlanStep[]; berkas: string[]; asumsi: string[] }
export type ChatAudit = { nilai: number; temuan: AuditFinding[]; catatan: string }

/* Katalog model untuk picker gaya "Select model". Daftar ASLI diambil dari
   GET /api/llm/models (lihat models.ts — hanya model aktif bertarif, tanpa
   model review internal); konstanta ini HANYA fallback bila endpoint gagal,
   supaya builder tidak mati total. 'auto' berarti server memakai default-nya. */
export type { ModelOption } from './models'

export const MODEL_CATALOG: ModelOption[] = FALLBACK_MODEL_CATALOG

export function SettingsSheet({
  open,
  onClose,
  projectId,
  projectName,
  model,
  onModel,
  planMode,
  onPlanMode,
}: {
  open: boolean
  onClose: () => void
  projectId: string
  projectName: string
  model: string
  onModel: (id: string) => void
  planMode: boolean
  onPlanMode: (v: boolean) => void
}) {
  const [section, setSection] = useState<'menu' | 'model' | 'settings'>('menu')
  const [settings, setSettings] = useState<ProjectSettings | null>(null)
  const [loadErr, setLoadErr] = useState('')
  const [domain, setDomain] = useState('')
  const [secretKey, setSecretKey] = useState('')
  const [secretValue, setSecretValue] = useState('')
  const [msg, setMsg] = useState('')
  /* Picker model dinamis: daftar dari GET /api/llm/models (cache 60 dtk,
     fallback katalog lama bila endpoint gagal — lihat models.ts). */
  const [modelOptions, setModelOptions] = useState<ModelOption[]>(MODEL_CATALOG)
  const [modelsFallback, setModelsFallback] = useState(false)
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelNotice, setModelNotice] = useState('')
  const validatedRef = useRef('')

  const loadModels = async () => {
    setModelsLoading(true)
    try {
      const r = await getPickerModels()
      setModelOptions(r.options)
      setModelsFallback(r.fromFallback)
    } finally {
      setModelsLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return
    void loadModels()
  }, [open])

  useEffect(() => {
    if (!open || section !== 'model') return
    void loadModels()
  }, [open, section])

  /* Bila model tersimpan sudah tidak ada di daftar aktif (dimatikan admin),
     kembalikan ke 'auto' dengan pesan jelas — jangan kirim model mati ke
     server. Hanya saat daftar dari endpoint (bukan fallback). */
  useEffect(() => {
    if (!open || modelsFallback) return
    const key = `${model}|${modelOptions.map((o) => o.id).join(',')}`
    if (validatedRef.current === key) return
    validatedRef.current = key
    if (!isSelectionAvailable(model, modelOptions)) {
      onModel(MODEL_AUTO)
      setModelNotice(`Model tersimpan (${model}) sudah tidak aktif — kembali ke Auto.`)
    }
  }, [open, modelsFallback, model, modelOptions, onModel])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') (section !== 'menu' ? setSection('menu') : onClose())
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, section, onClose])

  useEffect(() => {
    if (!open || section !== 'settings' || !projectId) return
    setMsg('')
    api.settings(projectId)
      .then((s) => {
        setSettings(s)
        setDomain(s.customDomain)
        setLoadErr('')
      })
      .catch((e) => setLoadErr((e as Error).message))
  }, [open, section, projectId])

  if (!open) return null
  /* Cocokkan pilihan tersimpan: komposit 'provider:id' dulu, lalu bare id
     lama (legacy) — bila tak ada yang cocok, pakai Auto. */
  const parsedModel = parseSelection(model)
  const current =
    modelOptions.find((m) => m.id === model) ??
    (parsedModel.kind === 'model'
      ? modelOptions.find((m) => m.modelId === parsedModel.id)
      : undefined) ??
    modelOptions[0]

  const saveDomain = async () => {
    setMsg('')
    try {
      const r = await api.setDomain(projectId, domain)
      setDomain(r.customDomain)
      setMsg(r.customDomain ? 'Domain disimpan.' : 'Domain dihapus.')
    } catch (e) {
      setMsg((e as Error).message)
    }
  }

  /* ---------- GitHub sync ---------- */
  const [ghRepo, setGhRepo] = useState('')
  const [ghToken, setGhToken] = useState('')
  const [ghBranch, setGhBranch] = useState('main')
  const [ghBusy, setGhBusy] = useState(false)

  const saveGh = async () => {
    setMsg('')
    try {
      await api.setGithub(projectId, ghRepo.trim(), ghToken.trim(), ghBranch.trim() || 'main')
      setGhToken('')
      setMsg(ghRepo ? `Repo GitHub disimpan (${ghRepo}).` : 'Repo GitHub dihapus.')
    } catch (e) {
      setMsg((e as Error).message)
    }
  }

  const syncGh = async () => {
    setMsg('')
    setGhBusy(true)
    try {
      const r = await api.syncGithub(projectId, ghRepo.trim(), ghBranch.trim() || 'main', ghToken.trim())
      setGhToken('')
      setMsg(
        r.ok
          ? `Sinkron ke ${r.repo} (${r.branch}): ${r.pushed} file dikirim${r.skipped ? `, ${r.skipped} dilewati` : ''}.`
          : `Gagal sinkron: ${r.error ?? 'tidak diketahui'}`,
      )
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setGhBusy(false)
    }
  }

  const addSecret = async () => {
    setMsg('')
    try {
      await api.setSecret(projectId, secretKey.trim(), secretValue)
      const s = await api.settings(projectId)
      setSettings(s)
      setSecretKey('')
      setSecretValue('')
      setMsg('Secret disimpan. Nilai tidak ditampilkan lagi.')
    } catch (e) {
      setMsg((e as Error).message)
    }
  }

  const removeSecret = async (key: string) => {
    setMsg('')
    try {
      await api.deleteSecret(projectId, key)
      const s = await api.settings(projectId)
      setSettings(s)
    } catch (e) {
      setMsg((e as Error).message)
    }
  }

  const back = section !== 'menu'

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/55" onClick={onClose} role="dialog" aria-label="Pengaturan sesi">
      <div
        onClick={(e) => e.stopPropagation()}
        className="vb-enter vb-card flex max-h-[86dvh] w-full max-w-[420px] flex-col px-4 pb-6 pt-4 max-md:px-3"
      >
        <div className="mb-2 flex items-center justify-between">
          {back ? (
            <button onClick={() => setSection('menu')} className="flex h-8 w-8 items-center justify-center text-quiet hover:text-body" aria-label="Kembali">
              <Icon name="back" size={14} />
            </button>
          ) : (
            <h2 className="font-display text-[16px] text-body">Pengaturan</h2>
          )}
          <span className="flex-1 truncate px-2 text-center text-[12.5px] text-body">
            {section === 'model' ? 'Pilih model' : section === 'settings' ? 'Kelola website' : ''}
          </span>
          <button onClick={onClose} aria-label="Tutup pengaturan" className="flex h-8 w-8 items-center justify-center text-quiet hover:text-body">
            <Icon name="close" size={14} />
          </button>
        </div>

        {section === 'menu' && (
          <div className="flex flex-col">
            <div className="border-b border-edge py-2">
              <p className="vb-eyebrow px-3">SCREENSHOT</p>
              <button
                onClick={async () => {
                  setMsg('')
                  try {
                    const r = await api.screenshot(projectId)
                    setMsg(`Screenshot tersimpan: ${r.screenshot.name} (${Math.round(r.screenshot.bytes / 1024)} KB)`)
                  } catch (e) {
                    setMsg((e as Error).message)
                  }
                }}
                className="mt-1 flex min-h-[44px] w-full items-center justify-between px-3 text-left transition-colors hover:bg-surface-muted"
              >
                <span>
                  <span className="block text-[12.5px] text-body">Ambil screenshot preview</span>
                  <span className="block text-[11px] text-quiet">Simpan tampilan terbaru proyek</span>
                </span>
                <Icon name="camera" size={14} className="text-quiet" />
              </button>
              {msg && <p className="mx-3 mt-2 border-l-2 border-edge pl-2 text-[12px] text-body">{msg}</p>}
            </div>
            <MenuRow label="Model" sub={`${current.name} — ${current.note}`} onClick={() => setSection('model')} />
            <MenuRow label="Kelola website" sub="Domain, secrets, ringkasan proyek" onClick={() => setSection('settings')} />
            <ToggleRow
              label="Plan mode"
              hint="Rencana kerja ditampilkan dulu sebelum kode ditulis"
              checked={planMode}
              onChange={onPlanMode}
            />
            <div className="border-b border-edge py-2 opacity-50">
              <p className="text-[12.5px] text-body">Fork</p>
              <p className="text-[11px] text-quiet">Belum tersedia di deploy ini.</p>
            </div>
          </div>
        )}

        {section === 'model' && (
          <div className="vb-scroll overflow-y-auto">
            {modelNotice && <p className="mb-2 border-l-2 border-accent pl-2 text-[12px] text-body">{modelNotice}</p>}
            {modelsFallback && (
              <p className="mb-2 border-l-2 border-edge pl-2 text-[12px] text-quiet">
                Daftar model gagal dimuat — menampilkan daftar terakhir.
              </p>
            )}
            {modelsLoading && <p className="mb-2 text-[11.5px] text-quiet">Memuat daftar model…</p>}
            <div className="flex flex-col">
              {modelOptions.map((m) => {
                const active = m.id === model || (parsedModel.kind === 'model' && m.modelId === parsedModel.id)
                const disabled = m.available === false
                return (
                  <button
                    key={m.id}
                    disabled={disabled}
                    onClick={() => {
                      setModelNotice('')
                      onModel(m.id)
                      setSection('menu')
                    }}
                    className={`flex min-h-[52px] items-center justify-between border-b border-edge py-2 text-left transition-colors ${
                      disabled ? 'cursor-not-allowed opacity-40' : 'hover:bg-surface-muted'
                    }`}
                  >
                    <span>
                      <span className="block text-[12.5px] text-body">{m.name}</span>
                      <span className="block text-[11px] text-quiet">
                        {m.note}
                        {disabled ? ' — sedang tidak tersedia di gateway' : ''}
                      </span>
                    </span>
                    {active && <Icon name="check" size={13} className="shrink-0 text-accent" />}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {section === 'settings' && (
          <div className="vb-scroll overflow-y-auto">
            {loadErr && <p className="mb-2 border-l-2 border-accent pl-2 text-[12px] text-accent">{loadErr}</p>}
            {msg && <p className="mb-2 border-l-2 border-edge pl-2 text-[12px] text-body">{msg}</p>}

            <section className="border-b border-edge py-3">
              <p className="text-[11px] font-medium text-accent">OVERVIEW</p>
              {settings ? (
                <ul className="mt-1.5 space-y-1 text-[12px] text-body">
                  <li>Nama: {settings.overview.name}</li>
                  <li>Status: {settings.overview.status} · {settings.overview.files} file</li>
                  <li>Publish: {settings.overview.slug ? settings.overview.slug : 'belum diterbitkan'}</li>
                </ul>
              ) : (
                <p className="mt-1 text-[11.5px] text-quiet">Memuat ringkasan…</p>
              )}
            </section>

            <section className="border-b border-edge py-3">
              <p className="text-[11px] font-medium text-accent">DOMAIN</p>
              <p className="mt-1 text-[11px] leading-relaxed text-quiet">
                Arahkan domain ke {PUBLIC_HINT}. DNS A record ke server ini.
              </p>
              <div className="mt-2 flex items-end gap-2">
                <label className="sr-only" htmlFor="vb-domain">Custom domain</label>
                <Input
                  id="vb-domain"
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  placeholder="app.contoh.com"
                  size="sm"
                  className="min-w-0 flex-1"
                />
                <Button variant="outline" size="sm" onClick={saveDomain} className="shrink-0">
                  Simpan
                </Button>
              </div>
            </section>

            <section className="border-b border-edge py-3">
              <p className="text-[11px] font-medium text-accent">GITHUB</p>
              <p className="mt-1 text-[11px] leading-relaxed text-quiet">
                Sinkronkan seluruh file proyek ke repo GitHub. Format repo <code>owner/repo</code>; token PAT butuh scope <code>repo</code>. Repo dibuat otomatis bila belum ada.
              </p>
              <div className="mt-2 flex flex-col gap-2">
                <Input
                  value={ghRepo}
                  onChange={(e) => setGhRepo(e.target.value)}
                  placeholder="username/nama-repo"
                  aria-label="Repo GitHub"
                  size="sm"
                  className="w-full font-mono"
                />
                <div className="flex items-end gap-2">
                  <Input
                    value={ghBranch}
                    onChange={(e) => setGhBranch(e.target.value)}
                    placeholder="main"
                    aria-label="Branch"
                    size="sm"
                    className="min-w-0 w-24"
                  />
                  <Input
                    type="password"
                    value={ghToken}
                    onChange={(e) => setGhToken(e.target.value)}
                    placeholder={settings?.secrets.some((s) => s.key === 'GITHUB_TOKEN') ? 'token tersimpan ••••' : 'token PAT'}
                    aria-label="Token GitHub"
                    size="sm"
                    className="min-w-0 flex-1 font-mono"
                  />
                </div>
                <div className="flex items-end gap-2">
                  <Button variant="outline" size="sm" onClick={saveGh} disabled={!ghRepo.trim()}>
                    Simpan
                  </Button>
                  <Button variant="primary" size="sm" onClick={syncGh} disabled={!ghRepo.trim() || ghBusy}>
                    {ghBusy ? 'Menyinkron…' : 'Sinkron'}
                  </Button>
                </div>
              </div>
            </section>

            <section className="py-3">
              <p className="text-[11px] font-medium text-accent">SECRETS</p>
              <p className="mt-1 text-[11px] leading-relaxed text-quiet">
                Disuntikkan sebagai environment variable ke preview aplikasi. Nilai tidak pernah ditampilkan lagi.
              </p>
              {settings?.secrets.length ? (
                <ul className="mt-2 flex flex-col gap-1">
                  {settings.secrets.map((s) => (
                    <li key={s.key} className="flex items-center justify-between border border-edge px-2 py-1.5">
                      <span className="font-mono text-[11.5px] text-body">
                        {s.key} <span className="text-quiet">{s.hint}</span>
                      </span>
                      <button onClick={() => removeSecret(s.key)} aria-label={`Hapus ${s.key}`} className="text-[11px] text-quiet hover:text-accent">
                        hapus
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                settings && <p className="mt-2 text-[11.5px] text-quiet">Belum ada secret.</p>
              )}
              <div className="mt-2 flex flex-col gap-2">
                <Input
                  value={secretKey}
                  onChange={(e) => setSecretKey(e.target.value)}
                  placeholder="NAMA_ENV"
                  aria-label="Nama secret"
                  size="sm"
                  className="w-full font-mono"
                />
                <div className="flex items-end gap-2">
                  <Input
                    type="password"
                    value={secretValue}
                    onChange={(e) => setSecretValue(e.target.value)}
                    placeholder="nilai"
                    aria-label="Nilai secret"
                    size="sm"
                    className="min-w-0 flex-1"
                  />
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={addSecret}
                    disabled={!secretKey.trim() || !secretValue}
                    className="shrink-0"
                  >
                    Tambah
                  </Button>
                </div>
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  )
}

const PUBLIC_HINT = typeof import.meta.env.VITE_PUBLIC_ORIGIN === 'string' && import.meta.env.VITE_PUBLIC_ORIGIN
  ? String(import.meta.env.VITE_PUBLIC_ORIGIN).replace(/^https?:\/\//, '')
  : 'server platform'

function MenuRow({ label, sub, onClick }: { label: string; sub: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex min-h-[48px] items-center justify-between border-b border-edge py-2 text-left transition-colors hover:bg-surface-muted">
      <span>
        <span className="block text-[12.5px] text-body">{label}</span>
        <span className="block text-[11px] text-quiet">{sub}</span>
      </span>
      <Icon name="arrow" size={12} className="text-quiet" />
    </button>
  )
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string
  hint: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <div className={`flex min-h-[48px] items-center justify-between gap-3 border-b border-edge py-2 ${disabled ? 'opacity-50' : ''}`}>
      <span>
        <span className="block text-[12.5px] text-body">{label}</span>
        <span className="block text-[11px] text-quiet">{hint}</span>
      </span>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} aria-label={label} />
    </div>
  )
}

export function ChatPanel({
  messages,
  sending,
  status,
  plan,
  audit,
  streamText,
  activity,
  onSend,
  onCancel,
  onConfirmPlan,
  onCancelPlan,
  awaitingConfirm,
  onOpenSettings,
  waitingForDiscovery,
  inlineEvents,
  onOpenFile,
  previewOpen,
  previewUrl,
}: {
  messages: ChatItem[]
  sending: boolean
  status: string
  plan: ChatPlan | null
  audit: ChatAudit | null
  streamText?: string
  activity?: ActivityEntry[]
  onSend: (text: string) => void
  onCancel: () => void
  onConfirmPlan?: () => void
  onCancelPlan?: () => void
  awaitingConfirm?: boolean
  onOpenSettings: () => void
  waitingForDiscovery: boolean
  inlineEvents?: InlineEvent[]
  onOpenFile?: (path: string) => void
  previewOpen?: boolean
  previewUrl?: string
}) {
  const [input, setInput] = useState('')
  const [attached, setAttached] = useState<{ name: string; content: string }[]>([])
  const [expanded, setExpanded] = useState(false)
  const [recording, setRecording] = useState(false)
  const scrollRef = useAutoScroll(messages.length + (streamText?.length ?? 0) + (activity?.length ?? 0))
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const speechRef = useRef<{ stop: () => void } | null>(null)

  useEffect(() => () => speechRef.current?.stop(), [])

  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 168)}px`
  }, [input])

  const submit = () => {
    if ((!input.trim() && !attached.length) || sending) return
    const fileContext = attached.map((f) => `\n\n--- Attached file: ${f.name} ---\n${f.content}`).join('')
    onSend(`${input.trim()}${fileContext}`.trim())
    setInput('')
    setAttached([])
  }

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return
    const allowed = new Set(['txt', 'md', 'mdx', 'json', 'csv', 'ts', 'tsx', 'js', 'jsx', 'css', 'html', 'xml', 'yaml', 'yml', 'sql', 'py', 'go', 'rs', 'sh', 'toml', 'env', 'log'])
    const next: { name: string; content: string }[] = []
    for (const file of Array.from(files)) {
      const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
      if (!allowed.has(ext) || file.size > 256 * 1024) continue
      next.push({ name: file.name, content: await file.text() })
    }
    if (next.length) setAttached((prev) => [...prev, ...next].slice(0, 5))
  }

  const toggleVoice = () => {
    const w = window as Window & { SpeechRecognition?: new () => any; webkitSpeechRecognition?: new () => any }
    if (recording) {
      speechRef.current?.stop()
      speechRef.current = null
      setRecording(false)
      return
    }
    const Recognition = w.SpeechRecognition ?? w.webkitSpeechRecognition
    if (!Recognition) return
    const rec = new Recognition()
    rec.lang = 'id-ID'
    rec.interimResults = true
    rec.continuous = false
    rec.onresult = (event: any) => {
      const transcript = Array.from(event.results as ArrayLike<any>).map((r: any) => r[0]?.transcript ?? '').join('')
      setInput((prev) => `${prev}${prev ? ' ' : ''}${transcript}`)
    }
    rec.onend = () => { speechRef.current = null; setRecording(false) }
    rec.onerror = () => { speechRef.current = null; setRecording(false) }
    speechRef.current = rec
    setRecording(true)
    rec.start()
  }

  return (
    <>
      <div ref={scrollRef} className="vb-scroll flex-1 overflow-y-auto px-3 py-4 md:px-5">
        {!messages.length ? (
          <Welcome onPick={(s) => setInput(s)} />
        ) : (
          <div className="mx-auto flex max-w-[640px] flex-col gap-5">
            {messages.map((m, i) => (
              <Bubble
                key={m.id ?? i}
                role={m.role}
                content={m.content}
                isLast={i === messages.length - 1}
                previewOpen={previewOpen}
                previewUrl={previewUrl}
                onOpenSettings={onOpenSettings}
              />
            ))}
            {sending && (
              <div className="vb-enter flex flex-col gap-2.5 text-[12px] text-quiet">
                <ActivityFeed entries={activity ?? []} />
                <InlineEvents events={inlineEvents ?? []} onOpenFile={onOpenFile} />
                {status && (
                  <div className="flex items-center gap-2"><Activity /><span>{status}</span></div>
                )}
                {plan && <PlanCard plan={plan} />}
                {audit && <AuditCard audit={audit} />}
                {streamText ? (
                  <div className="rounded-lg border border-edge bg-surface px-3.5 py-3 text-[13px] leading-relaxed text-body">
                    <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-quiet">VibeBuilder</p>
                    <p className="whitespace-pre-wrap">{streamText}<span className="vb-caret ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-accent align-middle" /></p>
                  </div>
                ) : null}
              </div>
            )}
            {/* Gerbang konfirmasi di luar container `sending`: saat run berhenti
                untuk menunggu persetujuan, sending=false lalu container tadi
                di-unmount. Blok ini harus tetap hidup agar tombol tampil. */}
            {!sending && plan && awaitingConfirm && (
              <div className="vb-enter mx-auto flex max-w-[640px] flex-col gap-2.5">
                <PlanCard plan={plan} />
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={onConfirmPlan}
                    className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90"
                  >
                    Setujui &amp; bangun
                  </button>
                  <button
                    type="button"
                    onClick={onCancelPlan}
                    className="rounded-md border border-edge px-3 py-1.5 text-[12px] font-medium text-body transition-colors hover:bg-surface-muted"
                  >
                    Batalkan
                  </button>
                  <span className="text-[11.5px] text-quiet">Agent menunggu sebelum menulis file</span>
                </div>
              </div>
            )}
            {!sending && audit && <AuditCard audit={audit} />}
            {!sending && audit && audit.temuan.length > 0 && (
              <SuggestionsCard audit={audit} onSend={onSend} />
            )}
          </div>
        )}
      </div>

      <div className="shrink-0 bg-ink px-3 pb-[max(10px,env(safe-area-inset-bottom))] pt-2.5 md:px-5 md:pb-4">
        <div className="mx-auto max-w-[720px]">
          <div className="overflow-hidden rounded-[22px] border border-edge bg-surface transition-colors focus-within:border-quiet focus-within:ring-1 focus-within:ring-edge">
            {expanded && (
              <div className="flex items-center justify-between gap-3 bg-ink px-3 py-2 text-[11px] text-quiet">
                <span>Instruksi lebih panjang. Atur model atau mode dari setelan.</span>
                <button type="button" onClick={onOpenSettings} className="shrink-0 font-medium text-accent hover:underline">Model &amp; mode</button>
              </div>
            )}
            {attached.length > 0 && (
              <div className="flex flex-wrap gap-1.5 px-3 pt-2">
                {attached.map((file, i) => (
                  <span key={`${file.name}-${i}`} className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-edge bg-ink px-2 py-1 text-[10.5px] text-body">
                    <Icon name="file" size={11} /><span className="max-w-[150px] truncate">{file.name}</span>
                    <button type="button" aria-label={`Hapus ${file.name}`} onClick={() => setAttached((prev) => prev.filter((_, n) => n !== i))} className="text-quiet hover:text-body">×</button>
                  </span>
                ))}
              </div>
            )}
            <label htmlFor="vb-prompt" className="sr-only">Instruksi untuk agent</label>
            <textarea
              id="vb-prompt"
              ref={taRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  submit()
                }
              }}
              rows={expanded ? 4 : 2}
              placeholder={waitingForDiscovery ? 'Jawab pertanyaan agent…' : sending ? 'Waiting for your next message' : 'Tanyakan apa saja atau jelaskan perubahan yang kamu inginkan…'}
              className={`vb-scroll w-full resize-none bg-transparent px-4 py-3 text-[14px] leading-relaxed text-body outline-none placeholder:text-quiet ${expanded ? 'max-h-[300px]' : 'max-h-[168px]'}`}
              aria-label="Pesan untuk agent"
            />
            <input ref={fileRef} type="file" multiple hidden accept=".txt,.md,.mdx,.json,.csv,.ts,.tsx,.js,.jsx,.css,.html,.xml,.yaml,.yml,.sql,.py,.go,.rs,.sh,.toml,.env,.log" onChange={(e) => { void addFiles(e.currentTarget.files); e.currentTarget.value = '' }} />
            <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5">
              <div className="flex items-center gap-0.5">
                <button type="button" onClick={() => fileRef.current?.click()} disabled={sending || attached.length >= 5} aria-label="Lampirkan file teks atau kode" title="Lampirkan file teks/kode (maks. 5 file, 256 KB per file)" className="flex h-9 w-9 items-center justify-center rounded-full text-quiet hover:bg-surface-muted hover:text-body disabled:opacity-40"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m8 12.5 6.2-6.2a3.2 3.2 0 0 1 4.5 4.5l-8.4 8.4a5 5 0 0 1-7.1-7.1l8.3-8.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg></button>
                <button type="button" onClick={onOpenSettings} aria-label="Setelan sesi dan model" title="Setelan sesi dan model" className="flex h-9 w-9 items-center justify-center rounded-full text-quiet hover:bg-surface-muted hover:text-body"><Icon name="rule" size={15} /></button>
                <button type="button" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded} aria-label={expanded ? 'Ciutkan composer' : 'Perluas composer'} title={expanded ? 'Ciutkan' : 'Perluas'} className="flex h-9 w-9 items-center justify-center rounded-full text-quiet hover:bg-surface-muted hover:text-body">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d={expanded ? 'M8 3v5H3M16 21v-5h5M21 8h-5V3M3 16h5v5' : 'M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
              </div>
              <div className="flex items-center gap-1.5">
                <button type="button" onClick={toggleVoice} disabled={sending || !(('SpeechRecognition' in window) || ('webkitSpeechRecognition' in window))} aria-label={recording ? 'Hentikan dikte' : 'Dikte suara'} title={(('SpeechRecognition' in window) || ('webkitSpeechRecognition' in window)) ? (recording ? 'Hentikan dikte' : 'Dikte suara') : 'Dikte suara tidak didukung browser ini'} className={`flex h-9 w-9 items-center justify-center rounded-full text-quiet hover:bg-surface-muted hover:text-body disabled:opacity-35 ${recording ? 'bg-red-50 text-red-600' : ''}`}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3" stroke="currentColor" strokeWidth="1.8"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 18v3m-4 0h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg></button>
                {sending ? (
                  <Button variant="outline" size="sm" onClick={onCancel} aria-label="Hentikan proses agent" className="h-9 rounded-full px-3"><Icon name="stop" size={10} /> Hentikan</Button>
                ) : (
                  <Button variant="primary" size="sm" shape="circle" onClick={submit} disabled={!input.trim() && !attached.length} aria-label="Kirim pesan" title="Kirim pesan" className="h-9 w-9 min-w-9 rounded-full p-0"><Icon name="arrow" size={15} /></Button>
                )}
              </div>
            </div>
          </div>
          {attached.length > 0 && <p className="px-2 pt-1 text-[10px] text-quiet">File teks/kode akan ikut dikirim sebagai konteks prompt.</p>}
        </div>
      </div>
    </>
  )
}

function SuggestionsCard({ audit, onSend }: { audit: ChatAudit; onSend: (text: string) => void }) {
  // Hanya muncul kalau AI punya saran lanjutan (temuan audit). Kalau tidak ada
  // temuan, kartu ini tidak dirender sama sekali — bukan disembunyikan.
  const order: Record<string, number> = { kritis: 0, penting: 1, ringan: 2 }
  const items = [...audit.temuan]
    .sort((a, b) => (order[a.tingkat] ?? 3) - (order[b.tingkat] ?? 3))
    .slice(0, 3)
  if (!items.length) return null
  return (
    <section aria-label="Saran lanjutan dari AI" className="rounded-lg border border-edge bg-surface px-3.5 py-3 text-body">
      <p className="text-[11px] font-medium uppercase tracking-wide text-quiet">Saran lanjutan</p>
      <ul className="mt-2 flex flex-col gap-1">
        {items.map((f, i) => (
          <li key={`${f.berkas}-${f.baris}-${i}`}>
            <button
              type="button"
              onClick={() => onSend(`Perbaiki: ${f.perbaikan} (${f.berkas}:${f.baris})`)}
              title="Kirim sebagai instruksi berikutnya"
              className="flex w-full items-start gap-2 rounded-md px-1 py-1.5 text-left hover:bg-surface-muted"
            >
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-edge text-[14px] leading-none text-accent" aria-hidden="true">+</span>
              <span className="min-w-0">
                <span className="block text-[12.5px] leading-snug">{f.masalah}</span>
                <span className="mt-0.5 block font-mono text-[10px] text-quiet">{f.berkas}:{f.baris} · {f.tingkat}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

function PlanCard({ plan }: { plan: ChatPlan }) {
  return (
    <section aria-label="Rencana kerja AI" className="rounded-lg border border-edge bg-surface px-3.5 py-3 text-body">
      <p className="text-[11px] font-medium uppercase tracking-wide text-quiet">Rencana kerja</p>
      <p className="mt-1 text-[12.5px] leading-relaxed">{plan.ringkasan}</p>
      {!!plan.langkah.length && <ol className="mt-2 flex flex-col gap-1.5">
        {plan.langkah.map((step, i) => <li key={`${step.judul}-${i}`} className="flex gap-2 text-[11.5px] leading-relaxed">
          <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-edge font-mono text-[10px] text-accent">{i + 1}</span>
          <span><strong className="font-medium">{step.judul}</strong><span className="text-quiet"> — {step.detail}</span></span>
        </li>)}
      </ol>}
      {!!plan.asumsi.length && <p className="mt-2 border-t border-edge pt-2 text-[11px] leading-relaxed text-quiet">Asumsi: {plan.asumsi.join(' · ')}</p>}
      {!!plan.berkas.length && <p className="mt-1 truncate font-mono text-[10px] text-quiet" title={plan.berkas.join(', ')}>Berkas: {plan.berkas.join(' · ')}</p>}
    </section>
  )
}

function AuditCard({ audit }: { audit: ChatAudit }) {
  const [open, setOpen] = useState(false)
  const critical = audit.temuan.filter((x) => x.tingkat === 'kritis').length
  const important = audit.temuan.filter((x) => x.tingkat === 'penting').length
  return (
    <section aria-label="Laporan tinjauan kode" className="rounded-lg border border-edge bg-surface px-3.5 py-3 text-body">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <p className="text-[11px] font-medium uppercase tracking-wide text-quiet">Tinjauan kode</p>
            <Badge variant={critical ? 'red' : 'green'}>{audit.nilai}/100</Badge>
          </div>
          <p className="mt-1 text-[11.5px] leading-relaxed">{audit.catatan}</p>
        </div>
        <span className="shrink-0 font-mono text-[11px] text-quiet">{audit.temuan.length} temuan</span>
      </div>
      <p className="mt-2 text-[10.5px] text-quiet">{critical} kritis · {important} penting · {audit.temuan.length - critical - important} ringan</p>
      {!!audit.temuan.length && (
        <Button variant="ghost" size="xs" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="mt-2">
          {open ? 'Sembunyikan rincian' : 'Lihat rincian'}
        </Button>
      )}
      {open && <ul className="mt-2 flex flex-col gap-2 border-t border-edge pt-2">{audit.temuan.map((finding, i) => <li key={`${finding.berkas}-${finding.baris}-${i}`} className="text-[11px] leading-relaxed">
        <p className="font-medium">{finding.tingkat} · {finding.kategori}</p><p className="font-mono text-[10px] text-quiet">{finding.berkas}:{finding.baris}</p>
        <p>{finding.masalah}</p><p className="text-quiet">Perbaikan: {finding.perbaikan}</p>
      </li>)}</ul>}
    </section>
  )
}

function Welcome({ onPick }: { onPick: (s: string) => void }) {
  const samples = [
    { title: 'Papan tugas', body: 'kolom backlog, dikerjakan, selesai; geser kartu antar kolom' },
    { title: 'Pencatat pengeluaran', body: 'tambah transaksi, filter per bulan, total per kategori' },
    { title: 'Katalog resep', body: 'daftar resep dengan pencarian bahan dan langkah masak' },
  ]

  return (
    <div className="vb-enter mx-auto max-w-[640px] pt-6 md:pt-10">
      <div className="inline-flex items-center gap-2 rounded-full border border-edge bg-surface px-2.5 py-1">
        <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
        <span className="text-[11px] font-medium text-quiet">VibeBuilder</span>
      </div>
      <h2 className="mt-3 text-[20px] font-semibold leading-snug tracking-tight text-body md:text-[24px]">
        Tulis satu kalimat, agent menulis aplikasinya
      </h2>
      <p className="mt-2 max-w-[46ch] text-[13px] leading-relaxed text-quiet">
        File ditulis langsung ke workspace proyek, di-build, lalu tampil di panel kanan.
        Kalau permintaannya terlalu luas untuk ditebak, agent bertanya dulu.
      </p>

      <div className="mt-6">
        <p className="text-[11px] font-medium uppercase tracking-wide text-quiet">Mulai dari salah satu</p>
        <div className="mt-2.5 grid gap-2 sm:grid-cols-3">
          {samples.map((s) => (
            <button
              key={s.title}
              onClick={() => onPick(`Buat ${s.title.toLowerCase()}: ${s.body}.`)}
              className="group flex min-h-[64px] flex-col justify-center rounded-lg border border-edge bg-surface px-3 py-2.5 text-left transition-colors hover:border-accent"
            >
              <span className="text-[12.5px] font-medium text-body">{s.title}</span>
              <span className="mt-0.5 text-[11.5px] leading-snug text-quiet">{s.body}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function Bubble({
  role,
  content,
  isLast = false,
  previewOpen = false,
  previewUrl = '',
  onOpenSettings,
}: {
  role: string
  content: string
  isLast?: boolean
  previewOpen?: boolean
  previewUrl?: string
  onOpenSettings?: () => void
}) {
  const { copied, copy } = useCopy()
  const [zoomed, setZoomed] = useState(false)
  const match = role === 'assistant' ? content.match(/!\[([^\]]*)\]\((\/api\/projects\/[^)\s]+)\)/) : null
  const text = match ? content.replace(match[0], '').trim() : content

  if (role === 'user') {
    return (
      <div className="vb-enter flex flex-col items-end gap-1">
        <span className="text-[11px] text-quiet">kamu</span>
        <div className="max-w-[92%] rounded-xl rounded-br-sm bg-accent px-3.5 py-2.5 text-[13.5px] leading-relaxed text-white">
          {content}
        </div>
      </div>
    )
  }

  if (role === 'error') {
    /* Error LLM sampai ke UI hanya sebagai TEKS — cocokkan substring
       (classifyModelError di models.ts): 'Credit habis' + empat pesan
       model baru dari server (nonaktif / tanpa tarif / messages-only /
       key provider belum terpasang). */
    const info = classifyModelError(content)
    return (
      <div className="vb-enter rounded-lg border border-edge border-l-2 border-l-accent bg-surface px-3.5 py-2.5">
        <p className="text-[11px] font-medium text-accent">{info?.title ?? 'agent gagal'}</p>
        <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-body">{content}</p>
        {info?.hint && <p className="mt-1 text-[12px] leading-relaxed text-quiet">{info.hint}</p>}
        {info?.action === 'topup' && (
          <a
            href="/topup"
            className="mt-2.5 inline-flex h-8 items-center gap-1.5 rounded-full bg-accent px-3.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90"
          >
            Top-up credit
          </a>
        )}
        {info?.action === 'settings' && onOpenSettings && (
          <button
            type="button"
            onClick={onOpenSettings}
            className="mt-2.5 inline-flex h-8 items-center gap-1.5 rounded-full bg-accent px-3.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90"
          >
            Pilih model lain
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="vb-enter group">
      <div className="flex items-center gap-2">
        <span className="flex h-5 w-5 items-center justify-center rounded bg-accent font-mono text-[10px] font-bold text-white" aria-hidden="true">V</span>
        <span className="text-[11px] font-medium text-body">VibeBuilder</span>
      </div>
      <div className="mt-1.5 whitespace-pre-wrap text-[13.5px] leading-relaxed text-body">{text}</div>
      {match && (
        <button type="button" onClick={() => setZoomed(true)} className="mt-2 block max-w-full overflow-hidden rounded-lg border border-edge bg-ink" aria-label="Lihat screenshot">
          <img src={match[2]} alt={match[1] || 'Screenshot preview'} className="block max-h-64 w-full object-cover" loading="lazy" />
        </button>
      )}
      {zoomed && match && (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setZoomed(false)}>
          <div className="max-h-full max-w-full" onClick={(e) => e.stopPropagation()}>
            <img src={match[2]} alt={match[1] || 'Screenshot preview'} className="max-h-[80vh] max-w-full rounded-lg border border-edge" />
            <button type="button" onClick={() => setZoomed(false)} className="mt-2 text-[12px] text-white/80 hover:text-white">Tutup</button>
          </div>
        </div>
      )}
      {role === 'assistant' && isLast && previewOpen && previewUrl && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <a
            href={previewUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-full border border-edge bg-surface px-3 py-1.5 text-[11.5px] text-body transition-colors hover:border-quiet"
          >
            <Icon name="open" size={11} />
            Buka preview
          </a>
          <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-edge bg-surface px-3 py-1.5 font-mono text-[11px] text-quiet">
            <i className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden="true" />
            <span className="truncate">{previewUrl}</span>
          </span>
        </div>
      )}
      <button
        onClick={() => copy(content)}
        className="mt-1 flex h-6 items-center gap-1 text-[11px] text-quiet opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
      >
        <Icon name="copy" size={10} />
        {copied ? 'tersalin' : 'salin'}
      </button>
    </div>
  )
}

export type VisualTarget = {
  tag: string
  label: string
  selector: string
  text: string
  x: number
  y: number
  width: number
  height: number
}

export function PreviewPane({
  previewOn,
  previewPort,
  projectId,
  dirty,
  buildLog,
  onRun,
  booting,
  hasFiles,
  onPick,
}: {
  previewOn: boolean
  previewPort: number
  projectId: string
  dirty: boolean
  buildLog: { ok: boolean; log: string } | null
  onRun: () => void
  booting: boolean
  hasFiles: boolean
  onPick: (target: VisualTarget) => void
}) {
  const [reloadKey, setReloadKey] = useState(0)
  const [picking, setPicking] = useState(false)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  // Proxy same-origin: bridge bisa postMessage ke parent, dan preview tetap
  // terlindungi ownership check. Query __vbEditor=1 menandai HTML editor.
  const url = `/api/projects/${projectId}/live/?__vbEditor=1`

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { source?: string; type?: string; payload?: VisualTarget }
      if (data?.source !== 'vb-visual-bridge' || data.type !== 'vb:pick' || !data.payload) return
      if (e.source !== frameRef.current?.contentWindow) return
      setPicking(false)
      onPick(data.payload)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [onPick])

  const togglePick = () => {
    const next = !picking
    setPicking(next)
    frameRef.current?.contentWindow?.postMessage(
      { source: 'vb-editor', type: next ? 'vb:start-pick' : 'vb:stop-pick' }, '*')
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 max-md:h-12 shrink-0 items-center gap-2 border-b border-edge bg-surface px-3">
        <span className="text-[11px] text-quiet">preview</span>
        <span className="min-w-0 flex-1 truncate border border-edge bg-ink px-2 py-0.5 font-mono text-[11px] text-quiet">
          {previewOn ? url : 'belum berjalan'}
        </span>
        {dirty && previewOn && <span className="text-[11px] text-accent">versi lama</span>}
        <button
          onClick={() => setReloadKey((k) => k + 1)}
          disabled={!previewOn}
          aria-label="Muat ulang preview"
          className="flex h-6 w-6 items-center justify-center text-quiet transition-colors hover:text-body disabled:opacity-40"
        >
          <Icon name="reload" size={12} />
        </button>
        <button
          onClick={togglePick}
          disabled={!previewOn}
          aria-pressed={picking}
          aria-label="Pilih elemen di preview"
          className={`h-6 shrink-0 border px-2 text-[10.5px] transition-colors disabled:opacity-40 ${
            picking ? 'border-accent bg-accent text-on-accent' : 'border-edge text-quiet hover:text-body'
          }`}
        >
          {picking ? 'Klik elemen…' : 'Pilih elemen'}
        </button>
      </div>

      <div className="relative min-h-0 flex-1 bg-ink">
        {previewOn ? (
          <iframe
            ref={frameRef}
            key={reloadKey}
            src={url}
            title="Preview aplikasi yang dibangun"
            className={`h-full w-full border-0 bg-white ${picking ? 'cursor-crosshair' : ''}`}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          />
        ) : (
          <div className="flex h-full items-center justify-center px-6">
            <div className="max-w-[36ch]">
              <p className="font-display text-[16px] leading-snug text-body">
                {booting
                  ? 'Build sedang berjalan'
                  : hasFiles
                    ? 'Kode sudah ada, preview belum dinyalakan'
                    : 'Belum ada kode di proyek ini'}
              </p>
              <p className="mt-1.5 text-[12px] leading-relaxed text-quiet">
                {booting
                  ? 'Agent menulis file lalu menjalankan build. Preview muncul sendiri setelah build lolos.'
                  : hasFiles
                    ? 'Tekan Jalankan untuk build dan menyajikan aplikasi di port lokal.'
                    : 'Kirim instruksi di panel kiri. File pertama akan muncul di tab Kode.'}
              </p>
              {!booting && buildLog && !buildLog.ok && (
                <p className="mt-3 border-l-2 border-accent pl-2 text-[11.5px] leading-relaxed text-body">
                  Build terakhir gagal. Log lengkap ada di tab Kode, bagian Log.
                </p>
              )}
              {!booting && hasFiles && (
                <button
                  onClick={onRun}
                  className="mt-4 flex h-8 max-md:h-11 items-center gap-1.5 border border-edge px-2.5 text-[11.5px] text-body transition-colors hover:border-quiet"
                >
                  <Icon name="run" size={10} />
                  Jalankan
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {buildLog && !buildLog.ok && (
        <div className="max-h-[150px] shrink-0 overflow-y-auto border-t border-edge bg-surface px-3 py-2">
          <p className="text-[11px] text-quiet">keluaran build terakhir</p>
          <pre className="vb-scroll mt-1 whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-body">
            {buildLog.log.slice(-1600)}
          </pre>
        </div>
      )}
    </div>
  )
}

type TreeNode = { name: string; path: string; children: Map<string, TreeNode>; files: { path: string; name: string }[] }

/* Susun daftar path datar dari tabel `files` menjadi pohon folder bertingkat. */
function buildFileTree(paths: { path: string }[]): TreeNode {
  const root: TreeNode = { name: '', path: '', children: new Map(), files: [] }
  for (const { path } of paths) {
    const parts = path.split('/').filter(Boolean)
    let node = root
    let prefix = ''
    for (const part of parts.slice(0, -1)) {
      prefix = prefix ? `${prefix}/${part}` : part
      let child = node.children.get(part)
      if (!child) {
        child = { name: part, path: prefix, children: new Map(), files: [] }
        node.children.set(part, child)
      }
      node = child
    }
    node.files.push({ path, name: parts.at(-1) ?? path })
  }
  return root
}

function FileTreeRow({
  node,
  depth,
  openFile,
  changedFiles,
  onOpen,
}: {
  node: TreeNode
  depth: number
  openFile: string | null
  changedFiles: string[]
  onOpen: (p: string) => void
}) {
  const [open, setOpen] = useState(depth < 2)
  const folders = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name))
  const files = [...node.files].sort((a, b) => a.name.localeCompare(b.name))
  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex h-7 w-full items-center gap-1.5 border-l-2 border-l-transparent pr-2 text-left text-[11.5px] leading-none text-quiet transition-colors hover:bg-surface-muted hover:text-body"
        style={{ paddingLeft: `${10 + depth * 8}px` }}
      >
        <span className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}><Icon name="arrow" size={9} /></span>
        <Icon name="folder" size={12} />
        <span className="truncate">{node.name}</span>
      </button>
      {open && <>
        {folders.map((f) => <FileTreeRow key={f.path} node={f} depth={depth + 1} openFile={openFile} changedFiles={changedFiles} onOpen={onOpen} />)}
        {files.map((f) => (
          <button
            key={f.path}
            onClick={() => onOpen(f.path)}
            aria-current={openFile === f.path ? 'true' : undefined}
            className={`flex h-7 w-full items-center gap-1.5 border-l-2 pr-2 text-left text-[11.5px] leading-none transition-colors ${
              openFile === f.path
                ? 'border-l-accent bg-ink text-body'
                : 'border-l-transparent text-quiet hover:bg-surface-muted hover:text-body'
            }`}
            style={{ paddingLeft: `${22 + depth * 8}px` }}
            title={f.path}
          >
            <Icon name="file" size={11} />
            <span className="truncate">{f.name}</span>
            {changedFiles.includes(f.path) && <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-accent" title="berubah pada giliran ini" />}
          </button>
        ))}
      </>}
    </>
  )
}

export function CodePane({
  files,
  filesReady = true,
  openFile,
  content,
  buildLog,
  changedFiles,
  projectId,
  onOpen,
  onChange,
  onSave,
  onBuild,
  onFilesRefresh,
}: {
  files: { path: string }[]
  filesReady?: boolean
  openFile: string | null
  content: string
  buildLog: { ok: boolean; log: string } | null
  changedFiles: string[]
  projectId: string
  onOpen: (p: string) => void
  onChange: (v: string) => void
  onSave: () => void
  onBuild: () => void
  onFilesRefresh: () => void
}) {
  const [showLog, setShowLog] = useState(false)
  const [tab, setTab] = useState<'edit' | 'diff'>('edit')
  const [diff, setDiff] = useState<string[] | null>(null)

  useEffect(() => {
    if (buildLog && !buildLog.ok) setShowLog(true)
  }, [buildLog])

  const showDiff = async () => {
    if (!openFile) return
    setTab('diff')
    try {
      const r = await fetch(`/api/projects/${projectId}/file/diff?path=${encodeURIComponent(openFile)}&before=`)
      const d = await r.json()
      setDiff(d.diff ?? [])
    } catch {
      setDiff(['(gagal memuat diff)'])
    }
  }

  const restoreLatest = async () => {
    try {
      const r = await fetch(`/api/projects/${projectId}/versions`)
      const d = await r.json()
      const versions: { id: number; label: string }[] = d.versions ?? []
      if (!versions.length) return
      await fetch(`/api/projects/${projectId}/versions/${versions[0].id}/restore`, { method: 'POST' })
      onFilesRefresh()
    } catch { /* biarkan */ }
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="vb-scroll w-[196px] max-md:w-[132px] shrink-0 overflow-y-auto border-r border-edge bg-surface">
        <p className="border-b border-edge px-3 py-2 text-[11px] text-quiet">
          {!filesReady ? 'Memuat file…' : files.length ? `${files.length} file` : 'file'}
        </p>
        {!filesReady && (
          <div className="flex items-center gap-2 px-3 py-3 text-[11.5px] text-quiet">
            <Spinner /> Memuat daftar file…
          </div>
        )}
        {filesReady && !files.length && (
          <div className="px-3 py-3">
            <p className="text-[11.5px] leading-relaxed text-body">Belum ada file</p>
            <p className="mt-1 text-[11px] leading-relaxed text-quiet">
              File muncul setelah agent menulis yang pertama. Kirim instruksi di tab Chat.
            </p>
          </div>
        )}
        {(() => {
          const tree = buildFileTree(files)
          return [...tree.children.values()].map((f) => (
            <FileTreeRow key={f.path} node={f} depth={0} openFile={openFile} changedFiles={changedFiles} onOpen={onOpen} />
          ))
        })()}
        {(() => {
          const rootFiles = files.filter((f) => !f.path.includes('/'))
          return rootFiles.map((f) => (
            <button
              key={f.path}
              onClick={() => onOpen(f.path)}
              aria-current={openFile === f.path ? 'true' : undefined}
              className={`flex min-h-[28px] max-md:min-h-[40px] w-full items-center gap-1.5 border-l-2 px-2.5 py-1 text-left text-[11.5px] transition-colors ${
                openFile === f.path ? 'border-l-accent bg-ink text-body' : 'border-l-transparent text-quiet hover:bg-surface-muted hover:text-body'
              }`}
              title={f.path}
            >
              <Icon name="file" size={11} />
              <span className="truncate">{f.path}</span>
              {changedFiles.includes(f.path) && <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-accent" title="berubah pada giliran ini" />}
            </button>
          ))
        })()}
        {files.length > 0 && (
          <button
            onClick={restoreLatest}
            className="mt-2 mx-2 mb-3 flex h-7 items-center gap-1 border border-edge px-2 text-[10.5px] text-quiet transition-colors hover:border-quiet hover:text-body"
            title="Kembalikan semua file ke snapshot sebelum giliran terakhir"
          >
            <Icon name="back" size={10} />
            Rollback
          </button>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-9 max-md:h-12 shrink-0 items-center gap-2 border-b border-edge bg-surface px-3">
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-quiet">
            {openFile ?? 'belum ada file dipilih'}
          </span>
          <button
            onClick={() => { setTab('edit'); setDiff(null) }}
            aria-pressed={tab === 'edit'}
            className={`h-6 px-1.5 text-[11px] transition-colors ${tab === 'edit' ? 'text-body' : 'text-quiet hover:text-body'}`}
          >
            Edit
          </button>
          <button
            onClick={showDiff}
            aria-pressed={tab === 'diff'}
            disabled={!openFile}
            className={`h-6 px-1.5 text-[11px] transition-colors disabled:opacity-40 ${tab === 'diff' ? 'text-body' : 'text-quiet hover:text-body'}`}
          >
            Diff
          </button>
          <button
            onClick={() => setShowLog((v) => !v)}
            aria-expanded={showLog}
            className={`flex h-6 items-center gap-1 px-1.5 text-[11px] transition-colors ${
              showLog ? 'text-body' : 'text-quiet hover:text-body'
            }`}
          >
            <Icon name="rule" size={11} />
            Log
          </button>
          <button
            onClick={onSave}
            disabled={!openFile}
            className="h-6 border border-edge px-2 text-[11px] text-body transition-colors hover:border-quiet disabled:opacity-40"
          >
            Simpan
          </button>
          <button
            onClick={onBuild}
            className="flex h-6 items-center gap-1 bg-accent px-2 text-[11px] font-medium text-ink transition-opacity hover:opacity-90"
          >
            <Icon name="run" size={9} />
            Build
          </button>
        </div>

        <div className="min-h-0 flex-1">
          {tab === 'diff' && diff !== null ? (
            <pre className="vb-scroll h-full w-full overflow-auto bg-ink px-3 py-2 font-mono text-[11px] leading-relaxed">
              {diff.length
                ? diff.map((l) => l.startsWith('+') ? `+${l.slice(1)}` : l).map((l, i) => (
                    <div key={i} className={l.startsWith('+') ? 'text-accent' : l.startsWith('-') ? 'text-quiet line-through' : 'text-body'}>{l}</div>
                  ))
                : '(tidak ada perubahan)'}
            </pre>
          ) : openFile ? (
            <textarea
              value={content}
              onChange={(e) => onChange(e.target.value)}
              spellCheck={false}
              aria-label={`Isi file ${openFile}`}
              className="vb-scroll h-full w-full resize-none bg-ink px-3 py-2 font-mono text-[11.5px] leading-relaxed text-body outline-none"
            />
          ) : (
            <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-quiet">
              Pilih file di kiri untuk membaca dan mengubah isinya.
            </div>
          )}
        </div>

        {showLog && buildLog && (
          <div className="max-h-[170px] shrink-0 overflow-y-auto border-t border-edge bg-surface px-3 py-2">
            <p className="text-[11px] text-quiet">
              build {buildLog.ok ? 'lolos' : 'gagal'}
            </p>
            <pre className="vb-scroll mt-1 whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-body">
              {buildLog.log.slice(-3000)}
            </pre>
          </div>
        )}
      </div>
    </div>
  )
}

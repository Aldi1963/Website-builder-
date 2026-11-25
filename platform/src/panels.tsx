import { useEffect, useRef, useState } from 'react'
import { Activity, Icon, Spinner, useAutoScroll, useCopy } from './ui'
import type { AuditFinding, PlanStep } from './api'

export type ChatItem = { role: string; content: string; id?: number }
export type ChatPlan = { ringkasan: string; langkah: PlanStep[]; berkas: string[]; asumsi: string[] }
export type ChatAudit = { nilai: number; temuan: AuditFinding[]; catatan: string }

/* Katalog model untuk picker gaya "Select model". Id benar diverifikasi terhadap
   /v1/models gateway; 'auto' berarti server memakai default-nya. */
export type ModelOption = { id: string; name: string; note: string; available?: boolean }

export const MODEL_CATALOG: ModelOption[] = [
  { id: 'auto', name: 'Auto', note: 'Selalu pilih model terbaik', available: true },
  { id: 'ag/claude-opus-5-5', name: 'Claude Opus 5.5', note: 'Model paling cerdas Anthropic', available: false },
  { id: 'ag/claude-sonnet-5-5', name: 'Claude Sonnet 5.5', note: 'Seimbang untuk kerja harian', available: false },
  { id: 'cx/gpt-6-luna', name: 'GPT-6 Luna', note: 'Kuat untuk coding & penalaran', available: true },
  { id: 'cx/gpt-5.6-luna', name: 'GPT-5.6 Luna', note: 'Cepat dan andal', available: true },
]

export function SettingsSheet({
  open,
  onClose,
  model,
  onModel,
  planMode,
  onPlanMode,
}: {
  open: boolean
  onClose: () => void
  model: string
  onModel: (id: string) => void
  planMode: boolean
  onPlanMode: (v: boolean) => void
}) {
  const [picking, setPicking] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') (picking ? setPicking(false) : onClose())
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, picking, onClose])

  if (!open) return null
  const current = MODEL_CATALOG.find((m) => m.id === model) ?? MODEL_CATALOG[0]

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/55" onClick={onClose} role="dialog" aria-label="Pengaturan sesi">
      <div
        onClick={(e) => e.stopPropagation()}
        className="vb-enter w-full max-w-[420px] border border-edge bg-surface px-4 pb-6 pt-4 max-md:px-3"
      >
        {!picking ? (
          <>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="font-display text-[16px] text-body">Pengaturan</h2>
              <button onClick={onClose} aria-label="Tutup pengaturan" className="flex h-8 w-8 items-center justify-center text-quiet hover:text-body">
                <Icon name="close" size={14} />
              </button>
            </div>

            <button
              onClick={() => setPicking(true)}
              className="flex min-h-[48px] w-full items-center justify-between border-b border-edge py-2 text-left"
            >
              <span>
                <span className="block text-[12.5px] text-body">Model — {current.name}</span>
                <span className="block text-[11px] text-quiet">{current.note}</span>
              </span>
              <Icon name="arrow" size={12} className="text-quiet" />
            </button>

            <ToggleRow
              label="Plan mode"
              hint="Rencana kerja ditampilkan dulu sebelum kode ditulis"
              checked={planMode}
              onChange={onPlanMode}
            />
            <ToggleRow
              label="Fast mode"
              hint="Edit kecil langsung diterapkan tanpa tinjauan penuh"
              checked={false}
              onChange={() => {}}
              disabled
            />
            <div className="mt-1 border-b border-edge py-2">
              <p className="text-[12.5px] text-body">Simpan ke GitHub</p>
              <p className="text-[11px] text-quiet">Ekspor ZIP tersedia di header workspace.</p>
            </div>
            <div className="mt-1 border-b border-edge py-2 opacity-50">
              <p className="text-[12.5px] text-body">Fork</p>
              <p className="text-[11px] text-quiet">Belum tersedia di deploy ini.</p>
            </div>
          </>
        ) : (
          <>
            <div className="mb-2 flex items-center justify-between">
              <button onClick={() => setPicking(false)} className="flex h-8 w-8 items-center justify-center text-quiet hover:text-body" aria-label="Kembali ke pengaturan">
                <Icon name="back" size={14} />
              </button>
              <h2 className="text-[13px] font-medium text-body">Pilih model</h2>
              <span className="h-8 w-8" />
            </div>
            <div className="flex flex-col">
              {MODEL_CATALOG.map((m) => {
                const active = m.id === model
                const disabled = m.available === false
                return (
                  <button
                    key={m.id}
                    disabled={disabled}
                    onClick={() => {
                      onModel(m.id)
                      setPicking(false)
                    }}
                    className={`flex min-h-[52px] items-center justify-between border-b border-edge py-2 text-left transition-colors ${
                      disabled ? 'cursor-not-allowed opacity-40' : 'hover:bg-ink'
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
          </>
        )}
      </div>
    </div>
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
    <label className={`flex min-h-[48px] items-center justify-between gap-3 border-b border-edge py-2 ${disabled ? 'opacity-50' : ''}`}>
      <span>
        <span className="block text-[12.5px] text-body">{label}</span>
        <span className="block text-[11px] text-quiet">{hint}</span>
      </span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 shrink-0 accent-[var(--vb-accent)]"
      />
    </label>
  )
}

export function ChatPanel({
  messages,
  sending,
  status,
  plan,
  audit,
  streamText,
  onSend,
  onCancel,
}: {
  messages: ChatItem[]
  sending: boolean
  status: string
  plan: ChatPlan | null
  audit: ChatAudit | null
  streamText?: string
  onSend: (text: string) => void
  onCancel: () => void
}) {
  const [input, setInput] = useState('')
  const scrollRef = useAutoScroll(messages.length + (streamText?.length ?? 0))
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 168)}px`
  }, [input])

  const submit = () => {
    if (!input.trim() || sending) return
    onSend(input.trim())
    setInput('')
  }

  return (
    <>
      <div ref={scrollRef} className="vb-scroll flex-1 overflow-y-auto px-4 py-4">
        {!messages.length ? (
          <Welcome onPick={(s) => setInput(s)} />
        ) : (
          <div className="flex flex-col gap-4">
            {messages.map((m, i) => (
              <Bubble key={m.id ?? i} role={m.role} content={m.content} />
            ))}
            {sending && (
              <div className="vb-enter flex flex-col gap-2 text-[12px] text-quiet">
                {status && (
                  <div className="flex items-center gap-2"><Activity /><span>{status}</span></div>
                )}
                {plan && <PlanCard plan={plan} />}
                {audit && <AuditCard audit={audit} />}
                {streamText ? (
                  <div className="border border-edge bg-surface px-3 py-3 text-[12.5px] leading-relaxed text-body">
                    <p className="mb-1 text-[11px] font-medium text-accent">ASISTEN</p>
                    <p className="whitespace-pre-wrap">{streamText}<span className="vb-caret ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-accent align-middle" /></p>
                  </div>
                ) : null}
              </div>
            )}
            {!sending && audit && <AuditCard audit={audit} />}
          </div>
        )}
      </div>

      <div className="vb-seam shrink-0 bg-surface px-3 py-3">
        <div className="border border-edge bg-ink px-2 py-2 transition-colors focus-within:border-accent">
          <label htmlFor="vb-prompt" className="sr-only">
            Instruksi untuk agent
          </label>
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
            rows={1}
            placeholder="Apa yang harus dibangun atau diubah"
            className="vb-scroll max-h-[168px] w-full resize-none bg-transparent px-1 py-1 text-[13px] leading-relaxed text-body outline-none placeholder:text-quiet"
          />
          <div className="mt-1 flex items-center justify-between gap-3 px-1">
            <span className="hidden text-[11px] text-quiet sm:block">
              Enter kirim, Shift+Enter baris baru
            </span>
            {sending ? (
              <button
                onClick={onCancel}
                className="flex h-8 max-md:h-11 items-center gap-1.5 border border-edge px-2.5 text-[11.5px] text-body transition-colors hover:border-quiet"
              >
                <Icon name="stop" size={10} />
                Hentikan
              </button>
            ) : (
              <button
                onClick={submit}
                disabled={!input.trim()}
                className="flex h-8 max-md:h-11 items-center gap-1.5 bg-accent px-2.5 text-[11.5px] font-medium text-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:border disabled:border-edge disabled:bg-transparent disabled:text-quiet"
              >
                <Icon name="arrow" size={11} />
                Kirim
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

function PlanCard({ plan }: { plan: ChatPlan }) {
  return (
    <section aria-label="Rencana kerja AI" className="border border-edge bg-surface px-3 py-3 text-body">
      <p className="text-[11px] font-medium text-accent">RENCANA KERJA</p>
      <p className="mt-1 text-[12px] leading-relaxed">{plan.ringkasan}</p>
      {!!plan.langkah.length && <ol className="mt-2 flex flex-col gap-1.5">
        {plan.langkah.map((step, i) => <li key={`${step.judul}-${i}`} className="flex gap-2 text-[11.5px] leading-relaxed">
          <span className="flex h-4 w-4 shrink-0 items-center justify-center border border-edge font-mono text-[10px] text-accent">{i + 1}</span>
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
    <section aria-label="Laporan tinjauan kode" className="border border-edge bg-surface px-3 py-3 text-body">
      <div className="flex items-center justify-between gap-2">
        <div><p className="text-[11px] font-medium text-accent">TINJAUAN KODE · {audit.nilai}/100</p>
          <p className="mt-1 text-[11.5px] leading-relaxed">{audit.catatan}</p></div>
        <span className="shrink-0 font-mono text-[11px] text-quiet">{audit.temuan.length} temuan</span>
      </div>
      <p className="mt-2 text-[10.5px] text-quiet">{critical} kritis · {important} penting · {audit.temuan.length - critical - important} ringan</p>
      {!!audit.temuan.length && <button onClick={() => setOpen((v) => !v)} aria-expanded={open} className="mt-2 text-[11px] text-accent underline underline-offset-2">{open ? 'Sembunyikan rincian' : 'Lihat rincian'}</button>}
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
    <div className="vb-enter pt-2">
      <h2 className="font-display text-[19px] leading-snug text-body">
        Tulis satu kalimat, agent menulis aplikasinya
      </h2>
      <p className="mt-2 max-w-[42ch] text-[12.5px] leading-relaxed text-quiet">
        File ditulis langsung ke workspace proyek, di-build, lalu tampil di panel kanan.
        Kalau permintaannya terlalu luas untuk ditebak, agent bertanya dulu.
      </p>

      <div className="mt-5 border-t border-edge">
        <p className="vb-seam-none pt-3 text-[11px] text-quiet">Mulai dari salah satu</p>
        <div className="mt-2 flex flex-col">
          {samples.map((s) => (
            <button
              key={s.title}
              onClick={() => onPick(`Buat ${s.title.toLowerCase()}: ${s.body}.`)}
              className="group flex min-h-[52px] flex-col justify-center border-b border-edge py-2 text-left transition-colors hover:bg-surface"
            >
              <span className="text-[12.5px] text-body">{s.title}</span>
              <span className="text-[11.5px] text-quiet">{s.body}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function Bubble({ role, content }: { role: string; content: string }) {
  const { copied, copy } = useCopy()

  if (role === 'user') {
    return (
      <div className="vb-enter flex flex-col items-end gap-1">
        <span className="text-[11px] text-quiet">kamu</span>
        <div className="max-w-[92%] bg-accent px-3.5 py-2 text-[13px] leading-relaxed text-ink">
          {content}
        </div>
      </div>
    )
  }

  if (role === 'error') {
    return (
      <div className="vb-enter border-l-2 border-accent bg-surface px-3 py-2">
        <p className="text-[11px] text-accent">agent gagal</p>
        <p className="mt-1 whitespace-pre-wrap text-[12.5px] leading-relaxed text-body">{content}</p>
      </div>
    )
  }

  return (
    <div className="vb-enter group">
      <div className="flex items-center gap-2">
        <span className="flex h-5 w-5 items-center justify-center bg-accent font-mono text-[10px] font-bold text-ink" aria-hidden="true">V</span>
        <span className="text-[11px] font-medium text-body">VibeBuilder</span>
      </div>
      <div className="mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed text-body">{content}</div>
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

export function PreviewPane({
  previewOn,
  previewPort,
  dirty,
  buildLog,
  onRun,
  booting,
  hasFiles,
}: {
  previewOn: boolean
  previewPort: number
  dirty: boolean
  buildLog: { ok: boolean; log: string } | null
  onRun: () => void
  booting: boolean
  hasFiles: boolean
}) {
  const [reloadKey, setReloadKey] = useState(0)
  const url = `http://127.0.0.1:${previewPort}/`

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
      </div>

      <div className="relative min-h-0 flex-1 bg-ink">
        {previewOn ? (
          <iframe
            key={reloadKey}
            src={url}
            title="Preview aplikasi yang dibangun"
            className="h-full w-full border-0 bg-white"
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

export function CodePane({
  files,
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
          {files.length ? `${files.length} file` : 'file'}
        </p>
        {!files.length && (
          <div className="px-3 py-3">
            <p className="text-[11.5px] leading-relaxed text-body">Belum ada file</p>
            <p className="mt-1 text-[11px] leading-relaxed text-quiet">
              File muncul setelah agent menulis yang pertama. Kirim instruksi di tab Chat.
            </p>
          </div>
        )}
        {files.map((f) => (
          <button
            key={f.path}
            onClick={() => onOpen(f.path)}
            aria-current={openFile === f.path ? 'true' : undefined}
            className={`flex min-h-[30px] max-md:min-h-[44px] w-full items-center gap-1.5 border-l-2 px-2.5 py-1 text-left text-[11.5px] transition-colors ${
              openFile === f.path
                ? 'border-l-accent bg-ink text-body'
                : 'border-l-transparent text-quiet hover:bg-ink hover:text-body'
            }`}
            title={f.path}
          >
            <span className="truncate">{f.path.replace(/^src\//, '')}</span>
            {changedFiles.includes(f.path) && (
              <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-accent" title="berubah pada giliran ini" />
            )}
          </button>
        ))}
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

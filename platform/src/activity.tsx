import { useEffect, useRef, useState } from 'react'

/* Model of one observable agent action shown as a terminal line / block,
   mirroring Emergent's "agent executing commands" feed. */
export type ActivityEntry =
  | { kind: 'status'; text: string; at: number }
  | { kind: 'file'; path: string; action: 'write' | 'delete' | 'mkdir'; at: number }
  | { kind: 'terminal'; title: string; log: string; ok: boolean; at: number }

const MAX_ENTRIES = 40

/* Strip ANSI escape sequences so build/install logs render as clean text. */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
}

export function useActivity() {
  const [entries, setEntries] = useState<ActivityEntry[]>([])
  const push = (e: ActivityEntry) => setEntries((prev) => [...prev.slice(-MAX_ENTRIES + 1), e])
  const reset = () => setEntries([])
  return { entries, push, reset }
}

export function TerminalBlock({ title, log, ok, defaultOpen = true }: { title: string; log: string; ok: boolean; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const clean = stripAnsi(log).trimEnd()
  const lines = clean ? clean.split('\n') : []
  /* Gaya Emergent: satu baris perintah "$ npm run build" terlihat di feed;
     outputnya disembunyikan sampai kartu diketuk. */
  return (
    <div className="overflow-hidden rounded-lg border border-edge bg-surface text-body">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? 'Sembunyikan output' : 'Lihat output'}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-muted"
      >
        <span className="shrink-0 font-mono text-[11px] text-success">$</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-body">{title}</span>
        <span className={`shrink-0 font-mono text-[10px] ${ok ? 'text-success' : 'text-danger'}`}>{ok ? '✓' : '✗'}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" className={`shrink-0 text-quiet transition-transform ${open ? 'rotate-90' : ''}`}><path d="m9 6 6 6-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && (
        <pre className="vb-scroll max-h-[240px] overflow-auto border-t border-edge bg-ink px-3 py-2.5 font-mono text-[10.5px] leading-relaxed text-quiet">
          {lines.join('\n') || '(tanpa output)'}
        </pre>
      )}
    </div>
  )
}

function statusLabel(text: string): string {
  const t = text.toLowerCase()
  if (t.includes('build')) return 'npm run build'
  if (t.includes('install')) return 'npm install'
  if (t.includes('rencana') || t.includes('plan')) return 'agent plan'
  if (t.includes('ringkasan')) return 'agent summarize'
  if (t.includes('audit')) return 'agent audit'
  return 'agent run'
}

export function ActivityFeed({ entries }: { entries: ActivityEntry[] }) {
  // Ala Emergent: saat agent bekerja hanya satu baris "berpikir" yang terlihat
  // (langkah terakhir), riwayat lengkapnya tersimpan di balik satu ketukan.
  // Sebelumnya semua langkah (s.d. 40 baris) tampil sekaligus dan memenuhi chat.
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries.length, open])
  if (!entries.length) return null
  const last = entries[entries.length - 1]
  const current =
    last.kind === 'status'
      ? { label: statusLabel(last.text), text: last.text }
      : last.kind === 'file'
        ? { label: 'agent file', text: `${last.action === 'delete' ? 'rm' : last.action === 'mkdir' ? 'mkdir' : 'write'} ${last.path}` }
        : { label: 'terminal', text: last.title }
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? 'Sembunyikan langkah-langkah' : 'Lihat semua langkah'}
        className="flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left text-[11.5px] text-quiet hover:bg-surface-muted"
      >
        <span className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" aria-hidden="true" />
        <span className="shrink-0 font-mono text-[10.5px] text-quiet">{current.label}</span>
        <span className="min-w-0 flex-1 truncate text-body/80">{current.text}</span>
        <span className="shrink-0 font-mono text-[10.5px] text-quiet">
          {entries.length} langkah · {open ? 'tutup' : 'lihat'}
        </span>
      </button>
      {open && (
        <div ref={ref} className="vb-scroll vb-enter flex max-h-[46dvh] flex-col gap-2 overflow-y-auto" aria-label="Aktivitas agent">
          {entries.map((e, i) => {
            if (e.kind === 'terminal') {
              return <TerminalBlock key={i} title={e.title} log={e.log} ok={e.ok} />
            }
            if (e.kind === 'file') {
              const cmd = e.action === 'delete' ? `rm ${e.path}` : e.action === 'mkdir' ? `mkdir ${e.path}` : `write ${e.path}`
              return (
                <div key={i} className="rounded-md border border-edge bg-surface px-3 py-1.5 font-mono text-[11px] text-quiet">
                  <span className="text-success">$</span> <span className="text-body">{cmd}</span>
                </div>
              )
            }
            return (
              <div key={i} className="flex items-center gap-2 text-[11.5px] text-quiet">
                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent" aria-hidden="true" />
                <span className="font-mono text-[10.5px] text-quiet">{statusLabel(e.text)}</span>
                <span className="min-w-0 truncate text-body/80">{e.text}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}


/* Phase strip: empat tahap khas Lovable/Emergent, dipetakan dari status
   nyata yang dipancarkan agent (bukan angka sintetis). only shown while
   sending. Tahap selesai = langkah berikutnya sudah pernah terlihat. */
export const PHASES = [
  { label: 'Membaca', match: /membaca|melihat daftar file|mencari kode|referensi gambar|meninjau/i },
  { label: 'Merencana', match: /rencana|memeriksa proyek/i },
  { label: 'Membangun', match: /menerapkan|install dependency|menyiapkan tabel|menjalankan query|memperbaiki otomatis|mengambil screenshot/i },
  { label: 'Menyelesaikan', match: /ringkasan|build|menyusun jawaban|publik|audit/i },
] as const

export function phaseIndex(status: string): number {
  const t = status.toLowerCase()
  let current = -1
  for (let i = 0; i < PHASES.length; i++) if (PHASES[i].match.test(t)) current = Math.max(current, i)
  return current < 0 ? 0 : current
}

export function PhaseStrip({ status, active }: { status: string; active: boolean }) {
  if (!active || !status) return null
  const current = phaseIndex(status)
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-edge bg-surface px-2.5 py-1.5" role="status" aria-label="Tahap agent">
      {PHASES.map((ph, i) => (
        <span key={ph.label} className="flex items-center gap-1.5">
          {i > 0 && <span className={`h-px w-3 ${i <= current ? 'bg-accent' : 'bg-edge'}`} aria-hidden="true" />}
          <span
            className={`text-[10.5px] ${i < current ? 'text-success' : i === current ? 'font-medium text-body' : 'text-quiet'}`}
            aria-current={i === current ? 'step' : undefined}
          >
            {i < current ? '✓ ' : ''}{ph.label}
          </span>
        </span>
      ))}
    </div>
  )
}

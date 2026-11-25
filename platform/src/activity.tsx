import { useEffect, useRef, useState } from 'react'

/* Model of one observable agent action shown as a terminal line / block,
   mirroring Emergent's "agent executing commands" feed. */
export type ActivityEntry =
  | { kind: 'status'; text: string; at: number }
  | { kind: 'file'; path: string; action: 'write' | 'delete'; at: number }
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

export function TerminalBlock({ title, log, ok }: { title: string; log: string; ok: boolean }) {
  const [open, setOpen] = useState(true)
  const clean = stripAnsi(log).trimEnd()
  const lines = clean ? clean.split('\n') : []
  const shown = open ? lines : lines.slice(-4)
  return (
    <div className="overflow-hidden rounded-lg border border-[#2d3237] bg-[#16181a] text-[#d5dbe1]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 border-b border-[#2d3237] bg-[#1d2023] px-3 py-2 text-left"
      >
        <span className="flex gap-1.5" aria-hidden="true">
          <i className="h-2 w-2 rounded-full bg-[#f36747]" />
          <i className="h-2 w-2 rounded-full bg-[#e2e8f0]/30" />
          <i className="h-2 w-2 rounded-full bg-[#e2e8f0]/30" />
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-[#8b959f]">{title}</span>
        <span className={`font-mono text-[10px] ${ok ? 'text-emerald-400' : 'text-red-400'}`}>{ok ? 'OK' : 'GAGAL'}</span>
      </button>
      <pre className="vb-scroll max-h-[240px] overflow-auto px-3 py-2.5 font-mono text-[11px] leading-relaxed text-[#c8d0d8]">
        {shown.join('\n')}
      </pre>
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
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries.length])
  if (!entries.length) return null
  return (
    <div ref={ref} className="vb-scroll vb-enter flex max-h-[46dvh] flex-col gap-2 overflow-y-auto" aria-label="Aktivitas agent">
      {entries.map((e, i) => {
        if (e.kind === 'terminal') {
          return <TerminalBlock key={i} title={e.title} log={e.log} ok={e.ok} />
        }
        if (e.kind === 'file') {
          const cmd = e.action === 'delete' ? `rm ${e.path}` : `write ${e.path}`
          return (
            <div key={i} className="rounded-md border border-[#2d3237] bg-[#16181a] px-3 py-1.5 font-mono text-[11px] text-[#8b959f]">
              <span className="text-emerald-400">$</span> <span className="text-[#c8d0d8]">{cmd}</span>
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
  )
}

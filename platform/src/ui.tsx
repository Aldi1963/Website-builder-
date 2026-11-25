import { useEffect, useRef, useState } from 'react'

export function Wordmark({ size = 15 }: { size?: number }) {
  return (
    <span className="flex items-baseline gap-2">
      <span className="font-display leading-none tracking-tight" style={{ fontSize: size }}>
        VibeBuilder
      </span>
      <span aria-hidden="true" className="inline-block h-[3px] w-[3px] -translate-y-[2px] bg-accent" />
    </span>
  )
}

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" width="13" height="13" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.22" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  )
}

export function Activity() {
  return (
    <span className="vb-activity" role="status" aria-label="agent bekerja">
      <i />
      <i />
      <i />
    </span>
  )
}

export function useAutoScroll(dep: unknown) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [dep])
  return ref
}

export function useCopy() {
  const [copied, setCopied] = useState(false)
  return {
    copied,
    copy: async (text: string) => {
      try {
        await navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1400)
      } catch {
        /* clipboard ditolak browser */
      }
    },
  }
}

/* Glyph set drawn in-house rather than imported, so the icon weight is a decision
   and not a library's uniform signature. Each path is traced to its meaning. */
const PATHS: Record<string, string> = {
  plus: 'M12 5v14M5 12h14',
  arrow: 'M4 12h13M11 5l7 7-7 7',
  close: 'M6 6l12 12M18 6L6 18',
  stop: 'M6 6h12v12H6z',
  trash: 'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13',
  file: 'M6 3h8l5 5v13H6zM14 3v5h5',
  rule: 'M4 6h16M4 12h10M4 18h16',
  run: 'M7 4l13 8-13 8V4Z',
  reload: 'M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6',
  open: 'M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  monitor: 'M3 5h18v12H3zM8 21h8M12 17v4',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  download: 'M12 4v11M7 11l5 5 5-5M4 19h16',
  check: 'M4 12.5 9 17.5 20 6.5',
  menu: 'M4 7h16M4 12h16M4 17h16',
  sun: 'M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M18.4 5.6l1.4-1.4M4.2 19.8l1.4-1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z',
  moon: 'M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z',
  logout: 'M15 4h4v16h-4M11 16l-4-4 4-4M7 12h9',
  bolt: 'M13 2 4 14h6l-1 8 9-12h-6l1-8',
  back: 'M20 12H7M13 5l-7 7 7 7',
  camera: 'M4 8h4l2-2h4l2 2h4v11H4zM12 18a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
}

export function Icon({
  name,
  size = 14,
  className = '',
  title,
}: {
  name: string
  size?: number
  className?: string
  title?: string
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden={title ? undefined : 'true'}
      role={title ? 'img' : undefined}
    >
      {title && <title>{title}</title>}
      <path
        d={PATHS[name] ?? ''}
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

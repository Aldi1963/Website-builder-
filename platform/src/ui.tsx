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

/* Badge status proyek (pill, tidak pernah menempel ke nama — perbaikan bug
   "Marketingidle"). Published dihitung dari slug, bukan dari status run. */
export function StatusBadge({ status, published }: { status: string; published?: boolean }) {
  if (published) return <span className="vb-badge vb-badge-published">Published</span>
  if (status === 'working' || status === 'building')
    return <span className="vb-badge vb-badge-building">{status === 'working' ? 'Berjalan' : 'Building'}</span>
  if (status === 'error') return <span className="vb-badge vb-badge-error">Error</span>
  return <span className="vb-badge vb-badge-idle">Idle</span>
}

/* Thumbnail proyek 48x48: huruf awal nama di atas accent-soft. */
export function ProjectThumb({ name }: { name: string }) {
  const letter = (name.trim().charAt(0) || 'P').toUpperCase()
  return (
    <span aria-hidden="true" className="vb-thumb">
      {letter}
    </span>
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
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
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
  gear: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM19.4 15a1.6 1.6 0 0 0 .32 1.77l.06.06-2 2-.06-.06a1.6 1.6 0 0 0-1.77-.32 1.6 1.6 0 0 0-1 1.47V20h-3v-.08a1.6 1.6 0 0 0-1-1.47 1.6 1.6 0 0 0-1.77.32l-.06.06-2-2 .06-.06A1.6 1.6 0 0 0 7.1 15a1.6 1.6 0 0 0-1.47-1H5.5v-3h.13a1.6 1.6 0 0 0 1.47-1 1.6 1.6 0 0 0-.32-1.77l-.06-.06 2-2 .06.06A1.6 1.6 0 0 0 10.55 6.2 1.6 1.6 0 0 0 11.55 4.7V4.5h3v.2a1.6 1.6 0 0 0 1 1.47 1.6 1.6 0 0 0 1.77-.32l.06-.06 2 2-.06.06a1.6 1.6 0 0 0-.32 1.77 1.6 1.6 0 0 0 1.47 1h.13v3H21a1.6 1.6 0 0 0-1.6 1Z',
  camera: 'M4 8h4l2-2h4l2 2h4v11H4zM12 18a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  eye: 'M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  'eye-off': 'M4 4l16 16M9.9 5.2A9.9 9.9 0 0 1 12 5c6.4 0 10 7 10 7a18 18 0 0 1-3.2 4M6.6 6.6A17.6 17.6 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 3.4-.6M9.9 9.9a3 3 0 0 0 4.2 4.2',
  list: 'M4 6h3M4 12h3M4 18h3M10 6h10M10 12h10M10 18h10',
  code: 'M9 7l-5 5 5 5M15 7l5 5-5 5',
  table: 'M3 5h18v14H3zM3 10h18M9 10v9M15 10v9',
  'arrow-left': 'M20 12H7M13 5l-7 7 7 7',
  'arrows-clockwise': 'M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6M4 13a8 8 0 0 0 2.3 5.7M4 19v-6h6',
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

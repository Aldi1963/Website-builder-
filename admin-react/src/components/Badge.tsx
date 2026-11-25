import type { ReactNode } from 'react'

export type BadgeTone = 'default' | 'success' | 'danger' | 'warning' | 'info' | 'accent'

const TONES: Record<BadgeTone, string> = {
  default: 'bg-surface-muted text-ink',
  success: 'bg-success-soft text-success',
  danger: 'bg-danger-soft text-danger',
  warning: 'bg-warning-soft text-warning',
  info: 'bg-info-soft text-info',
  accent: 'bg-accent-soft text-accent',
}

export function Badge({ children, tone = 'default' }: { children: ReactNode; tone?: BadgeTone }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${TONES[tone]}`}>
      {children}
    </span>
  )
}

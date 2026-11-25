import type { ReactNode } from 'react'
import { CheckCircle, Info, Warning, X, XCircle } from '@phosphor-icons/react'

export type AlertTone = 'info' | 'success' | 'warning' | 'error'

const TONES = {
  info: { wrap: 'border-info/30 bg-info-soft text-ink', icon: <Info size={18} className="text-info" weight="fill" /> },
  success: { wrap: 'border-success/30 bg-success-soft text-ink', icon: <CheckCircle size={18} className="text-success" weight="fill" /> },
  warning: { wrap: 'border-warning/30 bg-warning-soft text-ink', icon: <Warning size={18} className="text-warning" weight="fill" /> },
  error: { wrap: 'border-danger/30 bg-danger-soft text-ink', icon: <XCircle size={18} className="text-danger" weight="fill" /> },
} as const

interface AlertProps {
  tone?: AlertTone
  title?: string
  children: ReactNode
  onClose?: () => void
}

export function Alert({ tone = 'info', title, children, onClose }: AlertProps) {
  const t = TONES[tone]
  return (
    <div role="alert" className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm ${t.wrap}`}>
      <span className="mt-0.5 shrink-0">{t.icon}</span>
      <div className="min-w-0 flex-1">
        {title ? <p className="font-semibold">{title}</p> : null}
        <div className="break-words">{children}</div>
      </div>
      {onClose ? (
        <button type="button" aria-label="Tutup" onClick={onClose} className="shrink-0 rounded p-0.5 text-muted hover:text-ink">
          <X size={16} />
        </button>
      ) : null}
    </div>
  )
}

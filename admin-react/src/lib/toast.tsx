import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'
import { CheckCircle, Info, WarningCircle, X, XCircle } from '@phosphor-icons/react'

export type ToastKind = 'success' | 'error' | 'info'

interface ToastItem {
  id: number
  kind: ToastKind
  message: string
}

interface ToastValue {
  push: (kind: ToastKind, message: string) => void
  success: (message: string) => void
  error: (message: string) => void
  info: (message: string) => void
}

const ToastContext = createContext<ToastValue | null>(null)

const ICONS = {
  success: <CheckCircle size={20} className="text-success" weight="fill" />,
  error: <XCircle size={20} className="text-danger" weight="fill" />,
  info: <Info size={20} className="text-info" weight="fill" />,
} as const

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const nextId = useRef(1)

  const push = useCallback((kind: ToastKind, message: string) => {
    const id = nextId.current++
    setToasts((prev) => [...prev, { id, kind, message }])
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, 4000)
  }, [])

  const value: ToastValue = {
    push,
    success: (message) => push('success', message),
    error: (message) => push('error', message),
    info: (message) => push('info', message),
  }

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed top-3 right-3 z-[100] flex w-[min(360px,calc(100vw-24px))] flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="alert"
            className="pointer-events-auto flex items-start gap-2 rounded-lg border border-border bg-surface px-3 py-2.5 text-sm shadow-lg"
          >
            <span className="mt-0.5 shrink-0">{ICONS[t.kind]}</span>
            <span className="min-w-0 flex-1 break-words">{t.message}</span>
            <button
              type="button"
              aria-label="Tutup notifikasi"
              className="shrink-0 rounded p-0.5 text-muted hover:text-ink"
              onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
            >
              <X size={16} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastValue {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast harus dipakai di dalam <ToastProvider>')
  return ctx
}

/* Ikon peringatan (dipakai Alert/EmptyState) — diekspor agar konsisten. */
export const WarningIcon = WarningCircle

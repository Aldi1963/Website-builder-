import type { ReactNode } from 'react'

interface StatCardProps {
  label: string
  value: string
  sub?: string
  icon?: ReactNode
}

/** Kartu statistik (pengganti .stats-card template lama). */
export function StatCard({ label, value, sub, icon }: StatCardProps) {
  return (
    <div className="min-w-0 rounded-xl border border-border bg-surface p-5 shadow-sm">
      <div className="flex items-center gap-3">
        {icon ? (
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
            {icon}
          </div>
        ) : null}
        <div className="min-w-0">
          <p className="truncate text-sm text-muted">{label}</p>
          <p className="truncate text-xl font-bold">{value}</p>
        </div>
      </div>
      {sub ? <p className="mt-2 text-sm text-muted">{sub}</p> : null}
    </div>
  )
}

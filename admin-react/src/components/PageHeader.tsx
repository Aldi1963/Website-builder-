import type { ReactNode } from 'react'

interface PageHeaderProps {
  /** Judul h1. Boleh dikosongkan bila halaman sudah punya judul di atas
      (mis. tab di dalam halaman AI) — deskripsi + aksi tetap tampil. */
  title?: string
  description?: string
  actions?: ReactNode
}

/** Judul halaman + deskripsi + aksi di kanan. */
export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        {title ? <h1 className="text-2xl font-bold">{title}</h1> : null}
        {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}

import type { ReactNode } from 'react'

interface CardProps {
  title?: string
  description?: string
  actions?: ReactNode
  children: ReactNode
  className?: string
}

/** Kartu permukaan standar: latar solid, tanpa gradasi.
    `min-w-0` supaya kartu yang jadi item grid bisa mengecil di bawah
    min-content isinya (tanpanya tabel di dalam kartu melebarkan grid
    hingga halaman meluber horizontal di HP). */
export function Card({ title, description, actions, children, className = '' }: CardProps) {
  return (
    <section className={`min-w-0 rounded-xl border border-border bg-surface shadow-sm ${className}`}>
      {title || actions ? (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            {title ? <h2 className="text-base font-semibold">{title}</h2> : null}
            {description ? <p className="mt-0.5 text-sm text-muted">{description}</p> : null}
          </div>
          {actions ? <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className="px-5 py-4">{children}</div>
    </section>
  )
}

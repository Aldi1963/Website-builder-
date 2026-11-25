import type { ReactNode } from 'react'

interface CardProps {
  title?: string
  description?: string
  actions?: ReactNode
  children: ReactNode
  className?: string
}

/** Kartu permukaan standar: latar solid, tanpa gradasi. */
export function Card({ title, description, actions, children, className = '' }: CardProps) {
  return (
    <section className={`rounded-xl border border-border bg-surface shadow-sm ${className}`}>
      {title || actions ? (
        <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            {title ? <h2 className="text-base font-semibold">{title}</h2> : null}
            {description ? <p className="mt-0.5 text-sm text-muted">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className="px-5 py-4">{children}</div>
    </section>
  )
}

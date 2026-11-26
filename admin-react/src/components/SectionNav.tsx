import type { ReactNode } from 'react'
import type { Icon } from '@phosphor-icons/react'

export interface SectionNavItem {
  /** Anchor section: dipakai sebagai id dan target #id. */
  id: string
  label: string
  description: string
  icon: Icon
}

interface SectionNavProps {
  items: SectionNavItem[]
  /** Label kecil di atas peta, mis. "Peta halaman". */
  label?: string
}

/** Peta halaman: kartu ringkas yang menaut ke tiap bagian di bawah.
    Bukan kartu fitur generik — ini navigasi padat untuk surface Monitor. */
export function SectionNav({ items, label = 'Peta halaman' }: SectionNavProps) {
  return (
    <nav aria-label={label} className="min-w-0">
      <p className="mb-2 text-xs font-bold tracking-wide text-muted uppercase">{label}</p>
      <ul className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {items.map((item) => {
          const Icon = item.icon
          return (
            <li key={item.id} className="min-w-0">
              <a
                href={`#${item.id}`}
                className="flex h-full min-w-0 items-start gap-2.5 rounded-lg border border-border bg-surface px-3 py-2.5 hover:border-accent hover:bg-surface-muted"
              >
                <Icon size={18} weight="regular" className="mt-0.5 shrink-0 text-accent" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-ink">{item.label}</span>
                  <span className="mt-0.5 block text-xs leading-snug text-muted">{item.description}</span>
                </span>
              </a>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

interface PageSectionProps {
  id: string
  index: number
  title: string
  description: string
  icon: Icon
  children: ReactNode
}

/** Kepala bagian sejajar (ikon + judul + nomor urut), dengan divider tipis. */
export function PageSection({ id, index, title, description, icon: Icon, children }: PageSectionProps) {
  return (
    <section id={id} className="min-w-0 scroll-mt-24 border-t border-border pt-6">
      <header className="mb-4 flex min-w-0 items-start gap-2.5">
        <Icon size={20} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <h2 className="text-base leading-6 font-semibold">{title}</h2>
          <p className="mt-0.5 text-sm text-muted">{description}</p>
        </div>
        <span className="shrink-0 text-xs font-semibold tabular-nums text-muted">
          {String(index).padStart(2, '0')}
        </span>
      </header>
      {children}
    </section>
  )
}

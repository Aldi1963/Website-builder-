import { CaretLeft, CaretRight } from '@phosphor-icons/react'

interface PaginationProps {
  page: number
  totalPages: number
  onPage: (page: number) => void
  total?: number
  label?: string
}

/** Paginasi sederhana: tombol Sebelumnya/Berikutnya + nomor halaman
    (jendela ±2 di sekitar halaman aktif). */
export function Pagination({ page, totalPages, onPage, total, label }: PaginationProps) {
  if (totalPages <= 1) return null
  const pages: number[] = []
  for (let p = 1; p <= totalPages; p++) {
    if (p === 1 || p === totalPages || Math.abs(p - page) <= 2) pages.push(p)
  }
  const btn =
    'rounded-lg border border-border bg-surface px-3 py-1.5 text-sm hover:bg-surface-muted disabled:opacity-40'
  return (
    <nav className="flex flex-wrap items-center gap-2" aria-label="Paginasi">
      <button type="button" className={btn} disabled={page <= 1} onClick={() => onPage(page - 1)}>
        <span className="inline-flex items-center gap-1">
          <CaretLeft size={14} /> Sebelumnya
        </span>
      </button>
      {pages.map((p, i) => (
        <span key={p} className="flex items-center gap-2">
          {i > 0 && pages[i - 1] !== p - 1 ? <span className="text-muted">…</span> : null}
          <button
            type="button"
            aria-current={p === page ? 'page' : undefined}
            onClick={() => onPage(p)}
            className={`rounded-lg px-3 py-1.5 text-sm ${
              p === page ? 'bg-accent font-semibold text-white' : 'border border-border bg-surface hover:bg-surface-muted'
            }`}
          >
            {p}
          </button>
        </span>
      ))}
      <button type="button" className={btn} disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
        <span className="inline-flex items-center gap-1">
          Berikutnya <CaretRight size={14} />
        </span>
      </button>
      {total !== undefined ? (
        <span className="ml-2 text-sm text-muted">
          {label ?? 'Total'}: {total.toLocaleString('id-ID')}
        </span>
      ) : null}
    </nav>
  )
}

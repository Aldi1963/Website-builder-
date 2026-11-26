import type { ReactNode } from 'react'

/* Tabel ASLI — pembungkus overflow-x-auto agar bisa di-scroll menyamping
   di HP. JANGAN ubah tabel menjadi kartu di mobile (keputusan user). */

export function Table({ children, className = '', bare = false }: { children: ReactNode; className?: string; bare?: boolean }) {
  return (
    <div
      className={
        bare
          ? `overflow-x-auto ${className}`
          : `overflow-x-auto rounded-xl border border-border bg-surface shadow-sm ${className}`
      }
    >
      <table className="w-full min-w-max text-left text-sm">{children}</table>
    </div>
  )
}

export function Th({ children, className = '' }: { children?: ReactNode; className?: string }) {
  return (
    <th className={`border-b border-border bg-surface-muted px-4 py-3 font-semibold whitespace-nowrap ${className}`}>
      {children}
    </th>
  )
}

export function Td({ children, className = '', colSpan }: { children: ReactNode; className?: string; colSpan?: number }) {
  return (
    <td colSpan={colSpan} className={`border-b border-border px-4 py-3 align-top last:border-b-0 ${className}`}>
      {children}
    </td>
  )
}

/** Baris empty state standar untuk semua tabel: satu <Td> perentang
    kolom dengan teks muted. Teks per entitas ("Belum ada proyek." dsb.)
    tetap boleh beda, tapi lewat komponen yang sama. */
export function EmptyRow({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr>
      <Td colSpan={colSpan} className="text-muted">
        {children}
      </Td>
    </tr>
  )
}

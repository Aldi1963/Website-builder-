import type { ReactNode } from 'react'

/* Tabel ASLI — pembungkus overflow-x-auto agar bisa di-scroll menyamping
   di HP. JANGAN ubah tabel menjadi kartu di mobile (keputusan user). */

export function Table({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`overflow-x-auto rounded-xl border border-border bg-surface shadow-sm ${className}`}>
      <table className="w-full min-w-max text-left text-sm">{children}</table>
    </div>
  )
}

export function Th({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <th className={`border-b border-border bg-surface-muted px-4 py-3 font-semibold whitespace-nowrap ${className}`}>
      {children}
    </th>
  )
}

export function Td({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <td className={`border-b border-border px-4 py-3 align-top last:border-b-0 ${className}`}>{children}</td>
}

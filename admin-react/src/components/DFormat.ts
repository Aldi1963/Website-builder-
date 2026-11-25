/* Helper format tampilan + kelas tombol bersama (grup D).
   Logika format disalin persis dari SPEC §0.16 / admin.js lama. */

export const fmtNum = (n: number | null | undefined): string =>
  Number(n ?? 0).toLocaleString('id-ID')

export const fmtRp = (n: number | null | undefined): string =>
  n === null || n === undefined ? '–' : `Rp ${fmtNum(n)}`

export const fmtBytes = (n: number | null | undefined): string => {
  if (!n && n !== 0) return '–'
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1048576).toFixed(1)} MB`
}

export const fmtDate = (ts: number | null | undefined): string =>
  ts
    ? new Date(ts).toLocaleString('id-ID', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '–'

export const fmtDateShort = (ts: number | null | undefined): string =>
  ts
    ? new Date(ts).toLocaleDateString('id-ID', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      })
    : '–'

export function timeAgo(ts: number | null | undefined): string {
  if (!ts) return '–'
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return 'baru saja'
  if (s < 3600) return `${Math.floor(s / 60)} mnt lalu`
  if (s < 86400) return `${Math.floor(s / 3600)} jam lalu`
  return `${Math.floor(s / 86400)} hari lalu`
}

/** Kelas tombol (tanpa gradasi, permukaan solid). */
export const btnPrimary =
  'inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50'
export const btnWarningSolid =
  'inline-flex items-center gap-1.5 rounded-lg bg-warning px-4 py-2 text-sm font-medium text-black hover:opacity-90 disabled:opacity-50'
export const btnOutline =
  'inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-muted disabled:opacity-50'
export const btnOutlineSm =
  'inline-flex items-center gap-1 rounded-lg border border-border bg-surface px-2.5 py-1 text-xs font-medium text-ink hover:bg-surface-muted disabled:opacity-50'
export const btnOutlineDangerSm =
  'inline-flex items-center gap-1 rounded-lg border border-danger/40 bg-surface px-2.5 py-1 text-xs font-medium text-danger hover:bg-danger-soft disabled:opacity-50'
export const btnOutlineWarningSm =
  'inline-flex items-center gap-1 rounded-lg border border-warning/40 bg-surface px-2.5 py-1 text-xs font-medium text-warning hover:bg-warning-soft disabled:opacity-50'
export const btnOutlineSuccessSm =
  'inline-flex items-center gap-1 rounded-lg border border-success/40 bg-surface px-2.5 py-1 text-xs font-medium text-success hover:bg-success-soft disabled:opacity-50'

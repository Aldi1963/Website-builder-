/* Kelas tombol bersama (tanpa gradasi, permukaan solid).
   Helper format tampilan tinggal di BFormat — file ini hanya tombol. */

/** Kelas tombol (tanpa gradasi, permukaan solid). */
export const btnPrimary =
  'inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50'
export const btnWarningSolid =
  'inline-flex items-center gap-1.5 rounded-lg bg-warning px-4 py-2 text-sm font-medium text-black hover:opacity-90 disabled:opacity-50'
export const btnOutline =
  'inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-muted disabled:opacity-50'
/** Outline ukuran header (mis. tombol "Muat ulang" di PageHeader). */
export const btnOutlineLg =
  'inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-2 text-sm font-medium text-ink hover:bg-surface-muted disabled:opacity-50'
export const btnOutlineSm =
  'inline-flex items-center gap-1 rounded-lg border border-border bg-surface px-2.5 py-1 text-xs font-medium text-ink hover:bg-surface-muted disabled:opacity-50'
export const btnOutlineDangerSm =
  'inline-flex items-center gap-1 rounded-lg border border-danger/40 bg-surface px-2.5 py-1 text-xs font-medium text-danger hover:bg-danger-soft disabled:opacity-50'
export const btnOutlineWarningSm =
  'inline-flex items-center gap-1 rounded-lg border border-warning/40 bg-surface px-2.5 py-1 text-xs font-medium text-warning hover:bg-warning-soft disabled:opacity-50'
export const btnOutlineSuccessSm =
  'inline-flex items-center gap-1 rounded-lg border border-success/40 bg-surface px-2.5 py-1 text-xs font-medium text-success hover:bg-success-soft disabled:opacity-50'

/* Helper format tampilan — padanan fungsi di admin.js lama (§0.16 SPEC).
   Semua timestamp server adalah epoch milidetik. */

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

/** Huruf pertama name || email, uppercase — untuk avatar inisial. */
export const avatarInitial = (name?: string | null, email?: string | null): string =>
  (name || email || '?').trim().charAt(0).toUpperCase()

/** Pesan error dari catch API: pakai pesan server bila ApiError. */
export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'Gagal memuat.'
}

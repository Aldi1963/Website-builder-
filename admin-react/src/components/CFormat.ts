/* Helper format tampilan — padanan fungsi di admin.js lama (§0.16 SPEC).
   Semua timestamp server adalah epoch milidetik. */

export const fmtNum = (n: number | null | undefined): string =>
  Number(n ?? 0).toLocaleString('id-ID')

export const fmtRp = (n: number | null | undefined): string =>
  n === null || n === undefined ? '–' : `Rp ${fmtNum(n)}`

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

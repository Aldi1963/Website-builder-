/** Format uang: input INTEGER sen, tampil sebagai Rupiah. */
export function formatPrice(cents: number): string {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0,
  }).format(Math.round(cents / 100))
}

/** Format tanggal event dari timestamptz. */
export function formatDate(value: Date | string | null | undefined): string {
  if (!value) return 'Jadwal belum diumumkan'
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return 'Jadwal belum diumumkan'
  return new Intl.DateTimeFormat('id-ID', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }).format(d)
}

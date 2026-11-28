const ALLOWED = [
  /^https?:\/\/(www\.)?(midtrans\.com|docs\.midtrans\.com)\//i,
  /^https?:\/\/(docs\.stripe\.com|stripe\.com\/docs)\//i,
  /^https?:\/\/(developers\.google\.com|developers\.googleapis\.com)\//i,
  /^https?:\/\/(docs\.clipku\.com|m\.clipku\.com)\//i,
  /^https?:\/\/(developer\.gojek\.com)\//i,
]

export type DocResult = { ok: boolean; detail: string; text?: string }

export async function fetchDocs(args: Record<string, unknown>): Promise<DocResult> {
  const url = String(args.url ?? '').trim()
  if (!ALLOWED.some((re) => re.test(url))) {
    return { ok: false, detail: 'ERROR: domain tidak diizinkan. Gunakan dokumentasi resmi Midtrans/Stripe/Google/GoPay/Clipku.' }
  }
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VibeBuilderDocs/1.0)' },
      signal: AbortSignal.timeout(25_000),
    })
    if (!res.ok) return { ok: false, detail: `ERROR: HTTP ${res.status} saat mengambil dokumentasi.` }
    const html = (await res.text()).slice(0, 400_000)
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, 12_000)
    return { ok: true, detail: `Dokumentasi diambil dari ${new URL(url).hostname}.`, text }
  } catch (e) {
    return { ok: false, detail: `ERROR: gagal mengambil dokumentasi: ${(e as Error).message.slice(0, 200)}` }
  }
}

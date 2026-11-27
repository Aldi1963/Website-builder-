/*
 * Rate limit in-memory untuk endpoint auth & LLM berbayar.
 *
 * Tidak ada dependency baru: cukup peta IP -> { UNIX ms dari attempt }.
 * Bersifat best-effort (reset saat proses restart) dan sengaja tidak
 * dipakai sebagai satu-satunya pengaman. Tujuannya menghentikan brute-force
 * dan pembakaran kreditLLM oleh client anonim.
 */
type Bucket = { times: number[] }

const buckets = new Map<string, Bucket>()
const WINDOW_MS_DEFAULT = 60_000

export type RateLimitResult = { ok: boolean; retryAfter: number; remaining: number }

/* Bersihkan bucket lama supaya peta tidak tumbuh tanpa batas. */
function sweep(now: number, windowMs: number) {
  const cutoff = now - windowMs
  for (const [key, bucket] of buckets) {
    bucket.times = bucket.times.filter((t) => t > cutoff)
    if (!bucket.times.length) buckets.delete(key)
  }
}

export function rateLimit(
  key: string,
  max: number,
  windowMs = WINDOW_MS_DEFAULT,
  now = Date.now(),
): RateLimitResult {
  sweep(now, windowMs)
  const bucket = buckets.get(key) ?? { times: [] }
  const cutoff = now - windowMs
  bucket.times = bucket.times.filter((t) => t > cutoff)
  if (bucket.times.length >= max) {
    buckets.set(key, bucket)
    const retryAfter = Math.max(1, Math.ceil((bucket.times[0] + windowMs - now) / 1000))
    return { ok: false, retryAfter, remaining: 0 }
  }
  bucket.times.push(now)
  buckets.set(key, bucket)
  return { ok: true, retryAfter: 0, remaining: Math.max(0, max - bucket.times.length) }
}

/* Dipakai test untuk isolasi antar kasus. */
export function resetRateLimits() {
  buckets.clear()
}

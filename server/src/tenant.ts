/**
 * Preview tenant isolation helpers.
 * - stripPlatformAuth: buang cookie sesi + Authorization sebelum forward ke tenant.
 * - mintPreviewToken / verifyPreviewToken: token integrasi per-proyek (HMAC-SHA256).
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

function tokenSecret(): string {
  return process.env.VB_PREVIEW_TOKEN_SECRET ?? process.env.VB_LLM_KEY ?? 'vibebuilder-preview-token'
}

export function stripPlatformAuth(headers: Headers, sessionCookie?: string): Headers {
  const h = new Headers(headers)
  h.delete('authorization')
  const cookies = h.get('cookie')
  if (cookies) {
    const name = sessionCookie ?? 'vb_session'
    const kept = cookies.split(';').map((p) => p.trim()).filter((p) => p && !p.startsWith(`${name}=`))
    if (kept.length) h.set('cookie', kept.join('; '))
    else h.delete('cookie')
  }
  h.delete('x-vb-user')
  h.delete('x-vb-token')
  return h
}

export function mintPreviewToken(projectId: string, extra = ''): string {
  return createHmac('sha256', tokenSecret() + extra).update(projectId).digest('hex')
}

export function verifyPreviewToken(projectId: string, token: string, extra = ''): boolean {
  const expected = createHmac('sha256', tokenSecret() + extra).update(projectId).digest()
  let given: Buffer
  try { given = Buffer.from(token, 'hex') } catch { return false }
  if (given.length !== expected.length) return false
  return timingSafeEqual(given, expected)
}

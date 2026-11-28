import assert from 'node:assert/strict'
import test from 'node:test'
import { allowedOrigin } from '../src/cors.ts'
import { rateLimit, resetRateLimits } from '../src/rate-limit.ts'
import { sessionCookie, clearCookie } from '../src/auth.ts'

test('CORS menolak origin asing dan null, menerima origin sendiri', () => {
  const req = 'https://clidi.net/api/auth/me'
  assert.equal(allowedOrigin('https://evil.example.com', req), undefined)
  assert.equal(allowedOrigin('null', req), undefined)
  assert.equal(allowedOrigin(undefined, req), undefined)
  assert.equal(allowedOrigin('https://clidi.net', req), 'https://clidi.net')
  assert.equal(allowedOrigin('http://localhost:5173', req), 'http://localhost:5173')
})

test('CORS menerima subdomain aplikasi publish yang dikonfigurasi', () => {
  process.env.VB_PUBLIC_SUFFIX = 'vibe.clipku.com'
  assert.equal(
    allowedOrigin('https://app.vibe.clipku.com', 'https://clidi.net/api/health'),
    'https://app.vibe.clipku.com',
  )
  assert.equal(
    allowedOrigin('https://evil.vibe.clipku.com.attacker.tld', 'https://clidi.net/api/health'),
    undefined,
  )
  delete process.env.VB_PUBLIC_SUFFIX
})

test('rate limit memblokir setelah kuota habis dan menghitung retry-after', () => {
  resetRateLimits()
  for (let i = 0; i < 3; i++) assert.equal(rateLimit('ip:1.2.3.4', 3, 60_000, 1000).ok, true)
  const blocked = rateLimit('ip:1.2.3.4', 3, 60_000, 1000)
  assert.equal(blocked.ok, false)
  assert.equal(blocked.retryAfter, 60)
  /* Window lama sudah lewat -> boleh lagi */
  assert.equal(rateLimit('ip:1.2.3.4', 3, 60_000, 61_000).ok, true)
  resetRateLimits()
})

test('cookie sesi dan logout memakai atribut Secure + HttpOnly + SameSite', () => {
  const session = sessionCookie('abc', 3600)
  assert.match(session, /HttpOnly/)
  assert.match(session, /Secure/)
  assert.match(session, /SameSite=Lax/)
  assert.match(session, /Max-Age=3600/)
  const cleared = clearCookie()
  assert.match(cleared, /Secure/)
  assert.match(cleared, /Max-Age=0/)
})

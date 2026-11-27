import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/* Redeem code (28 Nov 2026): kode dibuat admin, ditukar pengguna di halaman
   Penggunaan menjadi credit bucket `purchased`. Uji end-to-end lewat HTTP
   dengan DB scratch: validasi, batas, kedaluwarsa, nonaktif, batas per
   user, pesan gagal generik (tanpa oracle), rate-limit, dan atomicity
   (redemption + saldo terjadi bersama, tidak setengah-setengah). */

const root = mkdtempSync(join(tmpdir(), 'vb-redeem-'))
process.env.VB_DB = join(root, 'test.db')

const { createUser, createSession, SESSION_COOKIE } = await import('../src/auth.ts')
const { db } = await import('../src/db.ts')
const { app } = await import('../src/app.ts')
const { REDEEM_GENERIC_ERROR } = await import('../src/redeem.ts')
const { resetRateLimits } = await import('../src/rate-limit.ts')

/* Rate-limit dihitung per user per menit di seluruh file test ini — reset
   antar test supaya tiap kasus mengukur perilakunya sendiri, bukan sisa
   percobaan test sebelumnya. (Test rate-limit sendiri tetap menguji 6
   percobaan beruntun di dalam satu test.) */
test.beforeEach(() => resetRateLimits())

const admin = createUser('admin-redeem@example.test', 'Admin', 'admin-redeem-test-only')
const userA = createUser('user-a-redeem@example.test', 'User A', 'user-a-redeem-test-only')
const userB = createUser('user-b-redeem@example.test', 'User B', 'user-b-redeem-test-only')
const userC = createUser('user-c-redeem@example.test', 'User C', 'user-c-redeem-test-only')

const headersFor = (u) => {
  const { token } = createSession(u.id)
  return { cookie: `${SESSION_COOKIE}=${token}`, 'content-type': 'application/json' }
}
const adminH = headersFor(admin)
const userAH = headersFor(userA)
const userBH = headersFor(userB)
const userCH = headersFor(userC)

const post = (path, headers, body) =>
  app.request(path, { method: 'POST', headers, body: JSON.stringify(body) })
const get = (path, headers) => app.request(path, { headers })

async function createCode(body, headers = adminH) {
  const res = await post('/api/admin/redeem/codes', headers, body)
  if (res.status !== 201) assert.fail(`buat kode gagal (${res.status}): ${await res.text()}`)
  return (await res.json()).code
}

async function redeem(code, headers) {
  return post('/api/redeem', headers, { code })
}

function balanceOf(userId) {
  return db.prepare(`SELECT purchased_balance AS purchased FROM credits WHERE user_id = ?`).get(userId)
}

test.after(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('admin: buat kode manual + generate, format CLIDI-XXXX-XXXX-XXXX', async () => {
  const manual = await createCode({ code: 'WELCOME500', credits: 500 })
  assert.equal(manual.code, 'WELCOME500')
  assert.equal(manual.credits, 500)
  assert.equal(manual.maxUses, 1)
  assert.equal(manual.perUserLimit, 1)
  assert.equal(manual.active, true)

  const generated = await createCode({ credits: 250 })
  assert.match(generated.code, /^CLIDI-[2-9A-HJ-KM-NP-TV-Z]{4}-[2-9A-HJ-KM-NP-TV-Z]{4}-[2-9A-HJ-KM-NP-TV-Z]{4}$/)
  assert.equal(generated.credits, 250)
})

test('admin: kode duplikat ditolak; non-admin tidak boleh membuat kode', async () => {
  const res = await post('/api/admin/redeem/codes', adminH, { code: 'WELCOME500', credits: 100 })
  assert.equal(res.status, 400)
  const forbidden = await post('/api/admin/redeem/codes', userAH, { credits: 100 })
  assert.equal(forbidden.status, 403)
})

test('redeem valid: saldo purchased bertambah + transaksi kind=redeem + uses=1', async () => {
  const code = await createCode({ credits: 500 })
  const before = balanceOf(userA.id).purchased
  const res = await redeem(code.code, userAH)
  if (res.status !== 200) assert.fail(`redeem gagal (${res.status}): ${await res.text()}`)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.credits, 500)
  assert.equal(balanceOf(userA.id).purchased, before + 500)
  const tx = db
    .prepare(`SELECT kind, bucket, amount, reason FROM credit_transactions WHERE user_id = ? AND kind = 'redeem' ORDER BY id DESC LIMIT 1`)
    .get(userA.id)
  assert.equal(tx.kind, 'redeem')
  assert.equal(tx.bucket, 'purchased')
  assert.equal(tx.amount, 500)
  assert.match(tx.reason, /WELCOME|CLIDI/)
  const row = db.prepare(`SELECT uses FROM redeem_codes WHERE id = ?`).get(code.id)
  assert.equal(row.uses, 1)
  const redemption = db
    .prepare(`SELECT COUNT(*) AS n FROM redeem_redemptions WHERE code_id = ? AND user_id = ?`)
    .get(code.id, userA.id)
  assert.equal(redemption.n, 1)
})

test('redeem ke-2 user sama (limit 1) ditolak dengan pesan generik', async () => {
  const code = await createCode({ credits: 100 })
  assert.equal((await redeem(code.code, userAH)).status, 200)
  const before = balanceOf(userA.id).purchased
  const again = await redeem(code.code, userAH)
  assert.equal(again.status, 400)
  assert.equal((await again.json()).error, REDEEM_GENERIC_ERROR)
  assert.equal(balanceOf(userA.id).purchased, before) // percobaan gagal tidak mengubah saldo
})

test('kode kedaluwarsa, max_uses habis, dan nonaktif semuanya ditolak generik', async () => {
  const expired = await createCode({ credits: 100, expiresAt: Date.now() + 60_000 })
  db.prepare(`UPDATE redeem_codes SET expires_at = ? WHERE id = ?`).run(Date.now() - 1000, expired.id)
  const r1 = await redeem(expired.code, userBH)
  assert.equal(r1.status, 400)
  assert.equal((await r1.json()).error, REDEEM_GENERIC_ERROR)

  const once = await createCode({ credits: 100, maxUses: 1 })
  assert.equal((await redeem(once.code, userAH)).status, 200)
  const r2 = await redeem(once.code, userBH)
  assert.equal(r2.status, 400)
  assert.equal((await r2.json()).error, REDEEM_GENERIC_ERROR)

  const killed = await createCode({ credits: 100 })
  const deact = await post(`/api/admin/redeem/codes/${killed.id}/deactivate`, adminH, {})
  assert.equal(deact.status, 200)
  const r3 = await redeem(killed.code, userBH)
  assert.equal(r3.status, 400)
  assert.equal((await r3.json()).error, REDEEM_GENERIC_ERROR)
})

test('kode tidak ada → pesan generik yang SAMA (tanpa oracle)', async () => {
  const ghost = await redeem('CLIDI-ZZZZ-ZZZZ-ZZZZ', userBH)
  assert.equal(ghost.status, 400)
  assert.equal((await ghost.json()).error, REDEEM_GENERIC_ERROR)
  const expired = await createCode({ credits: 50, expiresAt: Date.now() + 60_000 })
  db.prepare(`UPDATE redeem_codes SET expires_at = ? WHERE id = ?`).run(Date.now() - 1000, expired.id)
  const gone = await redeem(expired.code, userBH)
  assert.equal((await gone.json()).error, REDEEM_GENERIC_ERROR)
})

test('pembatasan user: hanya user yang diizinkan bisa menukar', async () => {
  const code = await createCode({ credits: 100, allowedUserIds: [userA.id] })
  const denied = await redeem(code.code, userBH)
  assert.equal(denied.status, 400)
  assert.equal((await denied.json()).error, REDEEM_GENERIC_ERROR)
  const ok = await redeem(code.code, userAH)
  assert.equal(ok.status, 200)
})

test('atomicity: dua redeem bersamaan hanya satu yang berhasil, saldo masuk sekali', async () => {
  /* per_user_limit=2: keduanya boleh berhasil, saldo masuk 2× (bukan 1× atau 3×). */
  const code = await createCode({ credits: 300, maxUses: 2, perUserLimit: 2 })
  const before = balanceOf(userC.id).purchased
  const [r1, r2] = await Promise.all([redeem(code.code, userCH), redeem(code.code, userCH)])
  if (r1.status !== 200) assert.fail(`redeem 1 gagal (${r1.status}): ${await r1.text()}`)
  if (r2.status !== 200) assert.fail(`redeem 2 gagal (${r2.status}): ${await r2.text()}`)
  assert.equal(balanceOf(userC.id).purchased, before + 600)
  /* per_user_limit=1: race dua request bersamaan — tepat satu yang lolos. */
  const race = await createCode({ credits: 300, maxUses: 5, perUserLimit: 1 })
  const beforeRace = balanceOf(userB.id).purchased
  const [a, b] = await Promise.all([redeem(race.code, userBH), redeem(race.code, userBH)])
  const okCount = [a.status, b.status].filter((s) => s === 200).length
  assert.equal(okCount, 1)
  assert.equal(balanceOf(userB.id).purchased, beforeRace + 300)
  const uses = db.prepare(`SELECT uses FROM redeem_codes WHERE id = ?`).get(race.id).uses
  assert.equal(uses, 1)
  const redemptions = db
    .prepare(`SELECT COUNT(*) AS n FROM redeem_redemptions WHERE code_id = ? AND user_id = ?`)
    .get(race.id, userB.id).n
  assert.equal(redemptions, 1)
})

test('rate-limit: percobaan ke-6 dalam semenit ditolak 429', async () => {
  const fresh = createUser('user-rl-redeem@example.test', 'User RL', 'user-rl-redeem-test-only')
  const h = headersFor(fresh)
  const statuses = []
  for (let i = 0; i < 6; i++) {
    const res = await redeem('CLIDI-XXXX-XXXX-XXXX', h)
    statuses.push(res.status)
  }
  assert.deepEqual(statuses.slice(0, 5), [400, 400, 400, 400, 400])
  assert.equal(statuses[5], 429)
})

test('admin: daftar kode + daftar penukaran', async () => {
  const list = await get('/api/admin/redeem/codes', adminH)
  assert.equal(list.status, 200)
  const codes = (await list.json()).codes
  assert.ok(Array.isArray(codes) && codes.length >= 5)
  assert.ok(codes.every((c) => typeof c.code === 'string' && typeof c.credits === 'number'))
  const red = await get('/api/admin/redeem/redemptions?limit=50', adminH)
  assert.equal(red.status, 200)
  const redemptions = (await red.json()).redemptions
  assert.ok(Array.isArray(redemptions) && redemptions.length >= 3)
  assert.ok(redemptions.every((r) => typeof r.email === 'string' || r.email === null))
  const forbidden = await get('/api/admin/redeem/codes', userAH)
  assert.equal(forbidden.status, 403)
})

/* Kontrak penyederhanaan menu + monetisasi berbasis Credit.
   Jalankan: cd admin-react && node --test tests/simplify.test.mjs */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'

const root = new URL('../', import.meta.url)
const src = (p) => fileURLToPath(new URL(p, root))
const jiti = createJiti(import.meta.url, { interopDefault: true, jsx: true })
globalThis.React ??= await import('react')
const { ROUTES, ADMIN_SECTIONS, matchRoute } = await jiti.import(src('src/routes.ts'))
const read = (p) => readFileSync(src(p), 'utf8')
const monetisasi = read('src/pages/monetisasi.tsx')
const credits = read('src/pages/credits.tsx')
const billing = read('src/pages/billing.tsx')

const VISIBLE_SUBS = ['credits', 'providers', 'ai-settings', 'biaya', 'usage', 'health', 'cadangan', 'settings']
const HIDDEN_SUBS = ['projects', 'moderasi', 'domain', 'plans', 'billing', 'messages', 'pengumuman', 'audit', 'sessions', 'builds', 'pembersihan', 'pemeliharaan']

test('sidebar 15 entri: 7 induk + 8 sub (12 hidden dari 27)', () => {
  const all = ADMIN_SECTIONS.flatMap((s) => s.slugs)
  assert.equal(all.length, 15, `expected 15 menu, got ${all.length}: ${all.join(', ')}`)
  assert.deepEqual(ADMIN_SECTIONS.map((s) => s.label), ['Utama', 'Konten', 'Layanan', 'Sistem'])
  const visible = ROUTES.filter((r) => !r.hidden)
  assert.equal(visible.length, 15)
  for (const slug of VISIBLE_SUBS) assert.ok(all.includes(slug), `${slug} harus tetap terlihat`)
  for (const slug of HIDDEN_SUBS) {
    assert.ok(!all.includes(slug), `${slug} tidak boleh jadi menu tersendiri`)
    assert.equal(ROUTES.find((r) => r.slug === slug)?.hidden, true, `${slug} route tetap ada tapi hidden`)
    assert.equal(matchRoute(`/admin/${slug}`)?.route?.slug, slug, `URL /admin/${slug} tetap jalan`)
  }
})

test('monetisasi berbasis Credit: tidak ada plan langganan / harga bulanan', () => {
  assert.doesNotMatch(monetisasi, /PlansPage|<PlansPage/, 'halaman monetisasi tidak boleh merender Plan')
  assert.match(monetisasi, /Paket Credit|Kelola Credit/, 'harus ada bagian Credit')
  assert.match(monetisasi, /BillingPage|Paket Credit/, 'harus ada bagian top-up / pembayaran')
  assert.doesNotMatch(monetisasi, /subscription|Rp\s*49\.000/i, 'tidak boleh ada copy paket langganan berbayar')
  assert.doesNotMatch(monetisasi, /(baca |beli |paket |model )langganan/i, 'tidak boleh menjual langganan')
  // Halaman Credit tidak lagi menyebut jatah Plan Gratis/Pro bulanan.
  assert.doesNotMatch(credits, /Gratis 100\/bln, Pro 2\.000\/bln/, 'copy jatah plan lama harus dihapus')
  assert.doesNotMatch(billing, /subscription|(baca |beli |paket |model )langganan/i)
})

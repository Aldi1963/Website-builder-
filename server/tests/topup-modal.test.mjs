import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/* Top-up credit sebagai POPUP (modal), bukan halaman terpisah (27 Nov 2026):
   semua pemicu (tombol Top-up sidebar, halaman Penggunaan, banner
   "credit habis" di chat) membuka modal yang sama; halaman server-rendered
   /topup lama dihapus dan GET /topup redirect ke /#topup (SPA membuka
   modal saat dimuat dengan hash itu). Alur pembayaran + API tidak berubah:
   paket, buat order, QR, polling, sync, cancel. Root dihitung relatif dari
   file ini supaya test menguji repo yang sedang dijalankan. */
const root = new URL('../..', import.meta.url).pathname
const read = (rel) => readFileSync(join(root, rel), 'utf8')

test('topup modal: komponen + pemicu event + tutup (X/backdrop/Escape) + kunci scroll', () => {
  const modal = read('platform/src/topup-modal.tsx')
  assert.match(modal, /export function openTopupModal/)
  assert.match(modal, /export function TopupModal/)
  assert.match(modal, /vb:open-topup/)
  assert.match(modal, /role="dialog"/)
  assert.match(modal, /aria-modal="true"/)
  assert.match(modal, /if \(e\.key === 'Escape'\)/)
  assert.match(modal, /onClick=\{doClose\}/)
  assert.match(modal, /document\.body\.style\.overflow = 'hidden'/)
  assert.match(modal, /#topup/)
  assert.match(modal, /setInterval\(\(\) => void refreshCurrent\(\), 5000\)/)
})

test('topup modal: isi + alur sama dengan halaman lama (paket, QR, sync, cancel)', () => {
  const modal = read('platform/src/topup-modal.tsx')
  assert.match(modal, /\/api\/billing\/balance/)
  assert.match(modal, /\/api\/billing\/orders/)
  assert.match(modal, /api\.qrserver\.com\/v1\/create-qr-code/)
  assert.match(modal, /\/sync/)
  assert.match(modal, /\/cancel/)
  assert.match(modal, /vb:balance-changed/)
  /* Tidak ada lagi tautan ke halaman /topup di SPA. */
  for (const f of ['platform/src/billing-ui.tsx', 'platform/src/panels.tsx', 'platform/src/App.tsx']) {
    assert.doesNotMatch(read(f), /href="\/topup"/, f)
  }
  /* Semua pemicu top-up membuka popup yang sama: chip credit di header,
     tombol Top-up sidebar, 2 tombol di halaman Penggunaan. */
  const billingUi = read('platform/src/billing-ui.tsx')
  assert.ok(
    (billingUi.match(/onClick=\{openTopupModal\}/g) ?? []).length >= 4,
    'chip credit + Top-up sidebar + 2 tombol Penggunaan harus memanggil openTopupModal',
  )
  const app = read('platform/src/App.tsx')
  assert.ok(
    (app.match(/<TopupModal \/>/g) ?? []).length >= 3,
    'TopupModal terpasang di tiap layout (workspace, penggunaan, beranda)',
  )
})

test('topup modal: GET /topup lama redirect ke /#topup, halaman server dihapus', async () => {
  const billing = read('server/src/billing.ts')
  assert.match(billing, /c\.redirect\('\/#topup', 302\)/)
  assert.doesNotMatch(billing, /function topupPage/)
  assert.doesNotMatch(billing, /c\.html\(topupPage\(\)\)/)

  const dir = mkdtempSync(join(tmpdir(), 'vb-topup-'))
  process.env.VB_DB = join(dir, 'test.db')
  const { app } = await import('../src/app.ts')
  try {
    const res = await app.request('/topup', { redirect: 'manual' })
    assert.equal(res.status, 302)
    assert.equal(res.headers.get('location'), '/#topup')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

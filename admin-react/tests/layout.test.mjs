/* Regresi: dropdown notifikasi tidak boleh terkliping di layar sempit.
   Tailwind 4 mengompilasi `w-[min(360px,calc(100vw-24px))]` menjadi
   `width: min(360px,100vw - 24px)` (calc hilang) → aturan invalid →
   dropdown kehilangan lebar dan tepi kirinya terpotong.
   Jalankan: cd admin-react && node --test tests/layout.test.mjs */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const src = (p) => fileURLToPath(new URL(p, root))
const layout = readFileSync(src('src/layout.tsx'), 'utf8')

test('dropdown notifikasi memakai lebar calc() yang valid', () => {
  const match = layout.match(/absolute right-0 z-50 mt-2 ([^"']+) overflow-hidden/)
  assert.ok(match, 'dropdown notifikasi harus punya class absolute right-0')
  const cls = match[1]
  assert.doesNotMatch(cls, /w-\[min\([^\]]*100vw[^\]]*\)\]/, 'jangan pakai w-[min(...)] — Tailwind 4 membuang calc() saat kompilasi')
  assert.match(cls, /w-\[calc\(100vw-24px\)\]|w-\[min\(360px,calc\([^\]]*\)\)\]/, 'harus mengandung calc() eksplisit')
})

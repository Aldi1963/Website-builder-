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

/* Regresi 26 Nov 2026 (laporan HP user): lebar sudah benar tapi panel tetap
   terpotong kiri, karena `absolute right-0` menempel ke tombol lonceng
   sementara panel (336px di viewport 360px) lebih lebar dari ruang di kiri
   lonceng (~38px meluber). Di layar sempit panel harus `fixed` menempel
   viewport (kanan 12px, di bawah header), bukan ke lonceng. */
test('dropdown notifikasi di layar sempit menempel viewport, bukan lonceng', () => {
  // Tangkap SELURUH class (sampai tanda kutip penutup), bukan hanya sampai
  // overflow-hidden — class max-sm:* ada sesudahnya.
  const match = layout.match(/absolute right-0 z-50 mt-2 ([^"']+)"/)
  assert.ok(match, 'dropdown notifikasi harus punya class absolute right-0')
  const cls = match[1]
  assert.match(cls, /max-sm:fixed/, 'harus max-sm:fixed supaya tidak meluber ke kiri viewport')
  assert.match(cls, /max-sm:top-\[64px\]/, 'harus max-sm:top-[64px] (tepat di bawah header)')
  assert.match(cls, /max-sm:right-3/, 'harus max-sm:right-3 (tepi kanan 12px dari viewport)')
})

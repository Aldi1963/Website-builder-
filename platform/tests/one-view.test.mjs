/* One-view: dari file viewer kembali ke daftar proyek tidak boleh mengulang
   dari Chat. State tab + file dibuka dipertahankan per proyek.
   Jalankan: cd platform && node --test tests/one-view.test.mjs */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

test('tab & file viewer dipertahankan per proyek saat balik dari daftar proyek', () => {
  assert.match(src, /VIEW_KEY\s*=\s*\(id:/, 'harus ada kunci state per proyek')
  assert.match(src, /loadView\(projectId\)\.tab/, 'tab harus di-init dari state tersimpan')
  assert.match(src, /loadView\(projectId\)\.file/, 'file harus di-init dari state tersimpan')
  assert.match(src, /saveView\(projectId,\s*\{\s*tab,\s*file:\s*openFile\s*\}\)/, 'tab + file disimpan tiap berubah')
  assert.match(src, /if \(saved\.tab === 'code' && saved\.file\) void openFileAt\(saved\.file\)/, 'file dibuka ulang saat masuk workspace')
})

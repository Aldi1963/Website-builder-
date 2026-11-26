/* Route adalah sumber kebenaran tampilan workspace; file yang dibuka tetap
   dipertahankan per proyek lewat localStorage (vb-view-<id>).
   Jalankan: cd platform && node --test tests/*.mjs */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

test('tab mengikuti route (/chat default, /file, /database)', () => {
  assert.match(src, /matchPath\('\/proyek\/:id\/file', path\)/)
  assert.match(src, /routeTab: Tab/)
  assert.match(src, /useState<Tab>\(routeTab\)/)
  assert.match(src, /setTab\(routeTab\)/)
})

test('file yang dibuka dipertahankan per proyek & dibuka ulang di route /file', () => {
  assert.match(src, /VIEW_KEY\s*=\s*\(id:/, 'kunci state per proyek')
  assert.match(src, /saveView\(projectId,\s*\{\s*tab,\s*file:\s*openFile\s*\}/)
  assert.match(src, /if \(saved\.tab === 'code' && saved\.file && routeTab !== 'chat'\) void openFileAt\(saved\.file\)/)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const root = '/home/hatch/workspace/vibebuilder/'
const app = readFileSync(root + 'platform/src/App.tsx', 'utf8')
const server = readFileSync(root + 'server/src/app.ts', 'utf8')

test('tabel database: lebar natural + scroll horizontal, bukan kolom menyusut', () => {
  const block = app.slice(app.indexOf("mode === 'Browse'"), app.indexOf("mode === 'Structure'"))
  assert.match(block, /min-w-max|w-max|table-auto/)
  assert.match(block, /overflow-(x-)?auto/)
  assert.doesNotMatch(block, /table className="w-full/)
  assert.match(block, /truncate|line-clamp/)
  assert.match(block, /title=\{/)
})

test('tabel database: NULL ditampilkan eksplisit, bukan string kosong', () => {
  assert.match(app, /NULL/) // ada label NULL di UI
  const conversions = [...server.matchAll(/out\[k\] = v === null \? ([^:]+) :/g)].map((m) => m[1].trim())
  assert.ok(conversions.length >= 2, `minimal dua konversi baris (database + query), dapat ${conversions.length}`)
  assert.ok(conversions.every((v) => v === "null"), `NULL harus dipertahankan, dapat ${JSON.stringify(conversions)}`)
})

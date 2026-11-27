import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const src = readFileSync('/home/hatch/workspace/vibebuilder/platform/src/panels.tsx', 'utf8')
const start = src.indexOf('function FileTreeRow(')
const block = src.slice(start, src.indexOf('/* ', start + 10))

test('file tree: baris rapat di mobile (maks 28px), bukan 40px + padding', () => {
  assert.ok(block.length > 200, 'blok FileTreeRow tidak ditemukan')
  assert.doesNotMatch(block, /max-md:min-h-\[\d+px\]/)
  assert.match(block, /h-7\b/)
  const rows = [...block.matchAll(/className="flex h-7[^"]*"|className=\{`flex h-7[^`]*`/g)]
  assert.ok(rows.length >= 2, `harus ada baris folder + file, dapat ${rows.length}`)
  assert.doesNotMatch(block, /\bh-(8|9|10|12)\b/, 'tinggi baris seragam 28px (h-7)')
  assert.doesNotMatch(block, /min-h-\[\d+px\][^"]*\bpy-1\b/, 'padding vertikal menambah tinggi baris')
})

test('file tree: indent per kedalaman tidak berlebih', () => {
  const indents = [...block.matchAll(/10 \+ depth \* (\d+)/g)].map((m) => Number(m[1]))
  assert.ok(indents.length >= 1, 'tidak ada perhitungan indent')
  assert.ok(indents.every((n) => n <= 10), `indent terlalu lebar: ${indents}`)
})

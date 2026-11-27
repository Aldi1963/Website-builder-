import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const root = '/home/hatch/workspace/vibebuilder/'
const app = readFileSync(root + 'platform/src/App.tsx', 'utf8')
const api = readFileSync(root + 'platform/src/api.ts', 'utf8')
const panels = readFileSync(root + 'platform/src/panels.tsx', 'utf8')
const ui = readFileSync(root + 'platform/src/ui.tsx', 'utf8')
const server = readFileSync(root + 'server/src/app.ts', 'utf8')

test('SQL console: endpoint query dipanggil UI dengan batas baris', () => {
  assert.match(api, /dbQuery:\s*\(id:\s*string,\s*sql:\s*string,\s*limit\s*=\s*\d+\)/)
  assert.match(api, /\/api\/projects\/\$\{id\}\/database\/query/)
  assert.ok(sqlPayloadHasLimit(api), 'body query harus mengirim batas baris')
  assert.match(app, /const \[query, setQuery\]/)
  assert.match(app, /Jalankan query|Jalankan SQL|Run SQL/)
})

function sqlPayloadHasLimit(src) {
  const i = src.indexOf('/api/projects/${id}/database/query')
  return i >= 0 && /\{ method: 'POST', body: JSON\.stringify\(\{ sql, limit \}\) \}/.test(src.slice(i, i + 600))
}

test('SQL console: server memakai validator tokenisasi dan membatasi hasil', () => {
  assert.match(server, /validateProjectSql\('query',\s*body\.sql/)
  assert.match(server, /database\/query/)
  assert.match(server, /LIMIT\s+\$\d|\.slice\(0,\s*\d+\)/)
  assert.doesNotMatch(server, /pool\.query\(\s*body\.sql\s*\)/)
})

test('file tree: panel menyusun tree bertingkat dari path', () => {
  assert.match(panels, /function buildFileTree|function buildTree/)
  assert.match(panels, /expanded|collapsed|FoldersIcon|folder/)
  assert.match(panels, /aria-expanded/)
  assert.doesNotMatch(panels.replace(/\.replace\(\/\^src\\\/\//, ''), /f\.path\.replace\(\/\^src\\\/\//)
})

test('file tree: ikon folder tersedia', () => {
  assert.match(ui, /folder:/)
})

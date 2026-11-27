import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const root = new URL('../..', import.meta.url).pathname
const app = readFileSync(root + 'platform/src/database-ui.tsx', 'utf8')
const api = readFileSync(root + 'platform/src/api.ts', 'utf8')
const panels = readFileSync(root + 'platform/src/panels.tsx', 'utf8')
const ui = readFileSync(root + 'platform/src/ui.tsx', 'utf8')
const server = readFileSync(root + 'server/src/app.ts', 'utf8')

test('SQL console: endpoint query dipanggil UI dengan batas baris', () => {
  assert.match(api, /dbQuery:\s*\(id:\s*string,\s*sql:\s*string,\s*limit\s*=\s*\d+\)/)
  assert.match(api, /\/api\/projects\/\$\{id\}\/database\/query/)
  assert.ok(sqlPayloadHasLimit(api), 'body query harus mengirim batas baris')
  assert.match(app, /const \[sql, setSql\]/)
  assert.match(app, /Jalankan \(Ctrl\+Enter\)/)
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

test('database page: panduan eksplisit bila DB aktif tapi nol tabel', () => {
  assert.match(app, /Belum ada tabel di database ini/)
  assert.match(app, /CREATE TABLE users \(id serial primary key, email text unique\)/)
  assert.match(app, /tables\.length === 0/)
})

test('database page: tab Struktur memuat detail dulu, tanpa heading kosong', () => {
  assert.match(app, /mode !== 'sql' && mode !== 'export'/)
  assert.match(app, /Belum ada tabel yang dipilih/)
  assert.match(app, /detailLoading && !detail\?\.columns/)
})

test('database page: sesudah DML di SQL Editor, detail browse ikut disegarkan', () => {
  const runSql = app.slice(app.indexOf('const runSql'))
  assert.match(runSql, /void load\(\)\.then\(\(\) => \{ if \(selected\) void loadTable\(selected, search, page\) \}\)/)
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

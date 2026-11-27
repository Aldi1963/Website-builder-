import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const root = '/home/hatch/workspace/vibebuilder/'
const server = readFileSync(root + 'server/src/app.ts', 'utf8')
const app = readFileSync(root + 'platform/src/App.tsx', 'utf8')
const api = readFileSync(root + 'platform/src/api.ts', 'utf8')

function unwrap(src) { return src.replace(/\\n/g, '\n').replace(/\\'/g, "'") }

test('server: endpoint detail tabel memvalidasi nama ke katalog dan pakai parameter filter', () => {
  assert.match(server, /\/api\/projects\/:id\/database\/table/)
  const block = server.slice(server.indexOf("app.get('/api/projects/:id/database/table'"), server.indexOf("app.get('/api/projects/:id/database/table'") + 4500)
  assert.match(block, /information_schema\.tables/)
  assert.match(block, /\$1/)  // filter/offset binding, bukan interpolasi
  assert.match(block, /LIMIT \$|OFFSET \$/)
  assert.match(block, /is_nullable|column_default/)
})

test('server: endpoint export menghasilkan CREATE TABLE + INSERT aman', () => {
  assert.match(server, /\/api\/projects\/:id\/database\/export/)
  const block = server.slice(server.indexOf("app.get('/api/projects/:id/database/export'"), server.indexOf("app.get('/api/projects/:id/database/export'") + 5000)
  assert.match(block, /CREATE TABLE/)
  assert.match(block, /INSERT INTO/)
  assert.match(block, /information_schema\.columns|pg_catalog/)
  assert.doesNotMatch(block, /DROP TABLE|TRUNCATE/)
})

test('api: klien punya method table + export', () => {
  assert.match(api, /databaseTable\s*[:(]/)
  assert.match(api, /databaseExport\s*[:(]/)
  assert.match(api, /\/database\/table\?/)
  assert.match(api, /\/database\/export`/)
})

test('UI: panel database bergaya phpMyAdmin (sidebar tabel + tab Browse/Structure/SQL/Export)', () => {
  assert.match(app, /Cari tabel|filter tabel/i)
  assert.match(app, /role="tablist"/)
  for (const tab of ['Browse', 'Structure', 'SQL', 'Export']) {
    assert.ok(app.includes(`'${tab}'`) || app.includes(`>${tab}<`), `tab ${tab} tidak ada`)
  }
  assert.match(app, /databaseExport\(/)
  assert.match(app, /download|\.sql/i)
  assert.match(app, /Halaman|page > 0|setPage\(/)
})

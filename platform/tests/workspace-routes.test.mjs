/* Route adalah sumber kebenaran; file per proyek tetap diingat. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const admin = readFileSync(new URL('../../server/src/admin.ts', import.meta.url), 'utf8')

test('7 menu sesi terdaftar eksplisit', () => {
  assert.match(app, /sessionSlugs = \['chat', 'file', 'database', 'jalankan', 'terbitkan', 'export', 'tampilan'\]/)
  assert.match(app, /matchPath\(`\/proyek\/:id\/\$\{sessionSlug\}`, path\)/)
  assert.match(app, /const routeTab: Route = sessionSlug \?\? 'chat'/)
})

test('tab state mengikuti route', () => {
  assert.match(app, /useState<'chat' \| 'code'>\(routeTab === 'file' \? 'code' : 'chat'\)/)
  assert.match(app, /setTab\(routeTab === 'file' \? 'code' : 'chat'\)/)
})

test('file per proyek tetap diingat & dibuka ulang di /file', () => {
  assert.match(app, /VIEW_KEY\s*=\s*\(id:/)
  assert.match(app, /if \(routeTab === 'file' \|\| routeTab === 'chat'\) saveView\(projectId, \{ tab, file: openFile \}\)/)
  assert.match(app, /saved\.tab === 'code' && saved\.file && routeTab === 'file'.*openFileAt\(saved\.file\)/)
})

test('tombol back di workspace menuju chat, bukan daftar proyek', () => {
  const header = app.slice(app.indexOf('function Workspace('))
  assert.match(header, /navigate\(`\/proyek\/\$\{projectId\}\/chat`\)/)
  assert.doesNotMatch(header, /aria-label="Buka daftar proyek"/)
})

test('menu overflow menaut ke route, bukan aksi langsung', () => {
  const menu = app.slice(app.indexOf('function SessionMenu('), app.indexOf('/* ---------- Penampil database'))
  assert.match(menu, /go\('file'\)/)
  assert.match(menu, /go\('database'\)/)
  for (const slug of ['chat', 'jalankan', 'terbitkan', 'export', 'tampilan']) {
    assert.match(menu, new RegExp(`go\\('${slug}'\\)`))
  }
})

test('panel aksi ada & efek samping butuh tombol eksplisit', () => {
  for (const name of ['RunPane', 'PublishPane', 'ExportPane', 'AppearancePane']) {
    assert.ok(app.includes(`function ${name}(`), `panel ${name} harus ada`)
  }
  const publish = app.slice(app.indexOf('function PublishPane('), app.indexOf('function ExportPane('))
  assert.match(publish, /onClick=\{\(\) => void onPublish\(\)\}/)
  const exp = app.slice(app.indexOf('function ExportPane('), app.indexOf('function AppearancePane('))
  assert.match(exp, /onClick=\{onExport\}/)
})

test('sidebar punya Pengaturan admin & server mengizinkan /settings', () => {
  assert.match(app, /href="\/admin\/settings"/)
  assert.match(app, /Pengaturan admin/)
  assert.match(admin, /'settings'/)
})

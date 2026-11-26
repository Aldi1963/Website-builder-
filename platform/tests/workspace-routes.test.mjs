/* Setiap menu workspace punya route sendiri, bukan overlay/state internal.
   - /proyek/:id          -> chat (default)
   - /proyek/:id/chat     -> chat
   - /proyek/:id/file     -> editor file
   - /proyek/:id/database -> penampil database
   Tombol kembali di header menuju chat, bukan daftar proyek.
   Jalankan: cd platform && node --test tests/*.mjs */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

test('route workspace: chat/file/database terdaftar eksplisit', () => {
  assert.match(app, /matchPath\('\/proyek\/:id\/chat', path\)/)
  assert.match(app, /matchPath\('\/proyek\/:id\/file', path\)/)
  assert.match(app, /matchPath\('\/proyek\/:id\/database', path\)/)
  assert.match(app, /navigate\(`\/proyek\/\$\{projectId\}\/chat`\)/)
})

test('tab mengikuti route, bukan state tersimpan', () => {
  assert.doesNotMatch(app, /useState<Tab>\(\(\) => loadView\(projectId\)\.tab\)/)
  assert.match(app, /const \[tab, setTab\] = useState<Tab>\(routeTab\)/)
  assert.match(app, /setTab\(routeTab\)/)
})

test('back button di workspace menuju chat, bukan daftar proyek', () => {
  const header = app.slice(app.indexOf('function Workspace('))
  assert.match(header, /navigate\(`\/proyek\/\$\{projectId\}\/chat`\)/)
  assert.doesNotMatch(header, /onClick=\{onMenu\}[\s\S]{0,120}aria-label="Buka daftar proyek"/)
})

test('menu LLM jadi tautan route', () => {
  assert.match(app, /onShowFiles=\{\(\) => navigate\(`\/proyek\/\$\{projectId\}\/file`\)\}/)
  assert.match(app, /onShowDatabase=\{\(\) => navigate\(`\/proyek\/\$\{projectId\}\/database`\)\}/)
})

test('sidebar punya menu utama Pengaturan admin', () => {
  assert.match(app, /href="\/admin\/settings"/)
  assert.match(app, /Pengaturan admin|Pengaturan/)
})

test('admin /settings terdaftar di allowlist server', () => {
  const admin = readFileSync(new URL('../../server/src/admin.ts', import.meta.url), 'utf8')
  assert.match(admin, /'settings'/)
})

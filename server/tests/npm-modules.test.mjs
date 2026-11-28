import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { TOOLS } = await import('../src/agent-tools.ts')

test('tool install menerima argumen packages untuk dependency baru', () => {
  const t = TOOLS.find((x) => x.function.name === 'install')
  assert.ok(t, 'tool install ada')
  assert.deepEqual(t.function.parameters.required, [])
  assert.equal(t.function.parameters.properties.packages.type, 'array')
  assert.match(t.function.description, /npm/)
})

test('tool set_secret tersedia untuk kredensial tanpa menulis file', () => {
  const t = TOOLS.find((x) => x.function.name === 'set_secret')
  assert.ok(t, 'tool set_secret ada')
  assert.deepEqual(t.function.parameters.required, ['key', 'value'])
  assert.equal(t.function.parameters.properties.key.type, 'string')
})

test('semua nama tool unik', () => {
  const names = TOOLS.map((t) => t.function.name)
  assert.equal(new Set(names).size, names.length)
})

// ---- workspace: custom-server flag & package validation ----
const savedEnv = process.env.NODE_ENV
const root = mkdtempSync(join(tmpdir(), 'vb-nodemod-'))
process.env.VB_PROJECTS_DIR = root
process.env.NODE_ENV = 'production' // aktifkan validasi nama package
const { hasCustomServer, installDeps } = await import('../src/workspace.ts')

test('hasCustomServer hanya aktif bila penanda ada', () => {
  const dir = join(root, 'p1')
  mkdirSync(dir, { recursive: true })
  assert.equal(hasCustomServer(dir), false)
  writeFileSync(join(dir, 'vb.custom-server'), 'custom')
  assert.equal(hasCustomServer(dir), true)
})

test('installDeps menolak nama package berbahaya tanpa menjalankan npm', async () => {
  const r = await installDeps('p2', ['lodash; rm -rf /', '../evil'])
  assert.equal(r.code, 1)
  assert.match(r.output, /tidak valid/)
})

test('startPreview tidak menimpa server.mjs bila penanda custom ada', () => {
  const src = readFileSync(new URL('../src/workspace.ts', import.meta.url), 'utf8')
  assert.match(src, /!hasCustomServer\(dir\)\s*&&\s*existsSync\(serverFile\)/)
})

test.after(() => {
  if (savedEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = savedEnv
  rmSync(root, { recursive: true, force: true })
})

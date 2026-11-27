import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/* Endpoint /database/exec: owner-only, 503 bila managed DB mati, satu
   pernyataan, gate kata-pertama hanya INSERT/UPDATE/DELETE. Validator SQL
   dipakai ASLI (bukan mock) supaya gate benar-benar diuji; hanya pool
   Postgres-nya yang dipalsukan. DB utama (VB_DB) scratch seperti biasa. */
const root = mkdtempSync(join(tmpdir(), 'vb-dbexec-'))
process.env.VB_DB = join(root, 'platform.db')

const { validateProjectSql } = await import('../src/managed-db.ts')

const poolCalls = []
const fakePool = {
  async query(sql) {
    poolCalls.push(sql)
    return { rowCount: 2, command: sql.trim().split(/\s+/)[0].toUpperCase() }
  },
}
let managedEnabled = true
const workspaceMock = {
  ensureWorkspace(id, starter) { return join(root, id) },
  projectDir(id) { return join(root, id) },
  async installDeps() { return { code: 0, output: '' } },
  async buildProject() { return { code: 0, output: '' } },
  async startPreview() { return 45100 }, stopPreview() {}, runningPreviews() { return [] },
  previewPort() { return 45100 }, readProjectFile() { return null }, writeProjectFile() {},
  newDirsForFile() { return [] }, deleteProjectFile() {},
}
mock.module('../src/workspace.ts', { exports: workspaceMock, namedExports: workspaceMock })
const managedDbMock = {
  async provisionProjectDb() { return {} },
  isManagedDbEnabled() { return managedEnabled },
  async dropProjectDb() {},
  async projectDbPool() { return { pool: fakePool } },
  async projectDbUrl() { return '' },
  async execProjectSql() { return { ok: false, error: 'mock' } },
  validateProjectSql,
  async projectSchemaBrief() { return null },
}
mock.module('../src/managed-db.ts', { exports: managedDbMock, namedExports: managedDbMock })

const { app } = await import('../src/app.ts')
const { createUser, createSession, SESSION_COOKIE } = await import('../src/auth.ts')
const { db } = await import('../src/db.ts')

const owner = createUser('exec-owner@example.test', 'Owner', 'exec-owner-test-only')
const other = createUser('exec-other@example.test', 'Other', 'exec-other-test-only')
const ownerHeaders = { cookie: `${SESSION_COOKIE}=${createSession(owner.id).token}`, 'content-type': 'application/json' }
const otherHeaders = { cookie: `${SESSION_COOKIE}=${createSession(other.id).token}`, 'content-type': 'application/json' }
test.after(() => { db.close(); rmSync(root, { recursive: true, force: true }) })

const projectRes = await app.request('/api/projects', { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ name: 'ExecTest' }) })
assert.equal(projectRes.status, 201)
const projectId = (await projectRes.json()).project.id

const exec = (headers, sql) =>
  app.request(`/api/projects/${projectId}/database/exec`, { method: 'POST', headers, body: JSON.stringify({ sql }) })

test('database/exec: tanpa login ditolak 401', async () => {
  const res = await exec({ 'content-type': 'application/json' }, "UPDATE users SET role = 'admin' WHERE id = 1")
  assert.equal(res.status, 401)
})

test('database/exec: proyek milik orang lain 404 (owner-only)', async () => {
  const res = await exec(otherHeaders, "UPDATE users SET role = 'admin' WHERE id = 1")
  assert.equal(res.status, 404)
  assert.equal(poolCalls.length, 0, 'pool tidak boleh disentuh untuk proyek orang lain')
})

test('database/exec: 503 bila managed DB mati', async () => {
  managedEnabled = false
  try {
    const res = await exec(ownerHeaders, "UPDATE users SET role = 'admin' WHERE id = 1")
    assert.equal(res.status, 503)
    assert.equal(poolCalls.length, 0)
  } finally {
    managedEnabled = true
  }
})

test('database/exec: UPDATE diterima dan satu pernyataan diteruskan ke pool', async () => {
  poolCalls.length = 0
  const res = await exec(ownerHeaders, "UPDATE users SET role = 'admin' WHERE id = 1")
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.rowCount, 2)
  assert.equal(body.command, 'UPDATE')
  assert.equal(poolCalls.length, 1)
  assert.match(poolCalls[0], /^UPDATE users SET/)
})

test('database/exec: INSERT dan DELETE diterima', async () => {
  poolCalls.length = 0
  const ins = await exec(ownerHeaders, "INSERT INTO users (email) VALUES ('a@b.c')")
  assert.equal(ins.status, 200)
  const del = await exec(ownerHeaders, 'DELETE FROM users WHERE id = 1')
  assert.equal(del.status, 200)
  assert.equal(poolCalls.length, 2)
})

test('database/exec: SELECT ditolak gate kata-pertama', async () => {
  poolCalls.length = 0
  const res = await exec(ownerHeaders, 'SELECT id FROM users')
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /hanya untuk INSERT \/ UPDATE \/ DELETE/)
  assert.equal(poolCalls.length, 0, 'SELECT tidak boleh sampai ke pool')
})

test('database/exec: multi-pernyataan ditolak', async () => {
  poolCalls.length = 0
  const res = await exec(ownerHeaders, "UPDATE users SET role = 'admin' WHERE id = 1; DELETE FROM users WHERE id = 2")
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /satu pernyataan/i)
  assert.equal(poolCalls.length, 0)
})

test('database/exec: DROP ditolak validator', async () => {
  poolCalls.length = 0
  const res = await exec(ownerHeaders, 'DROP TABLE users')
  assert.equal(res.status, 400)
  assert.equal(poolCalls.length, 0)
})

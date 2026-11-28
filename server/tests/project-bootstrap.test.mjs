import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const root = mkdtempSync(join(tmpdir(), 'vb-bootstrap-'))
process.env.VB_DB = join(root, 'platform.db')
const calls = []
let installCode = 0
const workspaceMock = {
  ensureWorkspace(id, starter) { calls.push(['copy', starter]); return join(root, id) },
  async installDeps() { calls.push(['install']); return { code: installCode, output: 'install result' } },
  async buildProject() { calls.push(['build']); return { code: 0, output: 'build result' } },
  async startPreview() { return 45100 }, stopPreview() {}, runningPreviews() { return [] },
  previewPort() { return 45100 }, readProjectFile() { return null }, writeProjectFile() {},
  projectDir(id) { return join(root, id) }, newDirsForFile() { return [] }, deleteProjectFile() {},
}
mock.module('../src/workspace.ts', { namedExports: workspaceMock })
const managedDbMock = {
  async provisionProjectDb() { calls.push(['database']); return {} },
  isManagedDbEnabled() { return true }, async dropProjectDb() {}, async projectDbPool() {},
  async projectDbUrl() {}, async execProjectSql() {}, validateProjectSql() { return { ok: true, sql: '' } },
  async projectSchemaBrief() { return null },
}
mock.module('../src/managed-db.ts', { namedExports: managedDbMock })
const { app } = await import('../src/app.ts')
const { createUser, createSession, SESSION_COOKIE } = await import('../src/auth.ts')
const { db } = await import('../src/db.ts')
const user = createUser('isolated@example.test', 'Test', 'isolated-test-only')
const { token } = createSession(user.id)
const headers = { cookie: `${SESSION_COOKIE}=${token}`, 'content-type': 'application/json' }
test.after(() => { db.close(); rmSync(root, { recursive: true, force: true }) })
test('LMS creation provisions database and build installs dependencies first', async () => {
  const response = await app.request('/api/projects', { method: 'POST', headers, body: JSON.stringify({ starter: 'lms' }) })
  assert.equal(response.status, 201)
  const { project } = await response.json()
  assert.deepEqual(calls, [['copy', 'lms'], ['database']])
  calls.length = 0
  const build = await app.request(`/api/projects/${project.id}/build`, { method: 'POST', headers })
  assert.equal((await build.json()).ok, true)
  assert.deepEqual(calls, [['install'], ['build']])
  calls.length = 0
  installCode = 1
  const failed = await app.request(`/api/projects/${project.id}/build`, { method: 'POST', headers })
  assert.equal((await failed.json()).ok, false)
  assert.deepEqual(calls, [['install']], 'failed install prevents a misleading build')
})

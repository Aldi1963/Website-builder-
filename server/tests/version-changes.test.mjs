import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const root = mkdtempSync(join(tmpdir(), 'vb-changes-'))
process.env.VB_DB = join(root, 'platform.db')
const files = new Map()
const workspaceMock = {
  ensureWorkspace() { return join(root, 'ws') },
  async installDeps() { return { code: 0, output: '' } },
  async buildProject() { return { code: 0, output: '' } },
  async startPreview() { return 45100 }, stopPreview() {}, runningPreviews() { return [] },
  previewPort() { return 45100 },
  readProjectFile(_id, path) { return files.get(path) ?? null },
  writeProjectFile(_id, path, content) { files.set(path, content); globalThis.__putFile?.(_id, path, content) },
  listProjectFiles() { return [...files.keys()] },
  projectDir() { return join(root, 'ws') }, newDirsForFile() { return [] }, deleteProjectFile(_id, path) { files.delete(path); globalThis.__removeFile?.(_id, path) },
}
const { mock } = await import('node:test')
mock.module('../src/workspace.ts', { exports: workspaceMock, namedExports: workspaceMock })
const managedDbMock = {
  async provisionProjectDb() { return {} }, isManagedDbEnabled() { return true },
  async dropProjectDb() {}, async projectDbPool() {}, async projectDbUrl() {},
  async execProjectSql() {}, validateProjectSql() { return { ok: true, sql: '' } },
  async projectSchemaBrief() { return null },
}
mock.module('../src/managed-db.ts', { exports: managedDbMock, namedExports: managedDbMock })
const { app } = await import('../src/app.ts')
const { createUser, createSession, SESSION_COOKIE } = await import('../src/auth.ts')
const { db, putFile, getFile, removeFile } = await import('../src/db.ts')
globalThis.__putFile = putFile
globalThis.__removeFile = removeFile
const { snapshotVersion } = await import('../src/versions.ts')
const user = createUser('changes@example.test', 'Test', 'changes-test-only')
const { token } = createSession(user.id)
const headers = { cookie: `${SESSION_COOKIE}=${token}`, 'content-type': 'application/json' }
test.after(() => { db.close(); rmSync(root, { recursive: true, force: true }) })

test('GET /versions/:vid/changes melaporkan diff, restore mengembalikan isi file', async () => {
  const created = await app.request('/api/projects', { method: 'POST', headers, body: JSON.stringify({ starter: 'blank' }) })
  assert.equal(created.status, 201)
  const { project } = await created.json()
  const id = project.id
  putFile(id, 'src/index.ts', 'export const x = 1\n')
  const snapId = snapshotVersion(id, 'sebelum: tes')

  putFile(id, 'src/index.ts', 'export const x = 2\n')
  putFile(id, 'src/baru.ts', 'export const y = 3\n')

  const res = await app.request(`/api/projects/${id}/versions/${snapId}/changes`, { headers })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.version, snapId)
  const byPath = Object.fromEntries(body.changes.map((c) => [c.path, c.kind]))
  assert.equal(byPath['src/index.ts'], 'modified')
  assert.equal(byPath['src/baru.ts'], 'added')
  const indexChange = body.changes.find((c) => c.path === 'src/index.ts')
  assert.ok(indexChange.diff.some((l) => l.startsWith('-') && l.includes('x = 1')))
  assert.ok(indexChange.diff.some((l) => l.startsWith('+') && l.includes('x = 2')))

  const restored = await app.request(`/api/projects/${id}/versions/${snapId}/restore`, { method: 'POST', headers })
  assert.equal(restored.status, 200)
  assert.equal(getFile(id, 'src/index.ts'), 'export const x = 1\n')
  assert.equal(getFile(id, 'src/baru.ts'), undefined)
  const after = await app.request(`/api/projects/${id}/versions/${snapId}/changes`, { headers })
  const afterBody = await after.json()
  assert.deepEqual(afterBody.changes, [])
})

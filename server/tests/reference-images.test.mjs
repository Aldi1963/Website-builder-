import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const root = mkdtempSync(join(tmpdir(), 'vb-refs-'))
process.env.VB_DB = join(root, 'platform.db')
const workspaceMock = {
  ensureWorkspace(id) { return join(root, id) },
  async installDeps() { return { code: 0, output: '' } },
  async buildProject() { return { code: 0, output: '' } },
  async startPreview() { return 45100 }, stopPreview() {}, runningPreviews() { return [] },
  previewPort() { return 45100 }, readProjectFile() { return null }, writeProjectFile() {},
  projectDir(id) { return join(root, id) }, newDirsForFile() { return [] }, deleteProjectFile() {},
}
mock.module('../src/workspace.ts', { exports: workspaceMock, namedExports: workspaceMock })
const { app } = await import('../src/app.ts')
const { normalizeImageDataUrl, saveReferenceImage, listReferenceImages, readReferenceImage, deleteReferenceImage } = await import('../src/reference-images.ts')
const { createUser, createSession, SESSION_COOKIE } = await import('../src/auth.ts')
const { db } = await import('../src/db.ts')

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
const user = createUser('refs@example.test', 'Test', 'refs-test-only')
const { token } = createSession(user.id)
const headers = { cookie: `${SESSION_COOKIE}=${token}`, 'content-type': 'application/json' }
test.after(() => { db.close(); rmSync(root, { recursive: true, force: true }) })

async function makeProject() {
  const res = await app.request('/api/projects', { method: 'POST', headers, body: JSON.stringify({ name: 'Refs' }) })
  assert.equal(res.status, 201)
  return (await res.json()).project.id
}

test('normalizeImageDataUrl memvalidasi MIME dan menolak base64 sampah', () => {
  const ok = normalizeImageDataUrl(PNG)
  assert.equal(ok?.mime, 'image/png')
  assert.equal(normalizeImageDataUrl('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='), null)
  assert.equal(normalizeImageDataUrl('data:text/plain;base64,aGVsbG8='), null)
  assert.equal(normalizeImageDataUrl('!!!!'), null)
})

test('simpan, daftar, baca, hapus referensi — tidak masuk tabel files', async () => {
  const id = await makeProject()
  const saved = await saveReferenceImage(id, PNG, 'mockup.png')
  assert.match(saved.id, /^[a-f0-9]{10}$/)
  const listed = await listReferenceImages(id)
  assert.equal(listed.length, 1)
  assert.equal(listed[0].dataUrl, undefined)
  assert.equal(listed[0].name, 'mockup.png')
  const read = await readReferenceImage(id, saved.id)
  assert.equal(read?.dataUrl, PNG)
  const files = await app.request(`/api/projects/${id}/files`, { headers })
  assert.ok(!JSON.stringify(await files.json()).includes('.references'), 'referensi tidak boleh masuk daftar file workspace')
  assert.equal(await deleteReferenceImage(id, saved.id), true)
  assert.equal((await listReferenceImages(id)).length, 0)
})

test('endpoint unggah/daftar/sajikan/hapus gambar referensi lewat HTTP', async () => {
  const id = await makeProject()
  const bad = await app.request(`/api/projects/${id}/references`, { method: 'POST', headers, body: JSON.stringify({ dataUrl: 'data:text/plain;base64,aGVsbG8=' }) })
  assert.equal(bad.status, 400)
  const up = await app.request(`/api/projects/${id}/references`, { method: 'POST', headers, body: JSON.stringify({ dataUrl: PNG, name: 'desain.png' }) })
  assert.equal(up.status, 200)
  const { image } = await up.json()
  assert.equal(image.dataUrl, undefined)
  const list = await app.request(`/api/projects/${id}/references`, { headers })
  assert.equal((await list.json()).images.length, 1)
  const raw = await app.request(`/api/projects/${id}/references/${image.id}`, { headers })
  assert.equal(raw.status, 200)
  assert.equal(raw.headers.get('content-type'), 'image/png')
  assert.ok((await raw.arrayBuffer()).byteLength > 0)
  const del = await app.request(`/api/projects/${id}/references/${image.id}`, { method: 'DELETE', headers })
  assert.equal((await del.json()).ok, true)
})


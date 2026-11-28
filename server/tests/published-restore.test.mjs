import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const root = mkdtempSync(join(tmpdir(), 'vb-pubrestore-'))
process.env.VB_DB = join(root, 'platform.db')
process.env.VB_PUBLIC_SUFFIX = 'clidi.net'
process.env.VB_PUBLIC_ORIGIN = 'https://clidi.net'

const started = []
const built = []
const workspaceMock = {
  ensureWorkspace: (id) => join(root, id),
  async installDeps() { return { code: 0, output: '' } },
  async buildProject(id) { built.push(id); return { code: 0, output: 'ok' } },
  async startPreview(id) { started.push(id); return 41000 },
  stopPreview() {},
  runningPreviews() { return [] },
  previewPort() { return 41000 },
  readProjectFile() { return null },
  writeProjectFile() {},
  projectDir(id) { return join(root, id) },
  deleteProjectFile() {},
  newDirsForFile() { return [] },
}
mock.module('../src/workspace.ts', { exports: workspaceMock, namedExports: workspaceMock })
const pathsMock = {
  ROOT: root, TEMPLATE_DIR: root, STARTERS_DIR: root,
  PROJECTS_DIR: join(root, 'projects'),
  PREVIEW_HOST: 'preview.localhost', PLATFORM_PORT: 3000,
  PREVIEW_PORT_BASE: 4100, MAX_PREVIEWS: 12,
}
mock.module('../src/paths.ts', { exports: pathsMock, namedExports: pathsMock })

const { db } = await import('../src/db.ts')
const { createUser } = await import('../src/auth.ts')
const user = createUser('pubrestore@example.test', 'Pub Restore', 'pubrestore-only')
db.prepare(`INSERT INTO projects (id, name, prompt, status, owner_id, slug, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`)
  .run('pubrestore1', 'App Satu', '', 'idle', user.id, 'app-satu', Date.now(), Date.now())
db.prepare(`INSERT INTO projects (id, name, prompt, status, owner_id, slug, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`)
  .run('pubrestore2', 'App Dua', '', 'idle', user.id, 'app-dua', Date.now(), Date.now())
test.after(() => { db.close(); rmSync(root, { recursive: true, force: true }) })

test('ensurePublishedPreviews mulai ulang semua preview published (idempoten)', async () => {
  for (const id of ['pubrestore1', 'pubrestore2']) {
    const dir = join(root, 'projects', id, 'dist', 'server')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'server.js'), '// fixture')
  }
  const { ensurePublishedPreviews } = await import('../src/app.ts')
  const a = ensurePublishedPreviews()
  const b = ensurePublishedPreviews()
  assert.equal(a, b, 'harus idempoten')
  await a
  assert.deepEqual(started.sort(), ['pubrestore1', 'pubrestore2'])
  assert.deepEqual(built, [], 'bundle ada → tidak rebuild')
})

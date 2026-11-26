import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
const root = mkdtempSync(join(tmpdir(), 'vb-copy-'))
process.env.VB_DB = join(root, 'platform.db')
const { db, createProject, listFiles } = await import('../src/db.ts')
const { ensureWorkspace, projectDir, readProjectFile } = await import('../src/workspace.ts')
test('workspace recovery retains persisted LMS starter and indexes copied source', () => {
  const id = randomBytes(5).toString('hex')
  try {
    createProject(id, 'isolated', '', null, 'lms')
    ensureWorkspace(id)
    assert.match(readProjectFile(id, 'src/routes/index.tsx'), /Kursus tersedia/)
    assert.ok(listFiles(id).some(f => f.path === 'src/lib/lms.ts'))
  } finally { rmSync(projectDir(id), { recursive: true, force: true }) }
})
test.after(() => { db.close(); rmSync(root, { recursive: true, force: true }) })

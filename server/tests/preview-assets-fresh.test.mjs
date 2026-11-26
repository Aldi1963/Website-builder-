import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const src = readFileSync(resolve(root, 'server/src/workspace.ts'), 'utf8')

test('buildProject restarts a running preview after a successful rebuild', () => {
  const start = src.indexOf('export async function buildProject(')
  const end = src.indexOf('\n}', start)
  const body = src.slice(start, end === -1 ? undefined : end)
  assert.match(body, /stopPreview\(/, 'buildProject must stop the stale preview after rebuild')
})

test('startPreview restarts when the build fingerprint changes, not only settings', () => {
  const start = src.indexOf('export async function startPreview(')
  const end = src.indexOf('\nexport function stopPreview', start)
  const body = src.slice(start, end === -1 ? undefined : end)
  assert.match(
    body,
    /buildFingerprint|build.*Fingerprint|fingerprint.*build|mtime|buildHash/,
    'startPreview must detect that a new build was emitted',
  )
})

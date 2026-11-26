import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const src = readFileSync(resolve(root, 'server/src/admin.ts'), 'utf8')

test('server serves the consolidated admin pages explicitly', () => {
  const start = src.indexOf('const ADMIN_SLUGS: string[] = [')
  const end = src.indexOf('\n  ]', start)
  const list = src.slice(start, end + 4)
  for (const slug of ['konten', 'monetisasi', 'komunikasi', 'sistem']) {
    assert.match(list, new RegExp(`'${slug}'`), `missing /admin/${slug} in ADMIN_SLUGS`)
  }
})

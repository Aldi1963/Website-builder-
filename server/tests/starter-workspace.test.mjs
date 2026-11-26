import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const workspaceSource = readFileSync(new URL('../src/workspace.ts', import.meta.url), 'utf8')
const appSource = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8')
const apiSource = readFileSync(new URL('../../platform/src/api.ts', import.meta.url), 'utf8')
const uiSource = readFileSync(new URL('../../platform/src/App.tsx', import.meta.url), 'utf8')
const starterIndex = readFileSync(new URL('../../starters/lms/src/routes/index.tsx', import.meta.url), 'utf8')
const starterDb = readFileSync(new URL('../../starters/lms/src/lib/lms.ts', import.meta.url), 'utf8')

test('project API, workspace copy, and UI route select the LMS starter', () => {
  assert.match(appSource, /body\.starter === 'lms' \? 'lms' : 'blank'/)
  assert.match(appSource, /ensureWorkspace\(id, starter\)/)
  assert.match(workspaceSource, /(?:starter|chosen) === 'lms' \? join\(STARTERS_DIR, 'lms'\) : TEMPLATE_DIR/)
  assert.match(apiSource, /starter: 'blank' \| 'lms'/)
  assert.match(apiSource, /JSON\.stringify\(\{ name, prompt, starter \}\)/)
  assert.match(uiSource, /Starter LMS/)
  assert.match(uiSource, /onCreate\('lms'\)/)
})

test('LMS starter contains its core routes and idempotent LMS schema', () => {
  for (const route of ['index.tsx', 'login.tsx', 'dashboard.tsx', 'courses.$slug.tsx', 'courses.$slug_.manage.tsx', 'courses.$slug_.grade.$submissionId.tsx']) {
    const source = readFileSync(new URL(`../../starters/lms/src/routes/${route}`, import.meta.url), 'utf8')
    assert.match(source, /createFileRoute/, `${route} is a route`)
  }
  for (const table of ['courses', 'lessons', 'enrollments', 'lesson_progress', 'assignments', 'submissions', 'discussions']) {
    assert.ok(starterDb.includes(`create table if not exists ${table}`), `schema includes ${table}`)
  }
  assert.match(starterIndex, /Kursus tersedia/)
})

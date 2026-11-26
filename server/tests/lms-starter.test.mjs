import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const workspaceSource = readFileSync(new URL('../src/workspace.ts', import.meta.url), 'utf8')
const appSource = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8')
const apiSource = readFileSync(new URL('../../platform/src/api.ts', import.meta.url), 'utf8')
const uiSource = readFileSync(new URL('../../platform/src/App.tsx', import.meta.url), 'utf8')
const starterIndex = readFileSync(new URL('../../starters/lms/src/routes/index.tsx', import.meta.url), 'utf8')
const starterDb = readFileSync(new URL('../../starters/lms/src/lib/lms.ts', import.meta.url), 'utf8')

test('project create endpoint accepts only known starter ids and copies selected template', () => {
  assert.match(appSource, /body\.starter === 'lms' \? 'lms' : 'blank'/)
  assert.match(appSource, /ensureWorkspace\(id, starter\)/)
  assert.match(workspaceSource, /chosen === 'lms' \? join\(STARTERS_DIR, 'lms'\) : TEMPLATE_DIR/)
})

test('new-project UI offers blank and LMS options and API transmits selection', () => {
  assert.match(uiSource, /Starter LMS/)
  assert.match(uiSource, /onCreate\('lms'\)/)
  assert.match(apiSource, /starter: 'blank' \| 'lms'/)
  assert.match(apiSource, /JSON\.stringify\(\{ name, prompt, starter \}\)/)
})

test('LMS starter includes authenticated roles, course catalog, learning and assessment schema', () => {
  for (const route of ['dashboard.tsx', 'courses.$slug.tsx', 'courses.$slug_.manage.tsx', 'courses.$slug_.grade.$submissionId.tsx']) {
    const source = readFileSync(new URL(`../../starters/lms/src/routes/${route}`, import.meta.url), 'utf8')
    assert.ok(source.includes('createFileRoute'), `${route} is a route`)
  }
  for (const table of ['courses', 'lessons', 'enrollments', 'lesson_progress', 'assignments', 'submissions', 'discussions']) {
    assert.ok(starterDb.includes(`create table if not exists ${table}`), `schema includes ${table}`)
  }
  assert.match(starterIndex, /Kursus tersedia/)
  const courseRoute = readFileSync(new URL('../../starters/lms/src/routes/courses.$slug.tsx', import.meta.url), 'utf8')
  const manageRoute = readFileSync(new URL('../../starters/lms/src/routes/courses.$slug_.manage.tsx', import.meta.url), 'utf8')
  const gradeRoute = readFileSync(new URL('../../starters/lms/src/routes/courses.$slug_.grade.$submissionId.tsx', import.meta.url), 'utf8')
  assert.match(courseRoute, /join enrollments e on e.course_id=l.course_id where l.id=\$1 and e.user_id=\$2/)
  assert.match(courseRoute, /join enrollments e on e.course_id=a.course_id where a.id=\$1 and e.user_id=\$2/)
  assert.match(manageRoute, /created_by=\$3/)
  assert.match(gradeRoute, /c.created_by=\$5/)
  const registerRoute = readFileSync(new URL('../../starters/lms/src/routes/login.tsx', import.meta.url), 'utf8')
  assert.match(registerRoute, /register\(data.email, data.password, data.name, 'siswa'\)/)
  assert.doesNotMatch(registerRoute, /lock table users|count === 0 \? 'admin'/)
})

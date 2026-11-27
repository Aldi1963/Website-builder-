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
const tiketDb = readFileSync(new URL('../../starters/tiket/src/lib/tiket.ts', import.meta.url), 'utf8')
const drizzleSchema = readFileSync(new URL('../../starters/tiket/shared/schema.ts', import.meta.url), 'utf8')
const migration = readFileSync(new URL('../../starters/tiket/migrations/0001_tiket_schema.sql', import.meta.url), 'utf8')

test('project API, workspace copy, and UI route select the LMS starter', () => {
  assert.match(appSource, /body\.starter === 'lms' \|\| body\.starter === 'tiket' \? body\.starter : 'blank'/)
  assert.match(appSource, /ensureWorkspace\(id, starter\)/)
  assert.match(workspaceSource, /(?:starter|chosen) === 'lms' \|\| (?:starter|chosen) === 'tiket' \? join\(STARTERS_DIR, (?:chosen|starter)\) : TEMPLATE_DIR/)
  assert.match(apiSource, /starter: 'blank' \| 'lms' \| 'tiket'/)
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

test('tiket starter exposes the full event/check-in flow and real DB rules', () => {
  for (const route of ['index.tsx', 'masuk.tsx', 'dashboard.tsx', 'event.$slug.tsx']) {
    const source = readFileSync(new URL(`../../starters/tiket/src/routes/${route}`, import.meta.url), 'utf8')
    assert.match(source, /createFileRoute/, `${route} is a route`)
  }
  for (const table of ['events', 'ticket_types', 'orders', 'order_items', 'attendees', 'ticket_scans', 'promo_codes']) {
    assert.ok(tiketDb.includes(`create table if not exists ${table}`), `schema includes ${table}`)
  }
  assert.match(tiketDb, /for update/, 'quota check locks rows')
  assert.match(tiketDb, /client\.query\('begin'\)/, 'order is a transaction')
  assert.match(tiketDb, /requireRole/, 'check-in enforces role on the server')
  assert.match(readFileSync(new URL('../../starters/tiket/src/routes/masuk.tsx', import.meta.url), 'utf8'),
    /data\.name, 'user'/, 'public signup is always role user')
})

test('tiket schema ships as Drizzle tables plus matching idempotent migration', () => {
  for (const table of ['users', 'events', 'ticketTypes', 'orders', 'orderItems', 'attendees', 'ticketScans', 'promoCodes']) {
    assert.match(drizzleSchema, new RegExp(`export const ${table} = pgTable`), `drizzle table ${table}`)
  }
  assert.match(drizzleSchema, /pgEnum\('event_status'/)
  assert.match(drizzleSchema, /pgEnum\('order_status'/)
  assert.match(migration, /create table if not exists events/)
  assert.match(migration, /price_cents integer not null/)
  assert.match(migration, /checked_in_at timestamptz/)
})

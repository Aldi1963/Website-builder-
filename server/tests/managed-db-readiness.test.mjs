import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/* Isolasi: DB scratch supaya isNeonConfigured() tidak membaca key Neon di
   database live (live berisi key Neon -> jalur Neon/API sungguhan). */
const isoDir = mkdtempSync(join(tmpdir(), 'vb-managed-db-'))
process.env.VB_DB = join(isoDir, 'test.db')
process.env.NEON_API_KEY = ''
process.env.NEON_PROJECT_ID = ''

process.env.VB_PG_URL = 'postgres://admin:fixture@127.0.0.1:5432/platform?sslmode=disable'
const credentials = 'isolated-fixture-password'
let projectConnection
mock.module('pg', { namedExports: { Pool: class {
  constructor(options) { if (new URL(options.connectionString).username !== 'admin') projectConnection = options.connectionString }
  async query(sql) {
    if (sql.startsWith('select password')) return { rowCount: 1, rows: [{ password: credentials }] }
    return { rowCount: 1, rows: [{}] }
  }
  on() {}
  async end() {}
} } })
const managed = await import('../src/managed-db.ts')
test.after(async () => { const { db } = await import('../src/db.ts'); try { db.close() } catch { /* sudah tertutup */ } rmSync(isoDir, { recursive: true, force: true }) })
test('preview and pool use persisted project credentials, not a redaction placeholder', async () => {
  const url = new URL(await managed.projectDbUrl('abc123'))
  assert.equal(url.password, credentials)
  assert.equal(url.username, 'vb_abc123')
  assert.equal(url.pathname, '/vb_abc123')
  assert.equal(url.searchParams.get('sslmode'), 'disable')
  await managed.projectDbPool('abc123')
  assert.equal(projectConnection, url.toString())
})

import test, { mock } from 'node:test'
import assert from 'node:assert/strict'

process.env.VB_PG_URL = 'postgres://admin:fixture@127.0.0.1:5432/platform?sslmode=disable'
const credentials = 'isolated-fixture-password'
let projectConnection
mock.module('pg', { exports: { Pool: class {
  constructor(options) { if (new URL(options.connectionString).username !== 'admin') projectConnection = options.connectionString }
  async query(sql) {
    if (sql.startsWith('select password')) return { rowCount: 1, rows: [{ password: credentials }] }
    return { rowCount: 1, rows: [{}] }
  }
  async end() {}
} } })
const managed = await import('../src/managed-db.ts')
test('preview and pool use persisted project credentials, not a redaction placeholder', async () => {
  const url = new URL(await managed.projectDbUrl('abc123'))
  assert.equal(url.password, credentials)
  assert.equal(url.username, 'vb_abc123')
  assert.equal(url.pathname, '/vb_abc123')
  assert.equal(url.searchParams.get('sslmode'), 'disable')
  await managed.projectDbPool('abc123')
  assert.equal(projectConnection, url.toString())
})

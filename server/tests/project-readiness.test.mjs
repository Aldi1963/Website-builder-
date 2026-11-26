import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

// Opt in with an installed embedded-postgres module; never connects to a host DB.
const modulePath = process.env.VB_TEST_EMBEDDED_PG

test('managed project credentials connect and remain stable', { skip: !modulePath }, async () => {
  const { default: EmbeddedPostgres } = await import(modulePath)
  const root = mkdtempSync(join(tmpdir(), 'vb-readiness-'))
  const password = randomBytes(20).toString('hex')
  const port = 25491
  const pg = new EmbeddedPostgres({ databaseDir: join(root, 'pg'), user: 'test_admin', password, port,
    persistent: false, autoRehydrateSymlinks: true, onLog() {}, onError() {} })
  let pool
  try {
    await pg.initialise()
    await pg.start()
    process.env.VB_PG_URL = `postgres://test_admin:${password}@127.0.0.1:${port}/postgres`
    process.env.VB_DB = join(root, 'platform.sqlite')
    const managed = await import('../src/managed-db.ts')
    const id = randomBytes(5).toString('hex')
    const first = await managed.projectDbUrl(id)
    assert.ok(first, 'provisioning returns a connection URL')
    const opened = await managed.projectDbPool(id)
    pool = opened.pool
    await pool.query('create table readiness_probe (value text)')
    await pool.query('insert into readiness_probe values ($1)', ['persisted'])
    assert.equal((await pool.query('select value from readiness_probe')).rows[0].value, 'persisted')
    assert.equal(await managed.projectDbUrl(id), first, 'provisioning preserves credentials')
  } finally {
    await pool?.end()
    await pg.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

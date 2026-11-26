import pg from 'pg'

// Trusted operator CLI only. Never expose this operation as a public server function.
const args = process.argv.slice(2)
const email = args[1]?.trim().toLowerCase()
if (args.length !== 2 || args[0] !== '--email' || !email?.includes('@') || !process.env.VB_APP_DATABASE_URL) {
  console.error('Usage: node scripts/bootstrap-admin.mjs --email owner@example.com (requires VB_APP_DATABASE_URL)')
  process.exit(1)
}
const client = new pg.Client({ connectionString: process.env.VB_APP_DATABASE_URL, connectionTimeoutMillis: 5000, statement_timeout: 10000 })
try {
  await client.connect()
  await client.query('begin')
  // All reads and writes use this SAME client. Serializes competing trusted bootstraps.
  await client.query('lock table users in exclusive mode')
  const target = (await client.query('select id, role from users where email=$1', [email])).rows[0]
  if (!target) throw new Error('Register the owner account first, then verify its identity before bootstrap.')
  if (target.role !== 'admin') {
    if ((await client.query("select 1 from users where role='admin' limit 1")).rows.length) {
      throw new Error('An administrator already exists; bootstrap refused.')
    }
    await client.query("update users set role='admin' where id=$1", [target.id])
    // Do not upgrade pre-existing browser sessions implicitly.
    await client.query('delete from sessions where user_id=$1', [target.id])
  }
  await client.query('commit')
  if ((await client.query('select role from users where id=$1', [target.id])).rows[0]?.role !== 'admin') throw new Error('Bootstrap verification failed.')
  console.log('Administrator bootstrap verified. Sign in again.')
} catch (error) {
  await client.query('rollback').catch(() => {})
  // Avoid logging connection strings or arbitrary database diagnostics.
  console.error(error instanceof Error && ['Register the owner account first, then verify its identity before bootstrap.', 'An administrator already exists; bootstrap refused.', 'Bootstrap verification failed.'].includes(error.message) ? error.message : 'Bootstrap failed; check database connectivity and initialized auth schema.')
  process.exitCode = 1
} finally {
  await client.end()
}

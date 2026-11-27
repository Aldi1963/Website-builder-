import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const adminSrc = readFileSync(resolve(root, 'server/src/admin.ts'), 'utf8')
const neonSrc = readFileSync(resolve(root, 'server/src/neon-db.ts'), 'utf8')
const managedSrc = readFileSync(resolve(root, 'server/src/managed-db.ts'), 'utf8')

/* DB scratch + env kosong SEBELUM modul server diimpor, supaya tes tidak
   pernah membaca/menulis admin_settings di database live. */
const dir = mkdtempSync(join(tmpdir(), 'vb-neon-'))
process.env.VB_DB = join(dir, 'test.db')
process.env.NEON_API_KEY = ''
process.env.NEON_PROJECT_ID = ''
process.env.NEON_BRANCH_ID = ''

const { app } = await import('../src/app.ts')
const { db } = await import('../src/db.ts')
const { createUser, createSession, SESSION_COOKIE } = await import('../src/auth.ts')

/* Pengguna pertama = admin (aturan first-account); pengguna kedua bukan admin. */
const admin = createUser('neon-admin@example.test', 'Admin', 'neon-admin-test-only')
const other = createUser('neon-other@example.test', 'Other', 'neon-other-test-only')
const adminHeaders = { cookie: `${SESSION_COOKIE}=${createSession(admin.id).token}`, 'content-type': 'application/json' }
const otherHeaders = { cookie: `${SESSION_COOKIE}=${createSession(other.id).token}`, 'content-type': 'application/json' }

const readNeon = () => {
  const rows = db.prepare(`SELECT key, value FROM admin_settings WHERE key LIKE 'neon.%'`).all()
  return Object.fromEntries(rows.map((r) => [r.key, r.value]))
}
const seedNeon = (apiKey = 'key-lama-123', projectId = 'proj-lama', branchId = 'br-lama') => {
  db.prepare(`DELETE FROM admin_settings WHERE key LIKE 'neon.%'`).run()
  const now = Date.now()
  for (const [k, v] of [['neon.api_key', apiKey], ['neon.project_id', projectId], ['neon.branch_id', branchId]]) {
    db.prepare(`INSERT INTO admin_settings (key, value, updated_at) VALUES (?, ?, ?)`).run(k, v, now)
  }
}
const putNeon = (headers, body) =>
  app.request('/api/admin/neon', { method: 'PUT', headers, body: JSON.stringify(body) })

test.after(() => {
  try { db.close() } catch { /* sudah tertutup */ }
  rmSync(dir, { recursive: true, force: true })
})

test('panel admin menyediakan GET/PUT konfigurasi Neon tanpa mengembalikan rahasia', () => {
  assert.match(adminSrc, /app\.get\('\/api\/admin\/neon'/)
  assert.match(adminSrc, /app\.put\('\/api\/admin\/neon'/)
  assert.match(adminSrc, /hasApiKey:\s*Boolean\(s\.apiKey\)/)
  assert.match(adminSrc, /projectId:\s*s\.projectId\s*\?\s*s\.projectId\.slice/)
  // response GET tidak boleh menyertakan nilai kredensial
  const getBlock = adminSrc.slice(adminSrc.indexOf("app.get('/api/admin/neon'"), adminSrc.indexOf("app.put('/api/admin/neon'"))
  assert.doesNotMatch(getBlock, /apiKey:\s*s\.apiKey/)
  assert.doesNotMatch(getBlock, /db\.prepare[\s\S]{0,200}neon\.api_key[\s\S]{0,120}\.all/)
})

test('adapter Neon membaca kredensial dari admin_settings dengan fallback env', () => {
  assert.match(neonSrc, /SELECT value FROM admin_settings WHERE key = \?/)
  assert.match(neonSrc, /'neon\.api_key'/)
  assert.match(neonSrc, /'neon\.project_id'/)
  assert.match(neonSrc, /process\.env\.NEON_API_KEY/)
  assert.match(neonSrc, /isNeonConfigured\(\)/)
})

test('managed-db mendukung dua mode: Neon bila ada kredensial, lokal bila tidak', () => {
  assert.match(managedSrc, /isNeonConfigured\(\)/)
  assert.match(managedSrc, /neonConnectionUrl\(projectId\)/)
  assert.match(managedSrc, /neonDropProject\(projectId\)/)
  assert.match(managedSrc, /if \(useNeon\(\)\)/)
  const poolSection = managedSrc.slice(managedSrc.indexOf('export async function projectDbPool'), managedSrc.indexOf('export async function projectDbUrl'))
  assert.match(poolSection, /neonUrl|useNeon\(\)/)
})

test('adapter aktif hanya bila kredensial tersedia; fallback lokal saat kosong', async () => {
  /* DB scratch masih kosong (belum ada PUT yang seed) + env dikosongkan. */
  db.prepare(`DELETE FROM admin_settings WHERE key LIKE 'neon.%'`).run()
  const neon = await import('../src/neon-db.ts')
  assert.equal(neon.isNeonConfigured(), false)
  assert.equal(await neon.neonConnectionUrl('probe123'), null)
  assert.equal((await neon.neonDropProject('probe123')).ok, false)
  assert.deepEqual(neon.neonNames('abc-123'), { role: 'vb_abc123', database: 'vb_abc123' })
})

test('PUT Neon: rotasi satu field tidak menghapus field lain', async () => {
  seedNeon()
  const res = await putNeon(adminHeaders, { apiKey: 'key-baru-456' })
  assert.equal(res.status, 200, await res.text())
  const rows = readNeon()
  assert.equal(rows['neon.api_key'], 'key-baru-456')
  assert.equal(rows['neon.project_id'], 'proj-lama')
  assert.equal(rows['neon.branch_id'], 'br-lama')
})

test('PUT Neon: field kosong = tidak berubah (bukan hapus)', async () => {
  seedNeon()
  const res = await putNeon(adminHeaders, { projectId: '', branchId: '' })
  assert.equal(res.status, 200, await res.text())
  const rows = readNeon()
  assert.equal(rows['neon.project_id'], 'proj-lama')
  assert.equal(rows['neon.branch_id'], 'br-lama')
  assert.equal(rows['neon.api_key'], 'key-lama-123')
})

test('PUT Neon: hapus eksplisit via clear bekerja, field lain utuh', async () => {
  seedNeon()
  const res = await putNeon(adminHeaders, { clear: ['branchId'] })
  assert.equal(res.status, 200, await res.text())
  const rows = readNeon()
  assert.equal(rows['neon.branch_id'], undefined)
  assert.equal(rows['neon.api_key'], 'key-lama-123')
  assert.equal(rows['neon.project_id'], 'proj-lama')
})

test('PUT Neon: validasi gagal = tidak ada yang tertulis (atomik)', async () => {
  seedNeon()
  const res = await putNeon(adminHeaders, { apiKey: 'x'.repeat(301), projectId: 'proj-baru' })
  assert.equal(res.status, 400)
  const rows = readNeon()
  assert.equal(rows['neon.api_key'], 'key-lama-123', 'apiKey lama harus utuh walau validasi gagal')
  assert.equal(rows['neon.project_id'], 'proj-lama', 'projectId baru tidak boleh tertulis bila apiKey gagal validasi')
  assert.equal(rows['neon.branch_id'], 'br-lama')
})

test('PUT Neon: clear berisi nama tak dikenal ditolak tanpa menulis', async () => {
  seedNeon()
  const res = await putNeon(adminHeaders, { clear: ['api_key_palsu'] })
  assert.equal(res.status, 400)
  assert.deepEqual(readNeon(), { 'neon.api_key': 'key-lama-123', 'neon.project_id': 'proj-lama', 'neon.branch_id': 'br-lama' })
})

test('PUT Neon: non-admin ditolak', async () => {
  const res = await putNeon(otherHeaders, { apiKey: 'key-penyusup' })
  assert.equal(res.status, 403)
})

test('PUT Neon: GET sesudah PUT tidak membocorkan nilai', async () => {
  seedNeon('key-rahasia-999', 'proj-xyz-123456789', 'br-xyz')
  const res = await app.request('/api/admin/neon', { headers: adminHeaders })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.hasApiKey, true)
  assert.equal(JSON.stringify(body).includes('key-rahasia-999'), false, 'GET tidak boleh membocorkan api key')
  assert.equal(JSON.stringify(body).includes('proj-xyz-123456789'), false, 'GET tidak boleh menampilkan project id lengkap')
  assert.equal(body.projectId, 'proj-xyz' + '…', 'GET hanya menampilkan 8 karakter pertama project id')
})

test('panel admin menampilkan form Neon di ApiKeysSection', () => {
  const ui = readFileSync(resolve(root, 'admin-react/src/components/ApiKeysSection.tsx'), 'utf8')
  assert.match(ui, /api\.get<NeonData>\('\/api\/admin\/neon'\)/)
  assert.match(ui, /api\.put<[^>]*>\('\/api\/admin\/neon'/)
  for (const id of ['settings-neon-key', 'settings-neon-project', 'settings-neon-branch']) {
    assert.match(ui, new RegExp(`id="${id}"`))
  }
  assert.match(ui, /type="password"/)
  assert.match(ui, /Database Neon \(Serverless Postgres\)/)
  /* Hapus eksplisit per field (bukan string kosong): tombol Hapus + clear. */
  assert.match(ui, /clearNeon\('apiKey'/)
  assert.match(ui, /clearNeon\('projectId'/)
  assert.match(ui, /clearNeon\('branchId'/)
  assert.match(ui, /clear: \[field\]/)
  assert.match(ui, /Hapus API key/)
  assert.match(ui, /Hapus project ID/)
  assert.match(ui, /Hapus branch ID/)
  /* saveNeon tidak lagi mengirim ketiga field mentah-mentah. */
  assert.doesNotMatch(ui, /apiKey: neonKey\.trim\(\),\s*\n\s*projectId: neonProject\.trim\(\),/)
})

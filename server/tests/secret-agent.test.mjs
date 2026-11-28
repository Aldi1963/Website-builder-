import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Node 22 membutuhkan namedExports agar named import dari modul mock tidak gagal;
// Node 24 menolak kombinasi exports + namedExports. Pilih bentuk sesuai versi.
const needsNamedExports = Number(process.versions.node.split('.')[0]) < 23
function mockNamed(path, obj) {
  mock.module(path, needsNamedExports ? { namedExports: obj } : { exports: obj })
}
const root = mkdtempSync(join(tmpdir(), 'vb-secretagent-'))
process.env.VB_DB = join(root, 'platform.db')
const SECRET_VALUE = 's3cr3t-e2e-value-12345'
let callCount = 0

const llmMocks = {
    complete: async () => {
      callCount++
      // call #1 = planning, call #2 = eksekusi dengan tools
      if (callCount === 2) {
        return {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: { name: 'set_secret', arguments: JSON.stringify({ key: 'E2E_PING_TOKEN', value: SECRET_VALUE }) },
            }],
          },
          usage: {},
        }
      }
      return { message: { role: 'assistant', content: 'Selesai. Token tersimpan.' }, usage: {} }
    },
    completeText: async () => 'mock',
    adminSetting: () => undefined,
    effectiveModel: () => 'mock-model', effectiveStrongModel: () => 'mock-strong',
    effectiveAuditModel: () => 'mock-audit', effectiveEndpoint: () => 'http://mock',
    effectiveKey: () => '', effectiveKeyConfigured: () => false,
    FAST_MODEL: 'mock-fast', STRONG_MODEL: 'mock-strong', AUDIT_MODEL: 'mock-audit',
    LLM_ENDPOINT: 'http://mock', LLM_KEY_CONFIGURED: false,
    llmUsage: { requests: 0, promptTokens: 0, completionTokens: 0 },
    creditHabisError: () => new Error('credit'), concurrentRunError: () => new Error('concurrent'),
    MAX_TURNS_PER_RUN: 30, MAX_REVIEW_PER_RUN: 1, TRIVIAL_EDIT_MAX_FILES: 1, TRIVIAL_EDIT_MAX_LINES: 10,
    registerTurn: () => 1, turnsUsed: () => 1, registerReviewCall: () => 1, reviewsUsed: () => 1,
    endRunTracking: () => {}, shouldSkipReview: () => false,
}
mockNamed('../src/llm.ts', llmMocks)
const wsMocks = {
  ensureWorkspace(id) { return join(root, id) }, projectDir(id) { return join(root, id) },
  async installDeps() { return { code: 0, output: '' } }, async buildProject() { return { code: 0, output: '' } },
  async startPreview() { return 45100 }, stopPreview() {}, runningPreviews() { return [] },
  previewPort() { return 45100 }, readProjectFile() { return null }, writeProjectFile() {},
  newDirsForFile() { return [] }, deleteProjectFile() {},
}
mockNamed('../src/workspace.ts', wsMocks)
for (const mod of ['../src/managed-db.ts', '../src/versions.ts', '../src/screenshots.ts', '../src/reference-images.ts', '../src/route-paths.ts']) {
  const stub = {
    isManagedDbEnabled() { return false }, async execProjectSql() {}, async projectDbPool() {}, async projectDbUrl() {},
    async provisionProjectDb() {}, async dropProjectDb() {}, validateProjectSql() { return { ok: true } }, async projectSchemaBrief() { return null },
    snapshotVersion() {}, restoreVersion() {}, listVersions() { return [] }, getVersionDiff() { return null }, diffLines() { return [] },
    captureScreenshot() {}, captureForReview() { return { runtimeErrors: [], defects: [], screenshotPath: null } }, listScreenshots() { return [] }, readScreenshot() { return null },
    saveReferenceImage() {}, listReferenceImages() { return [] }, readReferenceImage() { return null }, deleteReferenceImage() {},
    routePathFromFile() { return null },
  }
  mockNamed(mod, stub)
}

const { runAgent } = await import('../src/agent.ts')
const { createUser, createSession, SESSION_COOKIE } = await import('../src/auth.ts')
const { db, getSetting } = await import('../src/db.ts')
const { app } = await import('../src/app.ts')

const user = createUser('secretagent@example.test', 'Test', 'secretagent-test-only')
const { token } = createSession(user.id)
const headers = { cookie: `${SESSION_COOKIE}=${token}`, 'content-type': 'application/json' }
const events = []

test.after(() => { db.close(); rmSync(root, { recursive: true, force: true }) })

test('agent bisa menyimpan secret lewat tool set_secret tanpa menulis file', async () => {
  const res = await app.request('/api/projects', { method: 'POST', headers, body: JSON.stringify({ name: 'SecretAgent' }) })
  assert.equal(res.status, 201)
  const id = (await res.json()).project.id
  await runAgent(id, 'Simpan token contoh', (e) => events.push(e))
  assert.equal(getSetting(id, 'secret_E2E_PING_TOKEN'), SECRET_VALUE)
  assert.ok(events.some((e) => e.type === 'status' && /Install|Menyusun|Membaca|Memeriksa/.test(e.text)) || callCount >= 2)
  assert.ok(callCount >= 2, 'agent melanjutkan percakapan setelah tool call')
})

test('nilai secret tidak pernah muncul di event SSE', () => {
  const raw = JSON.stringify(events)
  assert.ok(!raw.includes(SECRET_VALUE), 'nilai secret tidak dibocorkan lewat SSE')
})
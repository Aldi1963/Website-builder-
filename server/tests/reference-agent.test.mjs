import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const root = mkdtempSync(join(tmpdir(), 'vb-refagent-'))
process.env.VB_DB = join(root, 'platform.db')
const seen = []
const llmMock = {
    complete: async (messages) => { seen.push(messages); return { message: { role: 'assistant', content: '' }, usage: {} } },
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
mock.module('../src/llm.ts', { exports: llmMock, namedExports: llmMock })
const workspaceMock = {
  ensureWorkspace(id) { return join(root, id) }, projectDir(id) { return join(root, id) },
  async installDeps() { return { code: 0, output: '' } }, async buildProject() { return { code: 0, output: '' } },
  async startPreview() { return 45100 }, stopPreview() {}, runningPreviews() { return [] },
  previewPort() { return 45100 }, readProjectFile() { return null }, writeProjectFile() {},
  newDirsForFile() { return [] }, deleteProjectFile() {},
}
mock.module('../src/workspace.ts', { exports: workspaceMock, namedExports: workspaceMock })
const { saveReferenceImage } = await import('../src/reference-images.ts')
const { runAgent } = await import('../src/agent.ts')
const { createUser, createSession, SESSION_COOKIE } = await import('../src/auth.ts')
const { db } = await import('../src/db.ts')
const { app } = await import('../src/app.ts')

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
const user = createUser('refagent@example.test', 'Test', 'refagent-test-only')
const { token } = createSession(user.id)
const headers = { cookie: `${SESSION_COOKIE}=${token}`, 'content-type': 'application/json' }
test.after(() => { db.close(); rmSync(root, { recursive: true, force: true }) })

async function makeProject() {
  const res = await app.request('/api/projects', { method: 'POST', headers, body: JSON.stringify({ name: 'RefAgent' }) })
  assert.equal(res.status, 201)
  return (await res.json()).project.id
}

test('imageIds menghasilkan pesan user multimodal ke LLM', async () => {
  const id = await makeProject()
  const saved = await saveReferenceImage(id, PNG, 'acuan.png')
  await runAgent(id, 'Buat seperti desain ini', () => {}, undefined, false, { imageIds: [saved.id] })
  assert.ok(seen.length > 0, 'complete dipanggil')
  assert.equal(typeof seen[0][0].content, 'string', 'system prompt tetap string')
  const refMsg = seen.flat().find((m) => Array.isArray(m.content))
  assert.ok(refMsg, 'ada pesan multimodal')
  assert.ok(refMsg.content.some((p) => p.type === 'image_url' && p.image_url.url === PNG))
  const text = refMsg.content.find((p) => p.type === 'text').text
  assert.match(text, /GAMBAR REFERENSI DESAIN/)
  assert.match(text, /DESIGN\.md/)
  assert.match(text, /src\/styles\.css/)
})

test('tanpa imageIds tidak ada pesan multimodal', async () => {
  seen.length = 0
  const id = await makeProject()
  await runAgent(id, 'Buat halaman baru', () => {}, undefined, false)
  assert.ok(seen.length > 0)
  assert.ok(seen[0].every((m) => typeof m.content === 'string'))
})

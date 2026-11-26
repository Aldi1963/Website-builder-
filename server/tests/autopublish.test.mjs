import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const appSource = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8')
const uiSource = readFileSync(new URL('../../platform/src/App.tsx', import.meta.url), 'utf8')

test('chat completion auto-publishes only when UI changed and build succeeded', () => {
  const marker = 'autoPublishAfterRun'
  assert.ok(appSource.includes(marker), 'server must expose an auto-publish helper')
  const declaration = appSource.indexOf('async function autoPublishAfterRun(')
  const call = appSource.indexOf('autoPublishAfterRun(id,', declaration + 1)
  assert.ok(declaration >= 0 && call > declaration, 'chat completion must call auto-publish after the run')
  const chatStart = appSource.indexOf("app.post('/api/projects/:id/chat'")
  assert.ok(call > chatStart, 'auto-publish call must be inside the chat route')
})

test('preview link prefers public URL when a project is published', () => {
  assert.match(uiSource, /slug \? publicUrl\(slug\)/, 'preview button must use public URL when published')
})

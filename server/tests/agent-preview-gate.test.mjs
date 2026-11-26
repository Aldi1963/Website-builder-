import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../src/agent.ts', import.meta.url), 'utf8')

test('successful UI build cannot finish on plain text before check_preview', () => {
  const branchStart = source.indexOf('if (msg.content && typeof msg.content === \'string\' && msg.content.trim() && !calls.length)')
  const branchEnd = source.indexOf('if (!calls.length)', branchStart)
  assert.ok(branchStart >= 0 && branchEnd > branchStart, 'plain-text response branch exists')
  const branch = source.slice(branchStart, branchEnd)
  assert.match(branch, /touchedUi && buildSucceeded && auditCompleted && previewRounds < 1/, 'branch must detect a due visual review')
  assert.match(branch, /check_preview/, 'branch must explicitly require the preview tool')
  assert.match(branch, /continue\s*;?/, 'branch must continue the agent loop instead of returning a final answer')
})

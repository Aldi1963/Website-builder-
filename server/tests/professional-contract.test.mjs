import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
const root = new URL('../..', import.meta.url).pathname
const prompts = readFileSync(root + 'server/src/prompts.ts', 'utf8')
test('prompt: kontrak aplikasi profesional disuntik ke system prompt', () => {
  assert.match(prompts, /const PROFESIONAL/)
  assert.match(prompts, /\$\{PROFESIONAL\}/)
  assert.match(prompts, /dashboard.*angka.*database/is)
  assert.match(prompts, /requireRole/)
  assert.match(prompts, /INTEGER sen/)
})
test('audit: kelengkapan produk jadi temuan prioritas utama', () => {
  const i = prompts.indexOf('Yang dicari, berurutan prioritas:')
  assert.ok(i > 0)
  const block = prompts.slice(i, i + 700)
  assert.match(block, /Kelengkapan produk/i)
  assert.match(block, /kritis/i)
})


test('prompt: prompt pendek otomatis jadi aplikasi lengkap ala Lovable', () => {
  assert.match(prompts, /Prompt PENDEK/)
  assert.match(prompts, /Lovable/)
  assert.match(prompts, /Jangan bertanya soal fitur/)
})

test('agent: temuan audit kritis memicu perbaikan otomatis, bukan sekadar laporan', () => {
  const agent = readFileSync(root + 'server/src/agent.ts', 'utf8')
  assert.match(agent, /needsFix = lastBuildFailed \|\|/)
  assert.match(agent, /\.tingkat === 'kritis'/)
  assert.match(agent, /WAJIB perbaiki temuan kritis/)
})

test('agent: prompt pendek bertema bikinin selalu memaksa jalur penuh', () => {
  const agent = readFileSync(root + 'server/src/agent.ts', 'utf8')
  assert.match(agent, /shortBuildIntent/)
  assert.match(agent, /bikinkan\|bikin\|buatkan/)
  assert.match(agent, /!shortBuildIntent && !opts/)
})

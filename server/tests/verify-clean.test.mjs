import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const agent = readFileSync(new URL('../src/agent.ts', import.meta.url), 'utf8')

test('ringkasan akhir hanya sah setelah render ulang membuktikan cacat hilang', () => {
  assert.match(agent, /defectsVerifiedClean/, 'harus ada state bukti render bersih')
  assert.match(agent, /defectsVerifiedClean = cap\.defects\.length === 0 && cap\.runtimeErrors\.length === 0/, 'bukti bersih dihitung dari probe nyata, bukan klaim model')
  assert.match(agent, /Sebelum merangkum, panggil check_preview SATU kali lagi/, 'model dipaksa verifikasi ulang sebelum merangkum')
  assert.match(agent, /!defectsVerifiedClean && previewRounds > 0 && previewRounds < MAX_PREVIEW_ROUNDS/, 'gerbang dibatasi ronde supaya tidak loop')
})

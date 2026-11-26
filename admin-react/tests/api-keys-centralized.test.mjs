/* Semua API key & secret dikelola terpusat di halaman /admin/settings.
   Halaman AI (ai-settings, providers) dan Pembayaran (billing) hanya boleh
   menaut ke Settings, bukan memuat input key lagi.
   Jalankan: cd admin-react && node --test tests/*.mjs */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = (p) => readFileSync(new URL('../src/' + p, import.meta.url), 'utf8')

test('Settings memuat satu bagian API Key & Secret untuk semua kredensial', () => {
  const settings = src('pages/settings.tsx')
  const component = src('components/ApiKeysSection.tsx')
  assert.match(settings, /ApiKeysSection/)
  assert.match(settings, /id="api-keys"/)
  for (const endpoint of ['/api/admin/ai-settings', '/api/admin/billing', '/api/admin/llm/providers']) {
    assert.ok(component.includes(endpoint), `Settings harus mengelola ${endpoint}`)
  }
  assert.match(component, /\/key`/, 'key provider disimpan lewat endpoint /key')
})

test('Pengaturan AI tidak lagi berisi field API key', () => {
  const s = src('pages/ai-settings.tsx')
  assert.doesNotMatch(s, /id="ai-key"/)
  assert.doesNotMatch(s, /payload\.key/)
  assert.match(s, /\/admin\/settings#api-keys/)
})

test('Pembayaran tidak lagi berisi field API key / webhook secret', () => {
  const s = src('pages/billing.tsx')
  assert.doesNotMatch(s, /id="billing-api-key"/)
  assert.doesNotMatch(s, /id="billing-webhook-secret"/)
  assert.match(s, /\/admin\/settings#api-keys/)
})

test('Provider LLM tidak lagi berisi input key, hanya status + tautan', () => {
  const s = src('components/CProviderCard.tsx')
  assert.doesNotMatch(s, /prov-key-/)
  assert.doesNotMatch(s, /saveKey|putKey/)
  assert.match(s, /\/admin\/settings#api-keys/)
  assert.match(src('pages/providers.tsx'), /\/admin\/settings#api-keys/)
})

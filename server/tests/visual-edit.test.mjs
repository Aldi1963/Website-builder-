import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const root = '/home/hatch/workspace/vibebuilder/'
const proxy = readFileSync(root + 'server/src/preview-proxy.ts', 'utf8')
const panels = readFileSync(root + 'platform/src/panels.tsx', 'utf8')
const bridge = readFileSync(root + 'server/src/visual-bridge.js', 'utf8')
const app = readFileSync(root + 'platform/src/App.tsx', 'utf8')
const prompts = readFileSync(root + 'server/src/prompts.ts', 'utf8')

test('proxy: menyuntik bridge visual-edit hanya untuk HTML workspace, bukan app publik', () => {
  assert.match(proxy, /withVisualBridge|visual-bridge|__vbEditor/)
  assert.match(proxy, /text\/html/i)
  // harus ada penanda query/header yang membedakan permintaan editor
  assert.match(proxy, /__vbEditor|vb_editor|X-VB-Editor/i)
})

test('proxy: bridge mengirim selector, label, path, dan posisi ke parent via postMessage', () => {
  assert.match(bridge, /postMessage/)
  assert.match(bridge, /vb:pick/)
  assert.match(bridge, /tagName|nodeName/)
  assert.match(bridge, /getBoundingClientRect/)
})

test('UI: PreviewPane punya toggle pilih elemen dan menampilkan badge target', () => {
  const start = panels.indexOf('export function PreviewPane(')
  const block = panels.slice(start, start + 6000)
  assert.match(block, /Pilih elemen|pilih-elemen|visualEdit/i)
  assert.match(block, /onPick|pickedElement|selectedElement/i)
  assert.match(block, /addEventListener\(|onMessage/i)
  assert.match(block, /iframe/)
})

test('UI: prompt visual edit dikirim ke chat dengan konteks elemen', () => {
  assert.match(app, /selector|targetElemen|elemen yang dipilih/i)
  assert.match(app, /send\(/)
  assert.match(app, /vb:pick|pickElement|onPick=/i)
})

test('agent: instruksi visual edit meminta perubahan pada file yang menaungi elemen', () => {
  assert.match(prompts, /visual|elemen|selector/i)
  assert.match(prompts, /file yang menaungi|file yang mengandung|komponen yang/i)
})

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const agent = readFileSync(new URL('../src/agent.ts', import.meta.url), 'utf8')
const managedDb = readFileSync(new URL('../src/managed-db.ts', import.meta.url), 'utf8')
const shots = readFileSync(new URL('../src/screenshots.ts', import.meta.url), 'utf8')

test('schema brief tersedia dan disuntikkan ke system prompt agent', () => {
  assert.match(managedDb, /export async function projectSchemaBrief/, 'helper ringkasan skema harus ada')
  assert.match(managedDb, /information_schema\.columns/, 'helper harus membaca kolom nyata')
  assert.match(agent, /projectSchemaBrief\(projectId\)/, 'agent harus memanggil helper')
  assert.match(agent, /Skema database proyek saat ini \(pakai nama ini, jangan menebak\)/, 'system prompt harus memberi konteks skema')
  // Best-effort: kegagalan baca skema tidak boleh memblokir run.
  assert.match(agent, /try \{ schemaBrief = \(await projectSchemaBrief\(projectId\)\) \?\? '' \} catch/, 'pembacaan skema harus dibungkus try/catch (best-effort)')
})

test('probe visual mendeteksi blank, overlay, dan overflow desktop + 360px', () => {
  assert.match(shots, /defects: string\[\]/, 'ReviewCapture harus membawa daftar cacat')
  for (const kind of ['blank', 'overlay', 'overflow', 'empty-shell', 'overflow-360']) {
    assert.ok(shots.includes(`'${kind}'`) || shots.includes(`\`${kind}`), `probe harus mendeteksi ${kind}`)
  }
  assert.match(shots, /setViewportSize\(\{ width: 360, height: 780 \}\)/, 'probe wajib mengukur lebar 360px')
  assert.match(shots, /document\.documentElement\.scrollWidth/, 'overflow diukur dari DOM nyata')
})

test('cacat hasil probe masuk ke tool result DAN pesan multimodal self-healing', () => {
  assert.match(agent, /pendingPreviewDefects = cap\.defects/, 'state cacat harus ditampung')
  assert.match(agent, /\$\{defectNote\}/, 'tool result harus memberi tahu model soal cacat')
  assert.match(agent, /Cacat render yang TERDETEKSI otomatis/, 'pesan multimodal harus memuat cacat')
  // Kalau model tanpa vision, cacat tetap harus dibersihkan supaya tidak bocor ke giliran berikut.
  assert.equal((agent.match(/pendingPreviewDefects = \[\]/g) ?? []).length >= 2, true, 'state cacat harus direset di semua jalur')
})

test('routePathFromFile memetakan nama file TanStack ke URL', async () => {
  const { routePathFromFile } = await import('../src/route-paths.ts')
  const cases = {
    'src/routes/index.tsx': '/',
    'src/routes/__root.tsx': null,
    'src/routes/dashboard.tsx': '/dashboard',
    'src/routes/courses.$slug.tsx': '/courses/$slug',
    'src/routes/courses.$slug_.certificate.tsx': '/courses/$slug/certificate',
  }
  for (const [file, expected] of Object.entries(cases)) {
    assert.equal(routePathFromFile(file), expected, file)
  }
})

test('probe mendeteksi halaman yatim dan agent meneruskan rute baru', () => {
  assert.match(shots, /orphan-route/, 'probe harus mendeteksi halaman yatim')
  assert.match(shots, /newRoutes\?: string\[\]/, 'probe menerima daftar rute baru')
  assert.match(agent, /newRouteFiles/, 'agent mencatat file rute yang ditulis')
  assert.match(agent, /captureForReview\(projectId, \{ newRoutes: newRouteFiles \}\)/, 'rute baru diteruskan ke probe')
})

test('cacat visual menjadi gerbang wajib sebelum ringkasan akhir', () => {
  assert.match(agent, /Jangan beri ringkasan akhir: probe visual masih menemukan/, 'model tidak boleh menutup run saat cacat aktif')
  assert.match(agent, /pendingPreviewDefects\.length && msg\.content/, 'gerbang aktif hanya saat ada cacat')
  assert.match(agent, /Ada \$\{cap\.defects\.length\} masalah tampilan, memperbaiki otomatis/, 'user melihat status perbaikan')
  assert.match(agent, /VB_MAX_PREVIEW_ROUNDS \?\? 4/, 'batas ronde dinaikkan untuk siklus perbaikan')
})

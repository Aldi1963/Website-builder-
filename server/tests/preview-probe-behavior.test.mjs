import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { captureReviewFromUrl } from '../src/screenshots.ts'

async function withServer(html, fn, extra) {
  const srv = createServer((req, res) => {
    if (extra && extra[req.url] !== undefined) {
      res.writeHead(extra[req.url], { 'content-type': 'text/html; charset=utf-8' })
      res.end('broken')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = (srv.address()).port
  try { return await fn(`http://127.0.0.1:${port}/`) } finally { await new Promise((r) => srv.close(r)) }
}

test('probe deteksi halaman benar-benar kosong', async () => {
  await withServer('<html><body><div id="root"></div></body></html>', async (url) => {
    const cap = await captureReviewFromUrl('probe-test-blank', url)
    assert.ok(cap.defects.some((d) => d.startsWith('blank:')), `defects=${JSON.stringify(cap.defects)}`)
  })
})

test('probe lolos pada halaman sehat (tanpa cacat)', async () => {
  const healthy = `<html><body style="margin:0"><div id="root" style="max-width:100%;padding:16px">
    <h1>Katalog Kursus</h1><main><ul>${[1,2,3,4].map((i) => `<li><a href="#">Kursus ${i}</a></li>`).join('')}</ul></main>
    <script>console.log('ready')</script></div></body></html>`
  await withServer(healthy, async (url) => {
    const cap = await captureReviewFromUrl('probe-test-healthy', url)
    assert.equal(cap.defects.length, 0, `defects=${JSON.stringify(cap.defects)}`)
    assert.equal(cap.runtimeErrors.length, 0, `errors=${JSON.stringify(cap.runtimeErrors)}`)
    assert.match(cap.image, /^data:image\/png;base64,/)
  })
})

test('probe deteksi overflow horizontal nyata', async () => {
  const wide = `<html><body style="margin:0"><div id="root">
    <h1>Halaman</h1><main><ul><li><a href="#">A</a></li><li><a href="#">B</a></li><li><a href="#">C</a></li></ul></main>
    <div style="width:1400px;height:20px"></div></div></body></html>`
  await withServer(wide, async (url) => {
    const cap = await captureReviewFromUrl('probe-test-wide', url)
    assert.ok(cap.defects.some((d) => d.startsWith('overflow:') || d.startsWith('overflow-360:')),
      `defects=${JSON.stringify(cap.defects)}`)
  })
})

test('probe deteksi rute internal yang membalas 500', async () => {
  const html = `<html><body><div id="root"><h1>Katalog</h1><main><ul>
    <li><a href="/sehat">Sehat</a></li><li><a href="/rusak">Rusak</a></li>
    <li><a href="/lagi">Lagi</a></li><li><a href="/empat">Empat</a></li>
    <li><a href="/lima">Lima</a></li></ul></main></div></body></html>`
  await withServer(html, async (url) => {
    const cap = await captureReviewFromUrl('probe-test-route', url)
    assert.ok(cap.defects.some((d) => d.startsWith('route-error:')),
      `defects=${JSON.stringify(cap.defects)}`)
  }, { '/rusak': 500 })
})

test('probe deteksi rute baru yang tidak punya tautan masuk', async () => {
  const html = `<html><body><div id="root"><h1>Beranda</h1><main><ul>
    <li><a href="/courses/kursus-a">Kursus A</a></li>
    <li><a href="/dashboard">Dashboard</a></li>
    <li><a href="/profil">Profil</a></li>
    <li><a href="/bantuan">Bantuan</a></li>
  </ul></main></div></body></html>`
  await withServer(html, async (url) => {
    const cap = await captureReviewFromUrl('probe-orphan-real', url, {
      newRoutes: ['/courses/$slug/certificate'],
    })
    assert.ok(cap.defects.some((d) => d.startsWith('orphan-route:')),
      `defects=${JSON.stringify(cap.defects)}`)
  }, { '/courses/kursus-a': 200, '/courses/kursus-a/bad': 500 })
})

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { captureReviewFromUrl } from '../src/screenshots.ts'

/* Server uji mencatat SEMUA request (metode + URL + body) supaya tes bisa
   MEMBUKTIKAN probe tidak pernah memutasi: tidak ada POST/PUT/PATCH/DELETE
   yang boleh sampai ke server selama capture, apa pun isi halamannya. */
async function withServer(routes, fn) {
  const requests = []
  const srv = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body })
      const html = routes[req.url] ?? routes['/'] ?? ''
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  try { return await fn(`http://127.0.0.1:${port}/`, requests) } finally { await new Promise((r) => srv.close(r)) }
}

const shell = (inner) => `<html><body><div id="root"><h1>Probe</h1><main>${inner}</main></div></body></html>`
const mutating = (requests) => requests.filter((r) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method))

test('interaction probe: tombol aman yang tidak melakukan apa pun dilaporkan', async () => {
  const html = shell(`<button id="mati">Lihat detail</button><button id="hidup" onclick="document.getElementById('hasil').textContent='Ditutup'">Tutup</button><p id="hasil"></p>`)
  await withServer({ '/': html }, async (url, requests) => {
    const cap = await captureReviewFromUrl('probe-interaction-button', url)
    assert.ok(cap.defects.some((d) => d.startsWith('dead-button:') && /Lihat detail/.test(d)),
      `defects=${JSON.stringify(cap.defects)}`)
    assert.ok(!cap.defects.some((d) => d.startsWith('dead-button:') && /Tutup/.test(d)),
      `tombol yang berfungsi salah dilaporkan: ${JSON.stringify(cap.defects)}`)
    assert.deepEqual(mutating(requests), [], 'klik tombol aman tidak boleh memutasi server')
  })
})

test('interaction probe: tombol bermutasi TIDAK PERNAH diklik', async () => {
  const html = shell(`<button id="s" onclick="fetch('/mutasi',{method:'POST'})">Simpan</button><button id="d" onclick="fetch('/mutasi',{method:'POST'})">Daftar</button><button id="b" onclick="fetch('/mutasi',{method:'POST'})">Beli</button>`)
  await withServer({ '/': html }, async (url, requests) => {
    const cap = await captureReviewFromUrl('probe-interaction-mutating', url)
    assert.deepEqual(mutating(requests), [],
      `probe mengklik tombol bermutasi: ${JSON.stringify(requests)}`)
    assert.ok(!cap.defects.some((d) => d.startsWith('dead-button:') && /Simpan|Daftar|Beli/.test(d)),
      `tombol bermutasi tidak boleh dilaporkan mati (tidak diklik): ${JSON.stringify(cap.defects)}`)
  })
})

test('interaction probe: form tanpa tombol submit aktif dilaporkan', async () => {
  const html = shell(`<form id="f"><label>Nama</label><input name="nama" /><button type="submit" disabled>Kirim</button></form><p>Catalog</p>`)
  await withServer({ '/': html }, async (url, requests) => {
    const cap = await captureReviewFromUrl('probe-interaction-form', url)
    assert.ok(cap.defects.some((d) => d.startsWith('form-no-submit:')),
      `defects=${JSON.stringify(cap.defects)}`)
    assert.deepEqual(mutating(requests), [], 'probe form tidak boleh memutasi server')
  })
})

test('interaction probe: form yang menolak isian valid dilaporkan', async () => {
  const html = shell(`<form id="f"><input name="kode" pattern="[0-9]+" title="angka saja" /><button type="submit">Kirim</button></form>`)
  await withServer({ '/': html }, async (url, requests) => {
    const cap = await captureReviewFromUrl('probe-interaction-invalid', url)
    assert.ok(cap.defects.some((d) => d.startsWith('form-invalid:')),
      `defects=${JSON.stringify(cap.defects)}`)
    assert.deepEqual(mutating(requests), [], 'probe form tidak boleh memutasi server')
  })
})

test('interaction probe: form valid (submit aktif, isian lolos validasi) tidak dilaporkan', async () => {
  const html = shell(`<form id="f"><input name="nama" required /><button type="submit">Kirim</button></form><p id="pesan"></p>`)
  await withServer({ '/': html }, async (url, requests) => {
    const cap = await captureReviewFromUrl('probe-interaction-valid', url)
    assert.ok(!cap.defects.some((d) => d.startsWith('form-')),
      `form valid salah dilaporkan: ${JSON.stringify(cap.defects)}`)
    assert.deepEqual(mutating(requests), [], 'probe form tidak boleh memutasi server')
  })
})

test('interaction probe: tidak pernah submit form / tidak pernah memutasi server', async () => {
  /* Form POST sungguhan + tombol bermutasi yang akan POST bila diklik: bila
     probe masih men-submit atau mengklik, server uji langsung mencatatnya. */
  const html = shell(`<form id="f" action="/simpan" method="post"><input name="nama" value="Awal" /><button type="submit">Kirim</button></form><button onclick="fetch('/mutasi',{method:'POST'})">Buat akun</button>`)
  await withServer({ '/': html }, async (url, requests) => {
    const cap = await captureReviewFromUrl('probe-interaction-nomutation', url)
    assert.match(cap.image, /^data:image\/png;base64,/)
    assert.ok(Array.isArray(cap.defects))
    assert.deepEqual(mutating(requests), [],
      `probe memutasi server (submit form / klik tombol bermutasi): ${JSON.stringify(requests)}`)
  })
})

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { captureReviewFromUrl } from '../src/screenshots.ts'

test('capture menyertakan URL resource yang gagal dimuat (http-404: /path)', { timeout: 60000 }, async () => {
  const server = createServer((req, res) => {
    if (req.url === '/missing-asset.js') {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><html><body><h1>Halaman uji</h1><script src="/missing-asset.js"></script></body></html>')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const cap = await captureReviewFromUrl('probe-asset-url', `http://127.0.0.1:${port}/`)
    assert.ok(
      cap.runtimeErrors.some((e) => e.includes('http-404: /missing-asset.js')),
      `harus ada URL aset 404 di runtimeErrors, dapat: ${JSON.stringify(cap.runtimeErrors)}`,
    )
    assert.equal(cap.runtimeErrors.some((e) => /Failed to load resource/.test(e)), false, 'console.error generik tidak boleh menggantikan URL')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

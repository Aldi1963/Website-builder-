import { serve } from 'srvx'
// Mimic hono streamSSE: TransformStream + async cb that finishes ~60s.
const app = (req) => {
  const { readable, writable } = new TransformStream()
  const enc = new TextEncoder()
  ;(async () => {
    const w = writable.getWriter()
    for (let i = 0; i < 90; i++) {
      await w.write(enc.encode(`event: status\ndata: {"i":${i}}\n\n`))
      await new Promise(r => setTimeout(r, 1000))
    }
    await w.write(enc.encode('event: done\ndata: {}\n\n'))
    await w.close()
  })()
  return new Response(readable, { headers: { 'content-type': 'text/event-stream', 'transfer-encoding': 'chunked' } })
}
serve({ fetch: app, port: 3997, hostname: '127.0.0.1' })
console.log('up2')

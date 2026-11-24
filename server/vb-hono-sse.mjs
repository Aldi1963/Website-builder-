import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { serve } from 'srvx'
const app = new Hono()
app.post('/sse', (c) => streamSSE(c, async (stream) => {
  for (let i = 0; i < 90; i++) {
    await stream.writeSSE({ event: 'status', data: JSON.stringify({ i }) })
    await stream.sleep(1000)
  }
  await stream.writeSSE({ event: 'done', data: '{}' })
}))
serve({ fetch: app.fetch, port: 3996, hostname: '127.0.0.1' })
console.log('hono-up')

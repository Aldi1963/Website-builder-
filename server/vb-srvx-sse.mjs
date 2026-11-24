import { serve } from 'srvx'
const app = (req) => new Response(new ReadableStream({
  start(c) {
    let i = 0
    const t = setInterval(() => {
      c.enqueue(new TextEncoder().encode(`event: tick\ndata: ${i++}\n\n`))
      if (i > 120) { clearInterval(t); c.close() }
    }, 1000)
  }
}), { headers: { 'content-type': 'text/event-stream' } })
serve({ fetch: app, port: 3998, hostname: '127.0.0.1' })
console.log('up')

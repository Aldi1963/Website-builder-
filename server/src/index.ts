import { serve } from 'srvx'
import { app } from './app.ts'
import { PLATFORM_PORT } from './paths.ts'

const port = PLATFORM_PORT

serve({
  fetch: app.fetch,
  port,
  hostname: '127.0.0.1',
})

console.log(`[vibebuilder] API on http://127.0.0.1:${port}`)

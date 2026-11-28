import { serve } from 'srvx'
import { app, ensurePublishedPreviews } from './app.ts'
import { PLATFORM_PORT } from './paths.ts'

const port = PLATFORM_PORT

serve({
  fetch: app.fetch,
  port,
  hostname: '127.0.0.1',
})

console.log(`[vibebuilder] API on http://127.0.0.1:${port}`)

// Published URLs stay reachable after a platform restart: rebuild missing
// bundles and warm the in-memory preview processes in the background.
void ensurePublishedPreviews().catch((err) => {
  console.warn('[published-restore] gagal:', (err as Error).message)
})

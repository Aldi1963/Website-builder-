import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { projectDir } from './workspace.ts'

const ENDPOINT = process.env.VB_IMAGE_URL ?? 'http://127.0.0.1:20128/v1/images/generations'
const MODEL = process.env.VB_IMAGE_MODEL ?? 'ag/gemini-3.1-flash-image'
const KEY = process.env.VB_LLM_KEY ?? process.env.HERMES_9ROUTER_API_KEY ?? ''

export type ImageResult = { ok: boolean; path?: string; detail: string }

/** Generate one image via the local gateway and write it into the project's
    public/ folder. Retries because the route commonly answers with prose or
    a transient 429/500; never returns the credential or base64 to the agent. */
export async function generateProjectImage(projectId: string, args: Record<string, unknown>): Promise<ImageResult> {
  const prompt = String(args.prompt ?? '').trim().slice(0, 1000)
  if (!prompt) return { ok: false, detail: 'ERROR: prompt gambar kosong.' }
  if (!KEY) return { ok: false, detail: 'ERROR: gateway gambar belum terkonfigurasi.' }
  let rawName = String(args.filename ?? 'generated').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60) || 'generated'
  if (!/\.(png|jpg|jpeg|webp)$/i.test(rawName)) rawName += '.png'
  const rel = `public/${rawName}`
  const body = JSON.stringify({ model: MODEL, prompt, n: 1, size: 'auto' })
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(120_000),
      })
      if (!res.ok) continue
      const json: any = await res.json()
      const b64 = json?.data?.[0]?.b64_json
      if (!b64) continue
      const buf = Buffer.from(b64, 'base64')
      if (buf.length < 1000) continue
      const abs = join(projectDir(projectId), rel)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, buf)
      return { ok: true, path: rel, detail: `Gambar dibuat di ${rel} (${buf.length} byte). Pakai path /${rawName} di komponen.` }
    } catch { /* retry */ }
  }
  return { ok: false, detail: 'ERROR: gateway gambar tidak menghasilkan gambar setelah 4 percobaan.' }
}

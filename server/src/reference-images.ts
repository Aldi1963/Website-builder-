import { mkdir, writeFile, readFile, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { PROJECTS_DIR } from './paths.ts'

/* Gambar referensi disimpan di .references, sejajar dengan .screenshots:
   di dalam workspace proyek tetapi di LUAR tabel files/snapshot/ZIP, supaya
   tidak ikut ter-build atau membulkan riwayat versi. */

const DIR_NAME = '.references'
const MAX_BYTES = 5 * 1024 * 1024
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
}

const dir = (projectId: string) => join(PROJECTS_DIR, projectId, DIR_NAME)

export type ReferenceImage = {
  id: string
  name: string
  mime: string
  size: number
  createdAt: number
  dataUrl: string
}

function safeName(name: string): string {
  return (name || 'referensi').replace(/[^\w.-]+/g, '_').slice(0, 80)
}

/** Terima data-URL image/* atau base64 mentah; kembalikan data-URL tervalidasi. */
export function normalizeImageDataUrl(input: string): { dataUrl: string; mime: string; bytes: number } | null {
  const raw = typeof input === 'string' ? input.trim() : ''
  const m = raw.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/)
  const mime = m?.[1] ?? (raw.startsWith('/9j/') ? 'image/jpeg' : raw.startsWith('iVBOR') ? 'image/png' : raw.startsWith('UklGR') ? 'image/webp' : raw.startsWith('R0lGOD') ? 'image/gif' : '')
  const b64 = m?.[2] ?? (!raw.startsWith('data:') ? raw : '')
  if (!ALLOWED_MIME.has(mime) || !b64 || b64.length % 4 !== 0 || b64.length > Math.ceil(MAX_BYTES * 4 / 3) + 4) return null
  let buf: Buffer
  try { buf = Buffer.from(b64, 'base64') } catch { return null }
  if (!buf.length || buf.length > MAX_BYTES) return null
  // Pastikan base64 benar-benar gambar, bukan string acak bertanda image/*.
  const re = Buffer.from(buf.toString('base64'), 'base64')
  if (!re.equals(buf)) return null
  return { dataUrl: `data:${mime};base64,${buf.toString('base64')}`, mime, bytes: buf.length }
}

export async function saveReferenceImage(projectId: string, input: string, name = 'referensi'): Promise<ReferenceImage> {
  const norm = normalizeImageDataUrl(input)
  if (!norm) throw new Error('Gambar tidak valid. Gunakan PNG/JPEG/WebP/GIF maksimal 5 MB.')
  const id = randomBytes(5).toString('hex')
  const filename = `${Date.now()}-${id}.${EXT[norm.mime]}`
  await mkdir(dir(projectId), { recursive: true })
  const path = join(dir(projectId), filename)
  await writeFile(path, Buffer.from(norm.dataUrl.split(',')[1]!, 'base64'))
  await writeFile(`${path}.json`, JSON.stringify({ id, name: safeName(name), mime: norm.mime, size: norm.bytes, createdAt: Date.now() }))
  return { id, name: safeName(name), mime: norm.mime, size: norm.bytes, createdAt: Date.now(), dataUrl: norm.dataUrl }
}

export async function listReferenceImages(projectId: string): Promise<Omit<ReferenceImage, 'dataUrl'>[]> {
  try {
    const files = await readdir(dir(projectId))
    const out: Omit<ReferenceImage, 'dataUrl'>[] = []
    for (const f of files.filter((x) => x.endsWith('.json'))) {
      try {
        const meta = JSON.parse(await readFile(join(dir(projectId), f), 'utf8'))
        if (meta?.id && meta?.mime) out.push({ id: meta.id, name: meta.name ?? 'referensi', mime: meta.mime, size: meta.size ?? 0, createdAt: meta.createdAt ?? 0 })
      } catch { /* meta rusak: lewati */ }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, 20)
  } catch { return [] }
}

export async function readReferenceImage(projectId: string, id: string): Promise<ReferenceImage | null> {
  if (!/^[a-f0-9]{10}$/.test(id)) return null
  try {
    const entries = await readdir(dir(projectId))
    for (const f of entries.filter((x) => x.endsWith('.json'))) {
      const meta = JSON.parse(await readFile(join(dir(projectId), f), 'utf8'))
      if (meta?.id !== id) continue
      const imageFile = f.slice(0, -5)
      const buf = await readFile(join(dir(projectId), imageFile))
      const dataUrl = `data:${meta.mime};base64,${buf.toString('base64')}`
      return { id: meta.id, name: meta.name, mime: meta.mime, size: buf.length, createdAt: meta.createdAt ?? 0, dataUrl }
    }
  } catch { /* abaikan */ }
  return null
}

export async function deleteReferenceImage(projectId: string, id: string): Promise<boolean> {
  if (!/^[a-f0-9]{10}$/.test(id)) return false
  try {
    const entries = await readdir(dir(projectId))
    let removed = false
    for (const f of entries.filter((x) => x.endsWith('.json'))) {
      const meta = JSON.parse(await readFile(join(dir(projectId), f), 'utf8'))
      if (meta?.id !== id) continue
      try { await unlink(join(dir(projectId), f)) } catch {}
      try { await unlink(join(dir(projectId), f.slice(0, -5))) } catch {}
      removed = true
    }
    return removed
  } catch { return false }
}

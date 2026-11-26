/* Screenshot preview proyek: diambil dari preview lokal dengan playwright-core,
   lalu disimpan sebagai file di data/projects/<id>/.screenshots (di luar tabel files).
   Karena itu screenshot tidak ikut terekspor (ZIP memakai listFiles DB), tidak masuk
   snapshot versi, dan tidak pernah dikirim ke konteks agent. */
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECTS_DIR } from './paths.ts'
import { startPreview } from './workspace.ts'

const MAX_BYTES = 8 * 1024 * 1024
const LOCAL_PLAYWRIGHT = '/home/hatch/workspace/tools/waview/node_modules/playwright-core'
const LOCAL_CHROME = '/home/hatch/workspace/chrome/linux-157.0.8103.78/chrome-linux64/chrome'

export type ScreenshotMeta = { name: string; url: string; created_at: number; bytes: number }

function screenshotsDir(projectId: string) {
  return join(PROJECTS_DIR, projectId, '.screenshots')
}

function screenshotUrl(projectId: string, name: string) {
  return `/api/projects/${projectId}/screenshots/${name}`
}

/* playwright-core bersifat opsional: coba resolve sebagai dependency normal dulu,
   lalu fallback ke instalasi lokal yang sudah ada. Bila keduanya gagal, capture
   dilempar sebagai error dan chat melaporkannya apa adanya. */
async function loadPlaywright(): Promise<{ chromium: { launch: (opts: unknown) => Promise<any> } }> {
  const imported: any = await import('playwright-core').catch(() => null)
  const fromImport = imported?.chromium ? imported : imported?.default
  if (fromImport?.chromium) return fromImport
  try {
    const require = createRequire(import.meta.url)
    const required: any = require(join(LOCAL_PLAYWRIGHT, 'index.js'))
    const fromRequire = required?.chromium ? required : required?.default
    if (fromRequire?.chromium) return fromRequire
  } catch {
    /* abaikan, lempar error di bawah */
  }
  throw new Error('playwright-core tidak tersedia di server')
}

/* Satu capture dalam satu waktu supaya pemakaian RAM aman di VM kecil. */
let captureQueue: Promise<unknown> = Promise.resolve()

async function captureNow(projectId: string, target: string): Promise<ScreenshotMeta> {
  const pw = await loadPlaywright()
  const executablePath = process.env.VB_CHROME_PATH ?? (existsSync(LOCAL_CHROME) ? LOCAL_CHROME : undefined)
  const browser = await pw.chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.goto(target, { waitUntil: 'load', timeout: 15_000 })
    await page.waitForTimeout(800)
    const buf: Buffer = await page.screenshot({ type: 'png' })
    if (!buf?.length) throw new Error('hasil screenshot kosong')
    if (buf.length > MAX_BYTES) throw new Error('screenshot melebihi batas 8 MB')
    const name = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.png`
    mkdirSync(screenshotsDir(projectId), { recursive: true })
    writeFileSync(join(screenshotsDir(projectId), name), buf)
    return { name, url: screenshotUrl(projectId, name), created_at: Date.now(), bytes: buf.length }
  } finally {
    await browser.close().catch(() => {})
  }
}

/** Ambil screenshot dari preview proyek; preview otomatis dinyalakan bila belum jalan. */
export async function captureScreenshot(projectId: string): Promise<ScreenshotMeta> {
  const port = await startPreview(projectId)
  return captureFromUrl(projectId, `http://127.0.0.1:${port}/`)
}

/* ---- Self-healing: capture yang MENGEMBALIKAN gambar + error runtime ----
   Berbeda dari captureScreenshot (yang hanya menyimpan file untuk UI chat),
   captureForReview mengembalikan PNG sebagai base64 data-URL + daftar error
   console/pageerror, sehingga AGENT bisa MELIHAT hasil render dan membaca
   error runtime — bukan hanya teks build. Inilah yang membuat loop
   self-healing visual (baca tampilan → deteksi masalah → perbaiki) mungkin. */
export type ReviewCapture = {
  /** PNG sebagai data-URL (data:image/png;base64,...) siap dikirim ke LLM vision. */
  image: string
  /** Pesan console berjenis error/warning + pageerror yang tertangkap saat render. */
  runtimeErrors: string[]
  url: string
}

async function captureNowWithErrors(projectId: string, target: string): Promise<ReviewCapture> {
  const pw = await loadPlaywright()
  const executablePath = process.env.VB_CHROME_PATH ?? (existsSync(LOCAL_CHROME) ? LOCAL_CHROME : undefined)
  const browser = await pw.chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const runtimeErrors: string[] = []
    // Kumpulkan error console (error/fatal) dan unhandled pageerror — sinyal
    // bahwa aplikasi dirender TAPI rusak saat runtime (bukan gagal build).
    page.on('console', (msg: any) => {
      try {
        if (msg.type() === 'error') {
          const t = String(msg.text() ?? '').slice(0, 300)
          if (t) runtimeErrors.push(`console.error: ${t}`)
        }
      } catch { /* abaikan pesan console tak terbaca */ }
    })
    page.on('pageerror', (err: any) => {
      const t = String(err?.message ?? err ?? '').slice(0, 300)
      if (t) runtimeErrors.push(`pageerror: ${t}`)
    })
    await page.goto(target, { waitUntil: 'load', timeout: 15_000 })
    await page.waitForTimeout(1200)
    const buf: Buffer = await page.screenshot({ type: 'png' })
    if (!buf?.length) throw new Error('hasil screenshot kosong')
    // Simpan juga sebagai file supaya muncul di galeri screenshot UI.
    const name = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.png`
    try {
      mkdirSync(screenshotsDir(projectId), { recursive: true })
      writeFileSync(join(screenshotsDir(projectId), name), buf)
    } catch { /* penyimpanan gagal tidak membatalkan review */ }
    return {
      image: `data:image/png;base64,${buf.toString('base64')}`,
      runtimeErrors: runtimeErrors.slice(0, 10),
      url: screenshotUrl(projectId, name),
    }
  } finally {
    await browser.close().catch(() => {})
  }
}

/** Capture untuk self-healing: kembalikan gambar base64 + error runtime.
    Dipakai agent, bukan UI chat. Antri seperti capture lain (RAM aman). */
export function captureForReview(projectId: string): Promise<ReviewCapture> {
  const run = async (): Promise<ReviewCapture> => {
    const port = await startPreview(projectId)
    return captureNowWithErrors(projectId, `http://127.0.0.1:${port}/`)
  }
  const next = captureQueue.then(run, run)
  captureQueue = next.catch(() => {})
  return next
}

/** Capture dari URL eksplisit; dipisah agar bisa diuji tanpa preview proyek. */
export function captureFromUrl(projectId: string, target: string): Promise<ScreenshotMeta> {
  const next = captureQueue.then(
    () => captureNow(projectId, target),
    () => captureNow(projectId, target),
  )
  captureQueue = next.catch(() => {})
  return next
}

export function listScreenshots(projectId: string): ScreenshotMeta[] {
  const dir = screenshotsDir(projectId)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.png'))
    .map((f) => {
      const st = statSync(join(dir, f))
      return { name: f, url: screenshotUrl(projectId, f), created_at: Math.round(st.mtimeMs), bytes: st.size }
    })
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 50)
}

/* Nama file divalidasi ketat (tanpa path traversal); null bila invalid/tidak ada. */
export function readScreenshot(projectId: string, name: string): Buffer | null {
  if (!/^[A-Za-z0-9._-]+\.png$/.test(name)) return null
  const abs = join(screenshotsDir(projectId), name)
  if (!existsSync(abs)) return null
  return readFileSync(abs)
}

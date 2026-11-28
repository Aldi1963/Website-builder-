import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { startPreview } from './workspace.ts'

const require = createRequire(import.meta.url)
const LOCAL_CHROME = '/usr/bin/chromium-browser'

type InteractAction =
  | { action: 'open'; path?: string }
  | { action: 'click'; selector: string }
  | { action: 'fill'; selector: string; value: string }
  | { action: 'select'; selector: string; value: string }
  | { action: 'press'; selector: string; key: string }
  | { action: 'text'; selector?: string }

export type InteractResult = {
  ok: boolean
  url: string
  action: string
  detail: string
  text?: string
  runtimeErrors: string[]
}

function loadPlaywright(): any {
  try { return require('playwright-core') } catch {}
  try { return require('playwright') } catch {}
  throw new Error('playwright-core tidak tersedia di server')
}

let pageCache = new Map<string, { page: any; browser: any; port: number }>()

async function pageFor(projectId: string) {
  const cached = pageCache.get(projectId)
  if (cached) return cached
  const pw = loadPlaywright()
  const executablePath = process.env.VB_CHROME_PATH ?? (existsSync(LOCAL_CHROME) ? LOCAL_CHROME : undefined)
  const browser = await pw.chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  })
  const port = await startPreview(projectId)
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  const entry = { page, browser, port }
  pageCache.set(projectId, entry)
  return entry
}

export async function closePreviewSession(projectId: string) {
  const entry = pageCache.get(projectId)
  pageCache.delete(projectId)
  if (entry) { try { await entry.browser.close() } catch {} }
}

export async function interactPreview(projectId: string, args: Record<string, unknown>): Promise<InteractResult> {
  const action = String(args.action ?? 'open') as InteractAction['action']
  const runtimeErrors: string[] = []
  try {
    const { page, port } = await pageFor(projectId)
    page.removeAllListeners('pageerror')
    page.on('pageerror', (e: any) => runtimeErrors.push(`pageerror: ${String(e?.message ?? e).slice(0, 300)}`))
    let detail = ''
    let text: string | undefined
    if (action === 'open') {
      const path = String(args.path ?? '/').trim() || '/'
      const target = path.startsWith('http') ? path : `http://127.0.0.1:${port}${path.startsWith('/') ? path : '/' + path}`
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      detail = `Dibuka ${target}`
    } else if (action === 'click') {
      const sel = String(args.selector ?? '')
      if (!sel) return { ok: false, url: page.url(), action, detail: 'selector kosong', runtimeErrors }
      await page.locator(sel).first().click({ timeout: 15_000 })
      detail = `Klik ${sel} berhasil`
    } else if (action === 'fill') {
      const sel = String(args.selector ?? '')
      if (!sel) return { ok: false, url: page.url(), action, detail: 'selector kosong', runtimeErrors }
      await page.locator(sel).first().fill(String(args.value ?? ''), { timeout: 15_000 })
      detail = `Isi ${sel} berhasil (nilai tidak ditampilkan)`
    } else if (action === 'select') {
      const sel = String(args.selector ?? '')
      if (!sel) return { ok: false, url: page.url(), action, detail: 'selector kosong', runtimeErrors }
      await page.locator(sel).first().selectOption(String(args.value ?? ''), { timeout: 15_000 })
      detail = `Pilih ${sel} berhasil`
    } else if (action === 'press') {
      const sel = String(args.selector ?? '')
      if (!sel) return { ok: false, url: page.url(), action, detail: 'selector kosong', runtimeErrors }
      await page.locator(sel).first().press(String(args.key ?? 'Enter'), { timeout: 15_000 })
      detail = `Tekan ${String(args.key ?? 'Enter')} pada ${sel} berhasil`
    } else if (action === 'text') {
      const sel = String(args.selector ?? 'body')
      text = (await page.locator(sel).first().innerText({ timeout: 15_000 })).slice(0, 6000)
      detail = `Teks dibaca (${text.length} karakter)`
    } else {
      return { ok: false, url: page.url(), action, detail: `aksi ${action} tidak dikenal`, runtimeErrors }
    }
    await page.waitForTimeout(350)
    return { ok: true, url: page.url(), action, detail, text, runtimeErrors }
  } catch (err) {
    return { ok: false, url: '', action, detail: String((err as Error).message).slice(0, 600), runtimeErrors }
  }
}

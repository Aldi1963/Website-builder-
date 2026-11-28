/* Screenshot preview proyek: diambil dari preview lokal dengan playwright-core,
   lalu disimpan sebagai file di data/projects/<id>/.screenshots (di luar tabel files).
   Karena itu screenshot tidak ikut terekspor (ZIP memakai listFiles DB), tidak masuk
   snapshot versi, dan tidak pernah dikirim ke konteks agent. */
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECTS_DIR } from './paths.ts'
import { startPreview } from './workspace.ts'
import { probeInteractions } from './interaction-probe.ts'

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
  /** Cacat render yang terdeteksi secara deterministik (bukan opini model). */
  defects: string[]
}

export type ProbeOptions = {
  /** Path rute (boleh bertemplate, mis. "/courses/$slug/certificate") yang
      baru dibuat/diubah pada run ini. Dipakai mendeteksi halaman yatim:
      dibuat tapi tidak ada satu pun tautan menuju ke sana. */
  newRoutes?: string[]
}

async function captureNowWithErrors(projectId: string, target: string, opts?: ProbeOptions): Promise<ReviewCapture> {
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
          // Info URL-nya diambil dari event `response` di bawah (lebih berguna).
          if (t && !/Failed to load resource/i.test(t)) runtimeErrors.push(`console.error: ${t}`)
        }
      } catch { /* abaikan pesan console tak terbaca */ }
    })
    page.on('pageerror', (err: any) => {
      const t = String(err?.message ?? err ?? '').slice(0, 300)
      if (t) runtimeErrors.push(`pageerror: ${t}`)
    })
    /* Sertakan URL resource yang gagal (404/500). Tanpa ini console.error
       hanya berkata "Failed to load resource: 404 ()" sehingga agent tidak
       tahu aset mana yang harus diperbaiki. */
    page.on('response', (res: any) => {
      try {
        const status = res.status?.() ?? 0
        if (status < 400) return
        let url = String(res.url?.() ?? '')
        try { url = new URL(url).pathname } catch { /* biarkan apa adanya */ }
        const t = `http-${status}: ${url}`.slice(0, 300)
        if (t && !runtimeErrors.includes(t)) runtimeErrors.push(t)
      } catch { /* abaikan respons tak terbaca */ }
    })
    await page.goto(target, { waitUntil: 'load', timeout: 15_000 })
    await page.waitForTimeout(1200)
    /* Probe deterministik: tiga cacat yang paling sering lolos dari build hijau
       tapi membuat aplikasi terlihat rusak bagi user. Diukur di browser nyata,
       bukan ditebak dari kode. */
    const defects: string[] = []
    try {
      const probe = await page.evaluate(() => {
        const out: { kind: string; detail: string }[] = []
        const text = (document.body?.innerText ?? '').trim()
        const root = document.getElementById('root') ?? document.body
        const rootText = (root?.innerText ?? '').trim()
        /* (a) Halaman kosong: tidak ada teks dan tidak ada elemen bermakna. */
        const meaningful = document.querySelectorAll('main,section,article,form,table,ul,ol,h1,h2,button,a,img,input').length
        if (text.length < 20 && meaningful < 3) {
          out.push({ kind: 'blank', detail: `Halaman tampak kosong: hanya ${text.length} karakter teks dan ${meaningful} elemen bermakna di #root.` })
        }
        /* (b) Overlay error framework (Vite/TanStack dev overlay) menutupi UI. */
        const overlay = document.querySelector(
          'vite-error-overlay, [data-vite-dev-id], .vite-error-overlay, [class*="error-overlay"], #webpack-dev-server-client-overlay',
        )
        if (overlay) out.push({ kind: 'overlay', detail: 'Overlay error build/runtime menutupi halaman.' })
        /* (c) Overflow horizontal — body lebih lebar dari viewport. */
        const docW = document.documentElement.scrollWidth
        const winW = window.innerWidth
        if (docW - winW > 8) {
          out.push({ kind: 'overflow', detail: `Ada scroll horizontal: konten ${docW}px pada viewport ${winW}px (${docW - winW}px lebih lebar).` })
        }
        /* (d) Teks konten yang benar-benar kosong padahal ada shell UI. */
        if (meaningful >= 3 && rootText.length < 20) {
          out.push({ kind: 'empty-shell', detail: 'Kerangka UI ada tetapi tidak ada teks konten yang dirender (data kosong / error tertelan).' })
        }
        return out
      })
      for (const d of probe) defects.push(`${d.kind}: ${d.detail}`)
    } catch { /* probe gagal tidak membatalkan review */ }
    /* Ukur juga di 360px: syarat mobile yang wajib lolos di prompt desain. */
    try {
      await page.setViewportSize({ width: 360, height: 780 })
      await page.waitForTimeout(400)
      const narrow = await page.evaluate(() => {
        const docW = document.documentElement.scrollWidth
        const winW = window.innerWidth
        return docW - winW > 8 ? `${docW}px pada viewport ${winW}px` : ''
      })
      if (narrow) defects.push(`overflow-360: Scroll horizontal di lebar 360px (${narrow}).`)
      await page.setViewportSize({ width: 1280, height: 800 })
      await page.waitForTimeout(200)
    } catch { /* abaikan */ }
    /* (e) Telusuri rute internal: build hijau tidak menjamin setiap halaman
       dirender. Rute baru yang balas >=400 adalah cacat paling mahal karena
       user langsung melihatnya. Dibatasi 6 rute agar capture tetap cepat. */
    try {
      const links: string[] = await page.evaluate(() => {
        const seen = new Set<string>()
        const out: string[] = []
        for (const a of Array.from(document.querySelectorAll('a[href]'))) {
          const raw = a.getAttribute('href') ?? ''
          if (!raw || raw.startsWith('#') || raw.startsWith('mailto:') || raw.startsWith('http')) continue
          let u: string
          try { u = new URL(raw, window.location.href).pathname } catch { continue }
          if (seen.has(u)) continue
          seen.add(u)
          out.push(u)
          if (out.length >= 6) break
        }
        return out
      })
      /* Preview di-mount di /api/projects/<id>/live. Tautan yang dikumpulkan
         memakai prefix itu, sedangkan nama rute relatif terhadap akar app.
         Buang prefix sebelum membandingkan. */
      const mountPrefix = new URL(page.url()).pathname.replace(/\/$/, '')
      const stripMount = (p: string) => p.startsWith(mountPrefix) ? p.slice(mountPrefix.length) || '/' : p
      const pagePath = stripMount(new URL(page.url()).pathname)
      const reachable = new Set<string>([pagePath])
      const allLinks = new Set<string>(links)
      for (const path of links.slice(0, 4)) {
        try {
          const res = await page.context().request.get(new URL(path, page.url()).toString(), { timeout: 8000, maxRedirects: 2 })
          if (res.status() >= 400) defects.push(`route-error: ${path} membalas HTTP ${res.status()}.`)
          else if (res.ok()) {
            /* Satu level lebih dalam: tautan ke fitur baru biasanya ada di
               halaman detail, bukan di beranda. HTML SSR tidak memuat <a>
               yang di-render client, jadi kunjungi dengan browser nyata
               dan baca DOM setelah hidrasi. Maksimal 4 halaman. */
            const sub = await browser.newPage({ viewport: { width: 1280, height: 800 } })
            try {
              await sub.goto(new URL(path, page.url()).toString(), { waitUntil: 'load', timeout: 10_000 })
              await sub.waitForTimeout(700)
              const childLinks: string[] = await sub.evaluate(() =>
                Array.from(document.querySelectorAll('a[href]'))
                  .map((a) => a.getAttribute('href') ?? '')
                  .filter((h) => h.startsWith('/') && !h.startsWith('//')),
              )
              for (const raw of childLinks) {
                if (/\.(css|js|png|svg|ico|woff2?)$/i.test(raw)) continue
                try {
                  const u = new URL(raw, page.url())
                  if (u.origin === new URL(page.url()).origin) allLinks.add(stripMount(u.pathname))
                } catch { /* abaikan href tak valid */ }
              }
            } catch { /* halaman detail gagal dirender — abaikan */ }
            finally { await sub.close().catch(() => {}) }
          }
        } catch { /* rute lambat/tidak bisa diakses — jangan salah tuduh */ }
      }
      for (const p of allLinks) reachable.add(p)
      /* (f) Halaman yatim: file rute baru ditulis, tetapi tidak ada tautan
         menuju ke sana dari halaman yang bisa dikunjungi. User tidak akan
         pernah menemukan fiturnya. Template berparameter dicocokkan pada
         segmen statisnya saja. */
      for (const route of opts?.newRoutes ?? []) {
        const segs = route.split('/').filter(Boolean)
        const staticSegs = segs.filter((x) => !x.startsWith('$'))
        if (!staticSegs.length) continue
        const prefix = staticSegs[0]
        const suffix = staticSegs[staticSegs.length - 1]
        /* Yang dihitung hanya tautan nyata <a href> dari halaman lain.
           Jangan memasukkan halaman yang sedang dibuka: kalau tidak, rute
           yang sedang diverifikasi akan menganggap dirinya sendiri sebagai
           "terhubung" dan cacat orphan tidak pernah terdeteksi. */
        const linked = [...allLinks].some((p) => {
          if (p === pagePath) return false // jangan hitung halaman itu sendiri
          if (segs.length === 1) return p === route
          const parts = p.split('/').filter(Boolean)
          return parts.includes(prefix) && parts.includes(suffix)
        })
        if (!linked) {
          defects.push(`orphan-route: halaman ${route} dibuat tetapi tidak ada tautan menuju ke sana — user tidak bisa menemukan fitur ini. Tambahkan tautan/navigasi ke halaman tersebut.`)
        }
      }
    } catch { /* abaikan */ }
    /* Interaction probe dijalankan SETELAH capture langkah-langkah visual,
       dan sebelum screenshot akhir. Probe BERSIFAT NON-MUTATING (tidak pernah
       submit form, tidak pernah klik tombol bermutasi) sehingga tidak ada
       baris database aplikasi yang ditulis selama probe. */
    try {
      for (const finding of await probeInteractions(page, target)) defects.push(`${finding.kind}: ${finding.detail}`)
    } catch { /* probe interaksi gagal tidak membatalkan capture */ }
    /* Probe tidak pernah memutasi, jadi tidak ada data yang perlu
       dikembalikan. Reload ini hanya membersihkan nilai "Probe" yang diketik
       di DOM supaya screenshot akhir menunjukkan keadaan awal halaman. */
    try {
      await page.goto(target, { waitUntil: 'load', timeout: 10_000 })
      await page.waitForTimeout(500)
    } catch { /* abaikan: screenshot tetap diambil dari halaman terakhir */ }
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
      defects: defects.slice(0, 8),
    }
  } finally {
    await browser.close().catch(() => {})
  }
}

/** Capture untuk self-healing: kembalikan gambar base64 + error runtime.
    Dipakai agent, bukan UI chat. Antri seperti capture lain (RAM aman). */
export function captureForReview(projectId: string, opts?: ProbeOptions): Promise<ReviewCapture> {
  const run = async (): Promise<ReviewCapture> => {
    const port = await startPreview(projectId)
    return captureNowWithErrors(projectId, `http://127.0.0.1:${port}/`, opts)
  }
  const next = captureQueue.then(run, run)
  captureQueue = next.catch(() => {})
  return next
}

/** Capture dari URL eksplisit; dipisah agar bisa diuji tanpa preview proyek. */
/** Sama seperti captureForReview, tapi dari URL eksplisit. Dipakai agent untuk
    memeriksa rute tertentu dan oleh tes deterministik. */
export function captureReviewFromUrl(projectId: string, target: string, opts?: ProbeOptions): Promise<ReviewCapture> {
  const run = async (): Promise<ReviewCapture> => captureNowWithErrors(projectId, target, opts)
  const next = captureQueue.then(run, run)
  captureQueue = next.catch(() => {})
  return next
}

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

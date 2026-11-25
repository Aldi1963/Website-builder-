import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { PROJECTS_DIR, TEMPLATE_DIR, PREVIEW_PORT_BASE, MAX_PREVIEWS } from './paths.ts'
import { listSettings } from './db.ts'
import { projectDbUrl } from './managed-db.ts'

const SKIP = new Set(['node_modules', 'dist', '.output', '.tanstack', '.git'])

export function projectDir(projectId: string) {
  return join(PROJECTS_DIR, projectId)
}

export function ensureWorkspace(projectId: string): string {
  const dir = projectDir(projectId)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    cpSync(TEMPLATE_DIR, dir, {
      recursive: true,
      filter: (src) => {
        const rel = src.slice(TEMPLATE_DIR.length + 1)
        if (!rel) return true
        return !rel.split('/').some((seg) => SKIP.has(seg))
      },
    })
  }
  return dir
}

export function writeProjectFile(projectId: string, relPath: string, content: string) {
  const dir = ensureWorkspace(projectId)
  const safe = sanitize(relPath)
  const abs = join(dir, safe)
  if (!abs.startsWith(dir)) throw new Error('path escapes workspace')
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content, 'utf8')
  return safe
}

/* Folder-folder (relatif terhadap proyek, dari yang paling dangkal) yang
   BELUM ada dan akan dibuat oleh writeProjectFile untuk berkas ini.
   Dipakai agent supaya pembuatan folder terlihat di feed aktivitas —
   sebelumnya mkdirSync di atas berjalan diam-diam. */
export function newDirsForFile(projectId: string, relPath: string): string[] {
  const dir = projectDir(projectId)
  const safe = sanitize(relPath)
  const abs = join(dir, safe)
  if (!abs.startsWith(dir)) return []
  const parts = dirname(safe).split('/').filter((s) => s && s !== '.')
  const out: string[] = []
  let cur = dir
  for (const p of parts) {
    cur = join(cur, p)
    if (!existsSync(cur)) out.push(cur.slice(dir.length + 1))
  }
  return out
}

export function readProjectFile(projectId: string, relPath: string): string | null {
  const dir = projectDir(projectId)
  const abs = join(dir, sanitize(relPath))
  if (!existsSync(abs)) return null
  return readFileSync(abs, 'utf8')
}

export function deleteProjectFile(projectId: string, relPath: string) {
  const dir = projectDir(projectId)
  const abs = join(dir, sanitize(relPath))
  if (existsSync(abs)) rmSync(abs, { recursive: false, force: true })
}

function sanitize(p: string) {
  const cleaned = p.replace(/\\/g, '/').replace(/^\/+/, '')
  if (cleaned.includes('..')) throw new Error('invalid path')
  return cleaned
}

export type RunResult = { code: number; output: string }

export function run(cmd: string, args: string[], cwd: string, timeoutMs = 180_000): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const push = (b: Buffer) => {
      out += b.toString('utf8')
      if (out.length > 40_000) out = out.slice(-40_000)
    }
    child.stdout.on('data', push)
    child.stderr.on('data', push)
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, output: out })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: 1, output: `${out}\n${err.message}` })
    })
  })
}

export async function installDeps(projectId: string) {
  const dir = ensureWorkspace(projectId)
  if (existsSync(join(dir, 'node_modules', '.package-lock.json'))) return { code: 0, output: 'deps cached' }
  return run('npm', ['install', '--no-audit', '--no-fund'], dir, 300_000)
}

export async function buildProject(projectId: string) {
  const dir = ensureWorkspace(projectId)
  const r = await run('npm', ['run', 'build'], dir, 240_000)
  if (r.code === 0) reconcileAssets(dir)
  return r
}

/**
 * TanStack Start hashes src/styles.css separately for the client and SSR graphs,
 * so the SSR chunk can reference /assets/styles-<hash>.css that the client build
 * never emitted. Map dangling CSS references onto the closest real client file.
 * JS chunk references must be left alone: the SSR graph emits its own chunks into
 * dist/server/assets, and rewriting those imports to client chunks breaks the
 * server bundle (client chunk never exists under dist/server/assets).
 */
function reconcileAssets(dir: string) {
  const clientAssets = join(dir, 'dist', 'client', 'assets')
  if (!existsSync(clientAssets)) return
  const real = readdirSync(clientAssets)
  const serverDir = join(dir, 'dist', 'server')
  const walk = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.js') ? [join(d, e.name)] : [],
    )
  if (!existsSync(serverDir)) return

  for (const file of walk(serverDir)) {
    let src = readFileSync(file, 'utf8')
    let changed = false
    for (const m of new Set(src.match(/\/assets\/[A-Za-z0-9._-]+\.css/g) ?? [])) {
      const name = m.slice('/assets/'.length)
      if (real.includes(name)) continue
      const base = name.slice(0, name.lastIndexOf('.'))
      const prefix = base.split('-')[0]
      const candidates = real.filter((f) => f.startsWith(`${prefix}-`) && f.endsWith('.css'))
      if (candidates.length !== 1) continue
      src = src.split(m).join(`/assets/${candidates[0]}`)
      changed = true
    }
    if (changed) writeFileSync(file, src, 'utf8')
  }
}

const previews = new Map<string, { port: number; proc: ChildProcess; settingsFingerprint: string }>()

export function previewPort(projectId: string): number {
  const existing = previews.get(projectId)
  if (existing) return existing.port
  const used = new Set([...previews.values()].map((v) => v.port))
  let h = 0
  for (const ch of projectId) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  const start = h % MAX_PREVIEWS
  for (let i = 0; i < MAX_PREVIEWS; i++) {
    const candidate = PREVIEW_PORT_BASE + ((start + i) % MAX_PREVIEWS)
    if (!used.has(candidate)) return candidate
  }
  throw new Error('semua slot preview terpakai')
}

export async function startPreview(projectId: string): Promise<number> {
  // Env preview (termasuk secret LLM) disuntikkan saat proses dinyalakan. Kalau
  // pengaturan berubah sejak preview jalan (mis. key LLM baru diisi), restart
  // prosesnya supaya env baru dipakai — kalau tidak, key baru tidak pernah
  // sampai ke aplikasi yang sedang di-preview.
  const settingsFingerprint = JSON.stringify(listSettings(projectId))
  const existing = previews.get(projectId)
  if (existing && existing.proc.exitCode === null) {
    if (existing.settingsFingerprint === settingsFingerprint) return existing.port
    existing.proc.kill('SIGTERM')
    for (let i = 0; i < 20 && existing.proc.exitCode === null; i++) {
      await new Promise((r) => setTimeout(r, 100))
    }
    previews.delete(projectId)
  }

  const dir = ensureWorkspace(projectId)
  // keep the static-asset server in sync with the platform's current version
  const serverFile = join(TEMPLATE_DIR, 'server.mjs')
  if (existsSync(serverFile)) cpSync(serverFile, join(dir, 'server.mjs'))
  const port = previewPort(projectId)
  // Settings stored per project are injected as env so generated apps can read
  // their own configuration without touching the platform's process env.
  // VB_APP_DB_PATH: jalur kanonik file database aplikasi (data/app.db di folder
  // proyek) — pola db.server.ts memakainya, fallback-nya path yang sama, supaya
  // data aplikasi persisten melewati restart preview/server.
  const env: Record<string, string> = { ...process.env, PORT: String(port), HOST: '127.0.0.1', VB_APP_DB_PATH: join(dir, 'data', 'app.db') }
  // Database terkelola (Postgres per-proyek): suntik koneksi ke env supaya app
  // hasil generate bisa memakai DB permanen tanpa mengelola kredensial sendiri.
  const pgUrl = await projectDbUrl(projectId)
  if (pgUrl) env.VB_APP_DATABASE_URL = pgUrl
  for (const s of listSettings(projectId)) {
    if (s.key.startsWith('secret_')) env[s.key.slice(7)] = s.value
    else env[`VB_SETTING_${s.key.replace(/[^a-zA-Z0-9_]/g, '_').toUpperCase()}`] = s.value
  }
  const proc = spawn('node', ['server.mjs'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] })
  proc.stdout?.on('data', () => {})
  proc.stderr?.on('data', () => {})
  proc.on('exit', () => previews.delete(projectId))
  previews.set(projectId, { port, proc, settingsFingerprint })

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250))
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) })
      if (res.status < 500) return port
    } catch {
      /* not ready yet */
    }
  }
  stopPreview(projectId)
  throw new Error('preview gagal start (port timeout)')
}

export function stopPreview(projectId: string) {
  const p = previews.get(projectId)
  if (p) {
    p.proc.kill('SIGTERM')
    previews.delete(projectId)
  }
}

export function runningPreviews() {
  return [...previews.entries()].map(([id, v]) => ({ projectId: id, port: v.port }))
}

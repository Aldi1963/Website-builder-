import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { PROJECTS_DIR } from './paths.ts'

const WHITELIST = new Set(['npm', 'node', 'npx', 'git', 'curl', 'ls', 'cat', 'pwd', 'echo', 'test', 'grep', 'head', 'tail'])

export type RunResult = { ok: boolean; code: number; output: string; command: string }

export async function runProjectCommand(projectId: string, args: Record<string, unknown>): Promise<RunResult> {
  const argv = Array.isArray(args.argv) ? args.argv.filter((x): x is string => typeof x === 'string') : []
  const cmd = String(args.command ?? '').trim()
  const parts = cmd ? cmd.split(/\s+/) : argv
  if (!parts.length || !WHITELIST.has(parts[0])) {
    return { ok: false, code: -1, output: `ERROR: perintah tidak diizinkan. Whitelist: ${[...WHITELIST].join(', ')}`, command: cmd || argv.join(' ') }
  }
  const cwd = join(PROJECTS_DIR, projectId)
  return new Promise((resolve) => {
    const child = spawn(parts[0], parts.slice(1), { cwd, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const push = (b: Buffer) => { if (out.length < 20_000) out += b.toString('utf8') }
    child.stdout.on('data', push)
    child.stderr.on('data', push)
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, code: code ?? -1, output: out.slice(-12_000), command: parts.join(' ') })
    })
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, code: -1, output: String(e.message), command: parts.join(' ') }) })
  })
}

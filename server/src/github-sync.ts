/* Sinkronisasi proyek ke GitHub lewat REST Contents API.
   Token PAT (repo scope) disimpan sebagai setting `secret_GITHUB_TOKEN`,
   target repo sebagai `github_repo` (format "owner/repo").
   Tiap file proyek di-push via PUT /contents/{path} (create atau update). */
import { listFiles, getFile, getSetting } from './db.ts'

const GH_API = 'https://api.github.com'

export type SyncResult = {
  ok: boolean
  repo: string
  branch: string
  pushed: number
  skipped: number
  error?: string
  commitUrl?: string
}

/* Kumpulkan daftar path yang diabaikan saat sinkron (build artifact, dependency). */
const SYNC_IGNORE = (p: string): boolean =>
  p.startsWith('node_modules/') ||
  p.startsWith('.vibe/') ||
  p.startsWith('dist/') ||
  p.startsWith('build/') ||
  p.endsWith('.log')

async function ghFetch(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${GH_API}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'WebBuilder-Sync',
      ...(init.headers ?? {}),
    },
  })
  return res
}

/* Pastikan repo ada; buat bila belum (private). */
async function ensureRepo(token: string, repo: string): Promise<{ ok: boolean; error?: string }> {
  const [owner, name] = repo.split('/')
  const got = await ghFetch(token, `/repos/${owner}/${name}`)
  if (got.status === 200) return { ok: true }
  if (got.status !== 404) return { ok: false, error: `GitHub /repos ${got.status}` }
  const made = await ghFetch(token, `/user/repos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, private: true, auto_init: true, description: 'Dibuat oleh WebBuilder' }),
  })
  if (!made.ok && made.status !== 422) {
    return { ok: false, error: `Gagal membuat repo: ${made.status}` }
  }
  return { ok: true }
}

async function getBranchHead(token: string, repo: string, branch: string): Promise<string | null> {
  const res = await ghFetch(token, `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`)
  if (!res.ok) return null
  const j = (await res.json()) as { object?: { sha?: string } }
  return j.object?.sha ?? null
}

export async function syncToGitHub(
  projectId: string,
  opts: { repo?: string; branch?: string; message?: string } = {},
): Promise<SyncResult> {
  const repo = (opts.repo ?? getSetting(projectId, 'github_repo') ?? '').trim()
  const branch = (opts.branch ?? getSetting(projectId, 'github_branch') ?? 'main').trim() || 'main'
  const token = getSetting(projectId, 'secret_GITHUB_TOKEN') ?? ''
  if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    return { ok: false, repo, branch, pushed: 0, skipped: 0, error: 'Repo tidak valid (format owner/repo).' }
  }
  if (!token) return { ok: false, repo, branch, pushed: 0, skipped: 0, error: 'Token GitHub belum diatur.' }

  const ensured = await ensureRepo(token, repo)
  if (!ensured.ok) return { ok: false, repo, branch, pushed: 0, skipped: 0, error: ensured.error }

  const head = await getBranchHead(token, repo, branch)

  const all = listFiles(projectId)
  let pushed = 0
  let skipped = 0
  let lastCommitUrl: string | undefined

  for (const f of all) {
    if (SYNC_IGNORE(f.path)) {
      skipped++
      continue
    }
    const content = getFile(projectId, f.path)
    if (content === undefined) {
      skipped++
      continue
    }
    /* SHA file lama diperlukan untuk update (bukan create). */
    let existingSha: string | undefined
    const cur = await ghFetch(token, `/repos/${repo}/contents/${encodeURIComponent(f.path)}?ref=${encodeURIComponent(branch)}`)
    if (cur.status === 200) {
      const j = (await cur.json()) as { sha?: string }
      existingSha = j.sha
    } else if (cur.status !== 404) {
      skipped++
      continue
    }
    const put = await ghFetch(token, `/repos/${repo}/contents/${encodeURIComponent(f.path)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: opts.message ?? `sync: ${f.path}`,
        content: Buffer.from(content, 'utf8').toString('base64'),
        branch,
        ...(existingSha ? { sha: existingSha } : {}),
      }),
    })
    if (put.ok) {
      pushed++
      const j = (await put.json()) as { commit?: { html_url?: string } }
      if (j.commit?.html_url) lastCommitUrl = j.commit.html_url
    } else {
      skipped++
    }
  }

  return { ok: true, repo, branch, pushed, skipped, commitUrl: lastCommitUrl }
}

/* Simpan konfigurasi GitHub untuk proyek. */
export function saveGitHubConfig(projectId: string, repo: string, token: string, branch: string): void {
  if (repo) setSettingExternal(projectId, 'github_repo', repo)
  if (branch) setSettingExternal(projectId, 'github_branch', branch)
  if (token) setSettingExternal(projectId, 'secret_GITHUB_TOKEN', token)
}

import { setSetting as setSettingExternal } from './db.ts'

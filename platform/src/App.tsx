import { useEffect, useRef, useState } from 'react'
import { Button } from '@cloudflare/kumo/components/button'
import { Icon, Spinner, Wordmark } from './ui'
import { api, auth, ChatHandlers, chatStream, Project, exportProjectZip, type User } from './api'
import { AuthGate, UserBar } from './auth'
import { matchPath, navigate, usePath } from './router'
import { ChatPanel, CodePane, PreviewPane, SettingsSheet, type ChatAudit, type ChatPlan, type InlineEvent } from './panels'
import { useActivity } from './activity'
import { MODEL_AUTO, getPickerModels, isSelectionAvailable, modelIdForServer } from './models'
/* Fase 3 (UI credit): chip saldo + halaman Penggunaan. File ini milik Hermes
   (kotor, belum commit) — perubahan di bawah ini MINIMAL + aditif dan TIDAK
   di-commit oleh trek ini; komponennya sendiri ada di billing-ui.tsx. */
import { CreditChip, UsagePage, notifyBalanceChanged } from './billing-ui'
import { MarketplacePage } from './marketplace-ui'

/* Right-side session menu (Emergent-style): a single 3-dot button in the chat
   header that opens a small dropdown with the actions that used to clutter the
   header row. Setelan sengaja TIDAK ada di sini — buka lewat tombol setelan
   di kolom input chat (onOpenSettings di composer). */
function SessionMenu({
  onShowFiles,
  onShowDatabase,
  onRun,
  runLabel,
  running,
  onExport,
  canExport,
  onToggleTheme,
  dark,
  usage,
  onPublish,
  publishing,
  published,
  onUnpublish,
}: {
  onShowFiles: () => void
  onShowDatabase: () => void
  onRun: () => void
  runLabel: string
  running: boolean
  onExport: () => void
  canExport: boolean
  onToggleTheme: () => void
  dark: boolean
  usage: { requests: number; promptTokens: number; completionTokens: number } | null
  onPublish: () => void
  publishing: boolean
  published: boolean
  onUnpublish: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const item =
    'flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12.5px] text-body transition-colors hover:bg-surface disabled:opacity-50'

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Menu sesi"
        aria-expanded={open}
        className="flex h-9 w-9 items-center justify-center rounded-full border border-edge text-body transition-colors hover:border-quiet max-md:h-11 max-md:w-11"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="19" cy="12" r="1.8" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          className="vb-enter absolute right-0 top-[calc(100%+6px)] z-30 w-56 overflow-hidden rounded-xl border border-edge bg-ink shadow-lg"
        >
          {usage && (
            <div className="border-b border-edge px-3 py-2">
              <p className="text-[10.5px] uppercase tracking-wide text-quiet">Pemakaian LLM</p>
              <p className="mt-0.5 font-mono text-[11px] text-body">
                {usage.requests} req · {usage.promptTokens.toLocaleString('id-ID')} in · {usage.completionTokens.toLocaleString('id-ID')} out
              </p>
            </div>
          )}
          <button className={item} onClick={() => { setOpen(false); onShowFiles() }} role="menuitem">
            <Icon name="file" size={13} /> Lihat file
          </button>
          <button className={item} onClick={() => { setOpen(false); onShowDatabase() }} role="menuitem">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true"><ellipse cx="12" cy="5" rx="8" ry="3" stroke="currentColor" strokeWidth="1.7" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" stroke="currentColor" strokeWidth="1.7" /></svg> Lihat database
          </button>
          <button className={item} onClick={() => { setOpen(false); onRun() }} disabled={running} role="menuitem">
            <Icon name="run" size={13} /> {running ? 'Sedang build…' : runLabel}
          </button>
          {published ? (
            <button className={item} onClick={() => { setOpen(false); onUnpublish() }} role="menuitem">
              <Icon name="close" size={13} /> Tarik publikasi
            </button>
          ) : (
            <button className={item} onClick={() => { setOpen(false); onPublish() }} disabled={publishing || !canExport} role="menuitem">
              <Icon name="check" size={13} /> {publishing ? 'Menerbitkan…' : 'Terbitkan'}
            </button>
          )}
          <button className={item} onClick={() => { setOpen(false); onExport() }} disabled={!canExport} role="menuitem">
            <Icon name="download" size={13} /> Export ZIP
          </button>
          <button className={item} onClick={() => { setOpen(false); onToggleTheme() }} role="menuitem">
            <Icon name={dark ? 'sun' : 'moon'} size={13} /> {dark ? 'Mode terang' : 'Mode gelap'}
          </button>
        </div>
      )}
    </div>
  )
}

/* ---------- Penampil database aplikasi hasil generate ----------
   Client-side saja, tanpa endpoint baru: isi dibaca dari file proyek yang
   sudah ada di workspace (biasanya src/lib/db.server.ts) lewat
   GET /api/projects/:id/file yang sudah ada. Parser ini TIDAK memakai eval:
   CREATE TABLE diambil untuk skema, array seed (const ... = [{...}]) diambil
   untuk baris, lalu dipasangkan lewat INSERT INTO + loop .run(...) bila ada.
   Tabel tanpa seed yang terbaca menampilkan skemanya + catatan jujur — isi
   TIDAK pernah dikarang. Penampil juga menjelaskan bahwa data aplikasi
   tersimpan di file database proyek (kanonik: data/app.db) dan bertahan
   melewati restart preview maupun server. */

type DbTableView = {
  name: string
  columns: string[]
  rows: Record<string, string | number | boolean>[]
  note?: string
}

/* Pindai kurung berimbang dari posisi buka; hormati string ' " `. */
function scanBalanced(src: string, openIdx: number, openCh: string, closeCh: string): number {
  let depth = 0
  let quote: string | null = null
  let escaped = false
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i]
    if (quote) {
      if (escaped) { escaped = false; continue }
      if (ch === '\\') { escaped = true; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue }
    if (ch === openCh) depth++
    else if (ch === closeCh) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function splitTopLevel(s: string, sep: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote: string | null = null
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quote) {
      cur += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; cur += ch; continue }
    if (ch === '(' || ch === '[' || ch === '{') depth++
    if (ch === ')' || ch === ']' || ch === '}') depth--
    if (ch === sep && depth === 0) { parts.push(cur); cur = ''; continue }
    cur += ch
  }
  if (cur) parts.push(cur)
  return parts
}

type JsValue = string | number | boolean | null | JsValue[] | { [k: string]: JsValue }

/* Parser nilai literal JS secukupnya (string, angka, boolean, null, array,
   object) — cukup untuk array seed; template literal ${...} ditolak. */
function parseJsValue(src: string, i: number): { value: JsValue; next: number } | null {
  while (i < src.length && /\s/.test(src[i])) i++
  if (i >= src.length) return null
  const ch = src[i]
  if (ch === "'" || ch === '"' || ch === '`') {
    let out = ''
    i++
    while (i < src.length) {
      const c = src[i]
      if (ch === '`' && c === '$' && src[i + 1] === '{') return null
      if (c === '\\' && i + 1 < src.length) {
        const n = src[i + 1]
        out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n
        i += 2
        continue
      }
      if (c === ch) return { value: out, next: i + 1 }
      out += c
      i++
    }
    return null
  }
  if (ch === '[') {
    const arr: JsValue[] = []
    i++
    for (;;) {
      while (i < src.length && /\s/.test(src[i])) i++
      if (src[i] === ']') return { value: arr, next: i + 1 }
      const v = parseJsValue(src, i)
      if (!v) return null
      arr.push(v.value)
      i = v.next
      while (i < src.length && /\s/.test(src[i])) i++
      if (src[i] === ',') { i++; continue }
      if (src[i] === ']') return { value: arr, next: i + 1 }
      return null
    }
  }
  if (ch === '{') {
    const obj: Record<string, JsValue> = {}
    i++
    for (;;) {
      while (i < src.length && /\s/.test(src[i])) i++
      if (src[i] === '}') return { value: obj, next: i + 1 }
      let key = ''
      if (src[i] === "'" || src[i] === '"') {
        const k = parseJsValue(src, i)
        if (!k || typeof k.value !== 'string') return null
        key = k.value
        i = k.next
      } else {
        const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i))
        if (!m) return null
        key = m[0]
        i += m[0].length
      }
      while (i < src.length && /\s/.test(src[i])) i++
      if (src[i] !== ':') return null
      i++
      const v = parseJsValue(src, i)
      if (!v) return null
      obj[key] = v.value
      i = v.next
      while (i < src.length && /\s/.test(src[i])) i++
      if (src[i] === ',') { i++; continue }
      if (src[i] === '}') return { value: obj, next: i + 1 }
      return null
    }
  }
  const m = /^(true|false|null|-?\d+(?:\.\d+)?)/.exec(src.slice(i))
  if (m) {
    const t = m[1]
    return { value: t === 'true' ? true : t === 'false' ? false : t === 'null' ? null : Number(t), next: i + t.length }
  }
  return null
}

function extractTables(src: string): { name: string; columns: string[] }[] {
  const tables: { name: string; columns: string[] }[] = []
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([\w$]+)["'`]?\s*\(/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    const openIdx = src.indexOf('(', m.index)
    const closeIdx = scanBalanced(src, openIdx, '(', ')')
    if (closeIdx < 0) continue
    const inner = src.slice(openIdx + 1, closeIdx)
    const columns = splitTopLevel(inner, ',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((seg) => {
        const km = /^["'`]?([\w$]+)["'`]?/.exec(seg)
        return km ? km[1] : ''
      })
      .filter((name) => name && !/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT|KEY)$/i.test(name))
    tables.push({ name: m[1], columns })
  }
  return tables
}

function extractSeedArrays(src: string): { varName: string; items: Record<string, JsValue>[] }[] {
  const out: { varName: string; items: Record<string, JsValue>[] }[] = []
  const re = /const\s+([\w$]+)(?::\s*[^=]+?)?=\s*\[/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    /* Kurung buka array = '[' terakhir dari match (bukan '[' pertama sesudah
       'const' — anotasi tipe seperti Recipe[] juga mengandung '['). */
    const bracketIdx = m.index + m[0].lastIndexOf('[')
    const closeIdx = scanBalanced(src, bracketIdx, '[', ']')
    if (closeIdx < 0) continue
    const body = src.slice(bracketIdx + 1, closeIdx)
    const items: Record<string, JsValue>[] = []
    let ok = true
    let j = 0
    while (j < body.length) {
      const o = body.indexOf('{', j)
      if (o < 0) break
      const c = scanBalanced(body, o, '{', '}')
      if (c < 0) { ok = false; break }
      const v = parseJsValue(body, o)
      if (!v || typeof v.value !== 'object' || v.value === null || Array.isArray(v.value)) { ok = false; break }
      items.push(v.value as Record<string, JsValue>)
      j = c + 1
    }
    if (ok && items.length) out.push({ varName: m[1], items })
  }
  return out
}

const toSnake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
const normName = (s: string) => s.toLowerCase().replace(/_/g, '')

function parseAppDatabase(source: string): DbTableView[] {
  const tables = extractTables(source)
  if (!tables.length) return []
  const seeds = extractSeedArrays(source)

  /* INSERT INTO <tabel> [(kolom...)] VALUES ... + loop for..of <array>
     <stmt>.run(<item>.f1, JSON.stringify(<item>.f2), ...) — posisi argumen
     = posisi kolom. */
  const inserts: { table: string; columns: string[] | null; varName: string }[] = []
  const insRe = /const\s+([\w$]+)\s*=\s*[\w$.]+\.prepare\(\s*['"]INSERT\s+INTO\s+["'`]?([\w$]+)["'`]?\s*(?:\(([^)]*)\))?\s*VALUES/gi
  let im: RegExpExecArray | null
  while ((im = insRe.exec(source)) !== null) {
    inserts.push({
      varName: im[1],
      table: im[2],
      columns: im[3] ? im[3].split(',').map((c) => c.trim().replace(/["'`]/g, '')).filter(Boolean) : null,
    })
  }
  const runs: { arrayVar: string; stmtVar: string; fields: string[] }[] = []
  const runRe = /for\s*\(\s*const\s+([\w$]+)\s+of\s+([\w$]+)\s*\)\s*([\w$]+)\.run\(/g
  let rm: RegExpExecArray | null
  while ((rm = runRe.exec(source)) !== null) {
    const openIdx = source.indexOf('(', rm.index + rm[0].length - 1)
    const closeIdx = scanBalanced(source, openIdx, '(', ')')
    if (closeIdx < 0) continue
    const args = splitTopLevel(source.slice(openIdx + 1, closeIdx), ',')
      .map((a) => {
        /* Ambil pasangan kata.field TERAKHIR: 'recipe.id' -> 'id', tapi
           'JSON.stringify(recipe.ingredients)' -> 'ingredients' (bukan
           'stringify'). */
        const all = [...a.trim().matchAll(/[\w$]+\.([\w$]+)/g)]
        return all.length ? all[all.length - 1][1] : ''
      })
    runs.push({ arrayVar: rm[2], stmtVar: rm[3], fields: args })
  }

  const displayValue = (v: JsValue): string | number => {
    if (Array.isArray(v)) return v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ')
    if (v === null) return ''
    if (typeof v === 'object') return JSON.stringify(v)
    if (typeof v === 'boolean') return v ? 'true' : 'false'
    return v
  }

  return tables.map((t) => {
    const columns = t.columns
    let rows: Record<string, string | number>[] = []
    /* Jalur 1: INSERT + for..of — pemetaan posisi paling setia. */
    const ins = inserts.find((x) => normName(x.table) === normName(t.name))
    const run = ins ? runs.find((r) => r.stmtVar === ins.varName) : undefined
    const seed = run ? seeds.find((s) => s.varName === run.arrayVar) : undefined
    if (ins && run && seed && run.fields.length) {
      const cols = ins.columns ?? columns
      rows = seed.items.map((item) => {
        const row: Record<string, string | number> = {}
        cols.forEach((col, i) => {
          const field = run.fields[i]
          row[col] = field && field in item ? displayValue(item[field]) : ''
        })
        return row
      })
    } else {
      /* Jalur 2: nama array seed sama dengan nama tabel — petakan kunci
         camelCase ke kolom snake_case. */
      const byName = seeds.find((s) => normName(s.varName) === normName(t.name))
      if (byName) {
        rows = byName.items.map((item) => {
          const row: Record<string, string | number> = {}
          columns.forEach((col) => {
            const key = Object.keys(item).find((k) => toSnake(k) === col || normName(k) === normName(col))
            row[col] = key ? displayValue(item[key]) : ''
          })
          return row
        })
      }
    }
    return {
      name: t.name,
      columns,
      rows,
      note: rows.length
        ? undefined
        : 'Tidak ada baris seed yang bisa dibaca dari file proyek. Baris tabel ini hanya terbentuk dari input pengguna di preview (tersimpan di file database proyek, kanonik data/app.db) — jadi isinya tidak bisa ditampilkan di sini, dan tabel ini bukan berarti kosong.',
    }
  })
}

function DatabaseViewer({
  open,
  onClose,
  projectId,
  files,
}: {
  open: boolean
  onClose: () => void
  projectId: string
  files: { path: string }[]
}) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [tables, setTables] = useState<DbTableView[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    let alive = true
    setStatus('loading')
    setError('')
    setTables([])
    const load = async () => {
      try {
        const r = await api.database(projectId)
        if (!alive) return
        if (r.error) {
          setError(r.error)
          setStatus('error')
          return
        }
        if (!r.tables.length) {
          setError('Belum ada tabel di database proyek ini. Minta agent membuat tabel lewat chat.')
          setStatus('error')
          return
        }
        setTables(r.tables)
        setStatus('ready')
      } catch (e) {
        if (!alive) return
        setError((e as Error).message || 'Gagal memuat database.')
        setStatus('error')
      }
    }
    void load()
    return () => {
      alive = false
    }
  }, [open, projectId])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/55 p-3" onClick={onClose} role="dialog" aria-label="Database aplikasi">
      <div
        onClick={(e) => e.stopPropagation()}
        className="vb-enter flex max-h-[86dvh] w-full max-w-[720px] flex-col border border-edge bg-surface px-4 pb-5 pt-4 max-md:px-3"
      >
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-display text-[16px] text-body">Database aplikasi</h2>
          <button onClick={onClose} aria-label="Tutup database" className="flex h-8 w-8 items-center justify-center text-quiet hover:text-body">
            <Icon name="close" size={14} />
          </button>
        </div>
        <p className="mb-3 border-l-2 border-accent pl-2 text-[12px] leading-relaxed text-body">
          Database aplikasi ini Postgres terkelola, dibuat otomatis per proyek — data yang dimasukkan
          lewat preview tersimpan di sana dan bertahan melewati restart preview maupun server. Isi di
          bawah dibaca langsung dari database yang sedang berjalan (skema + contoh data).
        </p>
        <div className="vb-scroll min-h-0 flex-1 overflow-y-auto">
          {status === 'loading' && <p className="text-[12px] text-quiet">Membaca database…</p>}
          {status === 'error' && <p className="border-l-2 border-accent pl-2 text-[12px] text-body">{error}</p>}
          {status === 'ready' &&
            tables.map((t) => (
              <section key={t.name} className="mb-4">
                <p className="text-[12.5px] font-medium text-body">
                  {t.name}{' '}
                  <span className="font-normal text-quiet">
                    · {t.note ?? `${t.columns.length} kolom · ${t.rows.length} baris`}
                  </span>
                </p>
                {t.rows.length > 0 ? (
                  <div className="vb-scroll mt-2 overflow-x-auto">
                    <table className="w-full border-collapse text-[12px]">
                      <thead>
                        <tr>
                          {t.columns.map((c) => (
                            <th key={c} className="whitespace-nowrap border border-edge bg-ink px-2 py-1.5 text-left font-medium text-body">
                              {c}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {t.rows.map((row, i) => (
                          <tr key={i}>
                            {t.columns.map((c) => (
                              <td key={c} className="max-w-[260px] break-words border border-edge px-2 py-1.5 align-top text-body">
                                {row[c] ?? ''}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="mt-2">
                    <div className="flex flex-wrap gap-1.5">
                      {t.columns.map((c) => (
                        <span key={c} className="border border-edge bg-ink px-2 py-1 font-mono text-[11px] text-body">
                          {c}
                        </span>
                      ))}
                    </div>
                    {t.note && <p className="mt-2 text-[11.5px] leading-relaxed text-quiet">{t.note}</p>}
                  </div>
                )}
              </section>
            ))}
        </div>
      </div>
    </div>
  )
}

/* Theme is a real choice here: the shell is used for long sessions next to an
   arbitrary generated app, so both modes ship and both are verified. */
/* Light is the product default. The stored key is versioned so a stale
   'dark' saved by older builds (which followed the OS preference) can't
   keep a light-mode phone stuck in dark mode. */
const THEME_KEY = 'vb-theme-v2'

/* Tampilan workspace (Chat / Code + file yang dibuka) dipertahankan per
   proyek. Tanpa ini, tombol "daftar proyek" terasa memisah halaman karena
   Workspace di-mount ulang (key=activeId) dan selalu mulai di Chat. */
const VIEW_KEY = (id: string) => `vb-view-${id}`
type SavedView = { tab: 'chat' | 'code'; file: string | null }
function loadView(id: string): SavedView {
  try {
    const raw = localStorage.getItem(VIEW_KEY(id))
    if (raw) {
      const v = JSON.parse(raw) as SavedView
      if (v.tab === 'chat' || v.tab === 'code') return { tab: v.tab, file: typeof v.file === 'string' ? v.file : null }
    }
  } catch { /* abaikan data rusak */ }
  return { tab: 'chat', file: null }
}
function saveView(id: string, view: SavedView) {
  try { localStorage.setItem(VIEW_KEY(id), JSON.stringify(view)) } catch { /* abaikan */ }
}

function useTheme() {
  const [dark, setDark] = useState(() => localStorage.getItem(THEME_KEY) === 'dark')

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    localStorage.removeItem('vb-theme')
    localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light')
  }, [dark])

  return { dark, toggle: () => setDark((d) => !d) }
}

const PUBLIC_ORIGIN = import.meta.env.VITE_PUBLIC_ORIGIN ?? 'https://vibe.clipku.com'

function publicUrl(slug: string) {
  const u = new URL(PUBLIC_ORIGIN)
  return `${u.protocol}//${slug}.${u.host}/`
}

function publicLabel(url: string | null, slug: string) {
  if (!url) return `/p/${slug}`
  try {
    return new URL(url).host
  } catch {
    return `/p/${slug}`
  }
}

export default function App() {
  const path = usePath()
  const [user, setUser] = useState<User | null>(null)
  const [sessionChecked, setSessionChecked] = useState(false)
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [navOpen, setNavOpen] = useState(false)
  const { dark, toggle } = useTheme()

  // Routing: '/' home, '/proyek/:id' workspace, '/profil' account page,
  // '/penggunaan' credit usage page (fase 3).
  const projectRoute = matchPath('/proyek/:id', path)
  const profileRoute = matchPath('/profil', path)
  const usageRoute = matchPath('/penggunaan', path)
  const marketRoute = matchPath('/marketplace', path)
  const activeId = projectRoute?.id ?? null

  useEffect(() => {
    if (projectRoute && !projects.some((p) => p.id === activeId) && projects.length) {
      navigate('/', { replace: true })
    }
  }, [path, projects])

  const refresh = async () => {
    try {
      const { projects } = await api.listProjects()
      setProjects(projects)
      setLoadError('')
    } catch (err) {
      setLoadError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    auth
      .me()
      .then((r) => setUser(r.user))
      .catch(() => setUser(null))
      .finally(() => setSessionChecked(true))
  }, [])

  useEffect(() => {
    if (!user) return
    void refresh()
    const t = setInterval(() => void refresh(), 8000)
    return () => clearInterval(t)
  }, [user])

  const logout = async () => {
    await auth.logout().catch(() => {})
    setUser(null)
    setProjects([])
    navigate('/', { replace: true })
  }

  const createProject = async () => {
    const { project } = await api.createProject('Proyek tanpa nama')
    setProjects((p) => [project, ...p])
    navigate(`/proyek/${project.id}`)
  }

  const removeProject = async (id: string) => {
    await api.deleteProject(id)
    setProjects((p) => p.filter((x) => x.id !== id))
    if (activeId === id) navigate('/', { replace: true })
  }

  if (!sessionChecked) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-ink">
        <Spinner />
      </div>
    )
  }

  if (!user) return <AuthGate onUser={setUser} />

  const onSelect = (id: string) => {
    navigate(`/proyek/${id}`)
    setNavOpen(false)
  }

  if (projectRoute && activeId) {
    return (
      <div className="flex h-dvh overflow-hidden bg-ink text-body">
        <Sidebar
          user={user}
          onLogout={logout}
          projects={projects}
          activeId={activeId}
          loading={loading}
          loadError={loadError}
          dark={dark}
          onToggleTheme={toggle}
          onSelect={onSelect}
          onCreate={createProject}
          onDelete={removeProject}
          open={navOpen}
          onClose={() => setNavOpen(false)}
        />
        <Workspace
          key={activeId}
          projectId={activeId}
          onMenu={() => setNavOpen(true)}
          onTitle={(name) => setProjects((p) => p.map((x) => (x.id === activeId ? { ...x, name } : x)))}
        />
      </div>
    )
  }

  if (profileRoute) {
    return (
      <ProfilePage
        user={user}
        projects={projects}
        dark={dark}
        onToggleTheme={toggle}
        onLogout={logout}
        onCreate={createProject}
        onSelect={onSelect}
        onMenu={() => setNavOpen(true)}
        navOpen={navOpen}
        onCloseNav={() => setNavOpen(false)}
      />
    )
  }

  /* Fase 3: halaman Penggunaan pengguna (/penggunaan). */
  if (usageRoute) {
    return (
      <div className="flex h-dvh overflow-hidden bg-ink text-body">
        <Sidebar
          user={user}
          onLogout={logout}
          projects={projects}
          activeId={null}
          loading={loading}
          loadError={loadError}
          dark={dark}
          onToggleTheme={toggle}
          onSelect={onSelect}
          onCreate={createProject}
          onDelete={removeProject}
          open={navOpen}
          onClose={() => setNavOpen(false)}
        />
        <UsagePage
          user={user}
          dark={dark}
          onToggleTheme={toggle}
          onLogout={logout}
          onMenu={() => setNavOpen(true)}
          navOpen={navOpen}
          onCloseNav={() => setNavOpen(false)}
        />
      </div>
    )
  }

  /* Fase 3: galeri marketplace (/marketplace) — publik, tanpa perlu login. */
  if (marketRoute) {
    return (
      <MarketplacePage
        user={user}
        onCreate={async () => {
          if (!user) {
            navigate('/')
            return
          }
          await createProject()
        }}
      />
    )
  }

  return (
    <div className="flex h-dvh overflow-hidden bg-ink text-body">
      <Sidebar
        user={user}
        onLogout={logout}
        projects={projects}
        activeId={null}
        loading={loading}
        loadError={loadError}
        dark={dark}
        onToggleTheme={toggle}
        onSelect={onSelect}
        onCreate={createProject}
        onDelete={removeProject}
        open={navOpen}
        onClose={() => setNavOpen(false)}
      />
      <HomePage
        projects={projects}
        loading={loading}
        onCreate={createProject}
        onSelect={onSelect}
        user={user}
        dark={dark}
        onToggleTheme={toggle}
        onLogout={logout}
        onMenu={() => setNavOpen(true)}
        navOpen={navOpen}
        onCloseNav={() => setNavOpen(false)}
      />
    </div>
  )
}

/* Home: overview of all projects with quick actions. */
function HomePage({
  projects,
  loading,
  onCreate,
  onSelect,
  user,
  dark,
  onToggleTheme,
  onLogout,
  onMenu,
  navOpen,
  onCloseNav,
}: {
  projects: Project[]
  loading: boolean
  onCreate: () => void
  onSelect: (id: string) => void
  user: User
  dark: boolean
  onToggleTheme: () => void
  onLogout: () => void
  onMenu: () => void
  navOpen: boolean
  onCloseNav: () => void
}) {
  const working = projects.filter((p) => p.status === 'working').length
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-edge bg-ink px-3">
        <button
          onClick={onMenu}
          aria-label="Buka menu"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-edge text-body hover:bg-surface max-md:h-11 max-md:w-11"
        >
          <Icon name="back" size={15} />
        </button>
        <h1 className="text-[13px] font-medium text-body">Beranda</h1>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={onToggleTheme}
            aria-label={dark ? 'Mode terang' : 'Mode gelap'}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-edge text-quiet hover:text-body"
          >
            <Icon name={dark ? 'sun' : 'moon'} size={13} />
          </button>
          <button
            onClick={onLogout}
            className="flex h-8 items-center rounded-full border border-edge px-3 text-[11.5px] text-quiet hover:text-body"
          >
            Keluar
          </button>
        </div>
      </header>
      <div className="flex-1 overflow-y-auto px-5 py-8 max-md:px-4 max-md:py-6">
        <div className="mx-auto max-w-3xl">
          <p className="text-[11.5px] uppercase tracking-wide text-quiet">Halo, {user.name || user.email}</p>
          <h2 className="mt-1 font-display text-[26px] leading-tight text-body max-md:text-[22px]">
            Ruang kerja untuk membangun aplikasi
          </h2>
          <div className="mt-5 flex flex-wrap gap-2">
            <button
              onClick={onCreate}
              className="flex h-9 max-md:h-11 items-center gap-2 bg-accent px-3 text-[12.5px] font-medium text-ink transition-opacity hover:opacity-90"
            >
              <Icon name="plus" size={12} />
              Proyek baru
            </button>
            <a
              href="/profil"
              className="flex h-9 max-md:h-11 items-center border border-edge px-3 text-[12.5px] text-body hover:bg-surface"
            >
              Profil akun
            </a>
            <a
              href="/marketplace"
              className="flex h-9 max-md:h-11 items-center border border-edge px-3 text-[12.5px] text-body hover:bg-surface"
            >
              Marketplace
            </a>
          </div>

          <div className="mt-8 grid grid-cols-3 gap-3 max-sm:grid-cols-1">
            <StatCard label="Total proyek" value={String(projects.length)} />
            <StatCard label="Sedang jalan" value={String(working)} />
            <StatCard label="Selesai" value={String(projects.filter((p) => p.status === 'idle').length)} />
          </div>

          <h3 className="mt-9 text-[12.5px] font-medium text-body">Proyek kamu</h3>
          {loading ? (
            <p className="mt-3 text-[12.5px] text-quiet">Memuat…</p>
          ) : !projects.length ? (
            <p className="mt-3 text-[12.5px] leading-relaxed text-quiet">
              Belum ada proyek. Tekan Proyek baru untuk memulai yang pertama.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-edge border border-edge bg-surface">
              {projects.map((p) => (
                <li key={p.id}>
                  <button
                    onClick={() => onSelect(p.id)}
                    className="flex min-h-[52px] w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-ink"
                  >
                    <StatusMark status={p.status} />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-body">{p.name}</span>
                    <span className="shrink-0 text-[11px] text-quiet">{p.status}</span>
                    <Icon name="back" size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <MobileNavOverlay open={navOpen} onClose={onCloseNav} />
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-edge bg-surface px-4 py-3">
      <p className="text-[10.5px] uppercase tracking-wide text-quiet">{label}</p>
      <p className="mt-1 font-display text-[22px] text-body">{value}</p>
    </div>
  )
}

function MobileNavOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div
      onClick={onClose}
      aria-hidden="true"
      className="fixed inset-0 z-20 bg-black/55 md:hidden"
    />
  )
}

/* Account profile page at /profil. */
function ProfilePage({
  user,
  projects,
  dark,
  onToggleTheme,
  onLogout,
  onCreate,
  onSelect,
  onMenu,
  navOpen,
  onCloseNav,
}: {
  user: User
  projects: Project[]
  dark: boolean
  onToggleTheme: () => void
  onLogout: () => void
  onCreate: () => void
  onSelect: (id: string) => void
  onMenu: () => void
  navOpen: boolean
  onCloseNav: () => void
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-edge bg-ink px-3">
        <button
          onClick={onMenu}
          aria-label="Buka menu"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-edge text-body hover:bg-surface max-md:h-11 max-md:w-11"
        >
          <Icon name="back" size={15} />
        </button>
        <h1 className="text-[13px] font-medium text-body">Profil</h1>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={onToggleTheme}
            aria-label={dark ? 'Mode terang' : 'Mode gelap'}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-edge text-quiet hover:text-body"
          >
            <Icon name={dark ? 'sun' : 'moon'} size={13} />
          </button>
          <button
            onClick={onLogout}
            className="flex h-8 items-center rounded-full border border-edge px-3 text-[11.5px] text-quiet hover:text-body"
          >
            Keluar
          </button>
        </div>
      </header>
      <div className="flex-1 overflow-y-auto px-5 py-8 max-md:px-4 max-md:py-6">
        <div className="mx-auto max-w-2xl">
          <div className="border border-edge bg-surface px-4 py-4">
            <p className="text-[10.5px] uppercase tracking-wide text-quiet">Akun</p>
            <p className="mt-1 text-[15px] font-medium text-body">{user.name || 'Tanpa nama'}</p>
            <p className="text-[12.5px] text-quiet">{user.email}</p>
            <button
              onClick={onLogout}
              className="mt-4 flex h-8 items-center border border-edge px-3 text-[11.5px] text-body hover:bg-ink"
            >
              Keluar dari akun
            </button>
          </div>

          <div className="mt-6 border border-edge bg-surface px-4 py-4">
            <p className="text-[10.5px] uppercase tracking-wide text-quiet">Tema</p>
            <button
              onClick={onToggleTheme}
              className="mt-2 flex h-8 items-center gap-2 border border-edge px-3 text-[12px] text-body hover:bg-ink"
            >
              <Icon name={dark ? 'sun' : 'moon'} size={12} />
              {dark ? 'Aktifkan mode terang' : 'Aktifkan mode gelap'}
            </button>
          </div>

          <div className="mt-6">
            <div className="flex items-center justify-between">
              <p className="text-[10.5px] uppercase tracking-wide text-quiet">Proyek ({projects.length})</p>
              <button onClick={onCreate} className="flex h-7 items-center gap-1 text-[11.5px] text-accent">
                <Icon name="plus" size={11} />
                Baru
              </button>
            </div>
            {!projects.length ? (
              <p className="mt-3 text-[12.5px] text-quiet">Belum ada proyek.</p>
            ) : (
              <ul className="mt-3 divide-y divide-edge border border-edge bg-surface">
                {projects.map((p) => (
                  <li key={p.id}>
                    <button
                      onClick={() => onSelect(p.id)}
                      className="flex min-h-[48px] w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-ink"
                    >
                      <StatusMark status={p.status} />
                      <span className="min-w-0 flex-1 truncate text-[12.5px] text-body">{p.name}</span>
                      <span className="shrink-0 text-[11px] text-quiet">{p.status}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <a
            href="/"
            className="mt-8 inline-flex h-8 items-center text-[12px] text-quiet hover:text-body"
          >
            ← Kembali ke beranda
          </a>
        </div>
      </div>
      <MobileNavOverlay open={navOpen} onClose={onCloseNav} />
    </div>
  )
}

function Sidebar({
  user,
  onLogout,
  projects,
  activeId,
  loading,
  loadError,
  dark,
  onToggleTheme,
  onSelect,
  onCreate,
  onDelete,
  open,
  onClose,
}: {
  user: User
  onLogout: () => void
  projects: Project[]
  activeId: string | null
  loading: boolean
  loadError: string
  dark: boolean
  onToggleTheme: () => void
  onSelect: (id: string) => void
  onCreate: () => void
  onDelete: (id: string) => void
  open: boolean
  onClose: () => void
}) {
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    closeRef.current?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <>
      {open && (
        <div
          onClick={onClose}
          aria-hidden="true"
          className="fixed inset-0 z-20 bg-black/55 md:hidden"
        />
      )}

      <aside
        id="vb-nav"
        aria-label="Daftar proyek"
        className={`z-30 flex w-[252px] shrink-0 flex-col border-r border-edge bg-surface max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:w-[86vw] max-md:transition-transform ${
          open ? 'max-md:translate-x-0' : 'max-md:-translate-x-full'
        }`}
      >
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-edge px-3">
          <Wordmark />
          <button
            ref={closeRef}
            onClick={onClose}
            className="flex h-11 w-11 items-center justify-center text-quiet md:hidden"
          >
            <Icon name="close" size={15} title="Tutup daftar proyek" />
          </button>
          <button
            onClick={onToggleTheme}
            aria-label={dark ? 'Ganti ke tema terang' : 'Ganti ke tema gelap'}
            className="flex h-8 w-8 items-center justify-center text-quiet transition-colors hover:text-body max-md:hidden"
          >
            <Icon name={dark ? 'sun' : 'moon'} size={13} />
          </button>
        </div>

        <div className="px-3 py-3">
          <button
            onClick={onCreate}
            className="flex h-8 max-md:h-11 w-full items-center justify-center gap-1.5 bg-accent text-[12px] font-medium text-ink transition-opacity hover:opacity-90"
          >
            <Icon name="plus" size={11} />
            Proyek baru
          </button>
        </div>

        <div className="vb-seam flex-1 overflow-y-auto">
          <p className="px-3 pb-1 pt-2.5 text-[11px] text-quiet">
            {projects.length ? `${projects.length} proyek` : 'proyek'}
          </p>

          {loading && (
            <div className="flex items-center gap-2 px-3 py-3 text-[11.5px] text-quiet">
              <Spinner />
              Memuat daftar proyek
            </div>
          )}

          {!loading && loadError && (
            <div className="mx-3 my-2 border-l-2 border-accent py-1 pl-2">
              <p className="text-[11.5px] leading-relaxed text-body">
                Server tidak menjawab. Cek proses di port 3000.
              </p>
              <p className="mt-1 break-words font-mono text-[10.5px] text-quiet">{loadError}</p>
            </div>
          )}

          {!loading && !loadError && !projects.length && (
            <p className="px-3 py-3 text-[11.5px] leading-relaxed text-quiet">
              Belum ada proyek. Tekan Proyek baru untuk memulai yang pertama.
            </p>
          )}

          {projects.map((p) => (
            <div
              key={p.id}
              className={`group flex items-center ${
                activeId === p.id ? 'border-l-2 border-l-accent bg-ink' : 'border-l-2 border-l-transparent'
              }`}
            >
              <button
                onClick={() => onSelect(p.id)}
                aria-current={activeId === p.id ? 'true' : undefined}
                className="flex min-h-[34px] max-md:min-h-[44px] flex-1 items-center gap-2 px-2.5 py-1 text-left"
              >
                <StatusMark status={p.status} />
                <span className="truncate text-[12.5px] text-body">{p.name}</span>
              </button>
              <button
                onClick={() => {
                  if (confirm(`Hapus "${p.name}" beserta seluruh filenya?`)) void onDelete(p.id)
                }}
                aria-label={`Hapus ${p.name}`}
                className="mr-1 flex h-7 w-7 items-center justify-center text-quiet opacity-0 transition-opacity hover:text-body group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100"
              >
                <Icon name="trash" size={11} />
              </button>
            </div>
          ))}
        </div>

        <UserBar user={user} onLogout={onLogout} />

        <div className="border-t border-edge px-3 py-2">
          <p className="text-[10.5px] leading-relaxed text-quiet">
            TanStack Start, React 19, Tailwind v4
          </p>
        </div>
      </aside>
    </>
  )
}

/* Square, not a pill and not a glow: the mark reports the project's real run
   state and nothing else, so shape carries it as much as color. */
function StatusMark({ status }: { status: string }) {
  const color =
    status === 'working'
      ? 'bg-accent'
      : status === 'building'
        ? 'bg-body'
        : status === 'error'
          ? 'bg-accent'
          : 'bg-edge'
  return <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 ${color}`} />
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center px-6">
      <div className="max-w-[44ch]">
        <h1 className="font-display text-[26px] leading-tight text-body">
          Satu ruang kerja untuk menulis dan menjalankan aplikasi
        </h1>
        <p className="mt-3 text-[13px] leading-relaxed text-quiet">
          Setiap proyek punya workspace sendiri: file ditulis agent, di-build dengan Vite,
          lalu disajikan di port lokal supaya bisa dicoba langsung.
        </p>
        <button
          onClick={onCreate}
          className="mt-6 flex h-9 max-md:h-11 items-center gap-2 bg-accent px-3 text-[12.5px] font-medium text-ink transition-opacity hover:opacity-90"
        >
          <Icon name="plus" size={12} />
          Buat proyek pertama
        </button>
      </div>
    </div>
  )
}

type Tab = 'chat' | 'code'

function Workspace({ projectId, onTitle, onMenu }: { projectId: string; onTitle: (n: string) => void; onMenu: () => void }) {
  const { dark, toggle } = useTheme()
  const [tab, setTab] = useState<Tab>(() => loadView(projectId).tab)
  const [dbOpen, setDbOpen] = useState(false)
  const [messages, setMessages] = useState<{ role: string; content: string; id?: number }[]>([])
  const [pendingDiscovery, setPendingDiscovery] = useState<string | null>(null)
  const [streamText, setStreamText] = useState('')
  const [changedFiles, setChangedFiles] = useState<string[]>([])
  const [files, setFiles] = useState<{ path: string }[]>([])
  const [previewPort, setPreviewPort] = useState<number>(0)
  const [previewOn, setPreviewOn] = useState(false)
  const [inlineEvents, setInlineEvents] = useState<InlineEvent[]>([])
  const [booting, setBooting] = useState(false)
  const [status, setStatus] = useState('')
  const [plan, setPlan] = useState<ChatPlan | null>(null)
  const [audit, setAudit] = useState<ChatAudit | null>(null)
  const [buildLog, setBuildLog] = useState<{ ok: boolean; log: string } | null>(null)
  const [openFile, setOpenFile] = useState<string | null>(() => loadView(projectId).file)
  const [fileContent, setFileContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [name, setName] = useState('')
  const [sending, setSending] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [slug, setSlug] = useState<string | null>(null)
  const [publishing, setPublishing] = useState(false)
  const [publishMsg, setPublishMsg] = useState('')
  const [pubUrl, setPubUrl] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [usage, setUsage] = useState<{ requests: number; promptTokens: number; completionTokens: number } | null>(null)
  const [model, setModel] = useState(() => localStorage.getItem('vb-model') ?? 'auto')
  const [modelNotice, setModelNotice] = useState('')

  /* Validasi pilihan tersimpan saat builder dibuka: bila model sudah tidak
     aktif lagi (dimatikan admin), fallback ke 'auto' + pesan jelas — jangan
     kirim model mati ke server. SettingsSheet mengulang validasi ini tiap
     dibuka (daftar segar); di sini cukup sekali saat mount. */
  useEffect(() => {
    let alive = true
    getPickerModels()
      .then(({ options, fromFallback }) => {
        if (!alive || fromFallback) return
        setModel((cur) => {
          if (isSelectionAvailable(cur, options)) return cur
          localStorage.setItem('vb-model', MODEL_AUTO)
          setModelNotice(`Model tersimpan (${cur}) sudah tidak aktif — kembali ke Auto.`)
          window.setTimeout(() => alive && setModelNotice(''), 15000)
          return MODEL_AUTO
        })
      })
      .catch(() => { /* fallback: biarkan pilihan apa adanya */ })
    return () => {
      alive = false
    }
  }, [])
  const [planMode, setPlanMode] = useState(false)
  const [pendingPlan, setPendingPlan] = useState<{ prompt: string } | null>(null)
  const [awaitingConfirm, setAwaitingConfirm] = useState(false)
  const { entries: activity, push: pushActivity, reset: resetActivity } = useActivity()
  const abortRef = useRef<AbortController | null>(null)

  const load = async () => {
    const d = await api.getProject(projectId)
    setMessages(d.messages.map((m) => ({ role: m.role, content: m.content, id: m.id })))
    setFiles(d.files.map((f) => ({ path: f.path })))
    setName(d.project.name)
    setPreviewPort(d.previewPort)
    setSlug(d.project.slug ?? null)
    setPubUrl(d.project.slug ? publicUrl(d.project.slug) : null)
    // Rencana yang menunggu persetujuan: tampilkan lagi kartunya bila user
    // kembali sesudah keluar (disimpan server saat gerbang konfirmasi).
    if (d.pendingPlan) {
      setPlan(d.pendingPlan.plan)
      setPendingPlan({ prompt: d.pendingPlan.prompt })
      setAwaitingConfirm(true)
    } else {
      setPlan(null)
      setPendingPlan(null)
      setAwaitingConfirm(false)
    }
    const st = await api.previewStatus(projectId)
    setPreviewOn(st.running)
  }

  useEffect(() => {
    void load().then(() => {
      const saved = loadView(projectId)
      if (saved.tab === 'code' && saved.file) void openFileAt(saved.file)
    })
    void api.usage().then(setUsage).catch(() => {})
    return () => abortRef.current?.abort()
  }, [projectId])

  /* One-view: simpan tab + file yang dibuka tiap berubah supaya kembali dari
     daftar proyek langsung ke tampilan yang sama, bukan mulai dari Chat. */
  useEffect(() => {
    saveView(projectId, { tab, file: openFile })
  }, [projectId, tab, openFile])

  const autoPreview = async () => {
    try {
      const p = await api.preview(projectId)
      setPreviewPort(p.port)
      setPreviewOn(true)
      setDirty(false)
    } catch {
      /* preview belum siap, tombol Jalankan tetap tersedia */
    }
  }

  const send = async (text: string, optsConfirmed = false) => {
    if (!text.trim() || sending) return

    // Ask discovery only for the first user request. If the model needs details,
    // show its questions in chat and wait; otherwise continue straight to build.
    if (pendingDiscovery) {
      text = `Permintaan awal: ${pendingDiscovery}\n\nJawaban/konteks tambahan dari pemilik: ${text.trim()}`
      setPendingDiscovery(null)
    } else if (messages.length === 0) {
      try {
        const discovery = await api.discovery(text.trim())
        if (!discovery.ready && discovery.questions.length) {
          setPendingDiscovery(text.trim())
          setMessages((m) => [...m, { role: 'user', content: text.trim() }, { role: 'assistant', content: discovery.questions.map((q, i) => `${i + 1}. ${q}`).join('\n') }])
          return
        }
      } catch { /* Discovery is advisory; continue building if unavailable. */ }
    }

    setSending(true)
    setStatus('menyiapkan')
    setPlan(null)
    setAudit(null)
    setStreamText('')
    setChangedFiles([])
    setInlineEvents([])
    resetActivity()
    pushActivity({ kind: 'status', text: 'menyiapkan', at: Date.now() })
    if (!optsConfirmed) setPendingPlan({ prompt: text })
    else setPendingPlan(null)
    setAwaitingConfirm(false)
    // Run konfirmasi = lanjutan dari prompt yang sama; jangan tampilkan bubble user dua kali.
    if (!optsConfirmed) setMessages((m) => [...m, { role: 'user', content: text }])

    const ctrl = new AbortController()
    abortRef.current = ctrl
    let didAwaitConfirm = false

    const handlers: ChatHandlers = {
      onStatus: (t) => {
        setStatus(t)
        pushActivity({ kind: 'status', text: t, at: Date.now() })
      },
      onPlan: (event) => setPlan(event),
      onAudit: (event) => setAudit(event),
      onFile: async (path, action) => {
        pushActivity({ kind: 'file', path, action, at: Date.now() })
        if (action !== 'mkdir') setInlineEvents((prev) => [...prev, { kind: 'file', path, action }])
        const { files } = await api.files(projectId)
        setFiles(files.map((f) => ({ path: f.path })))
        if (action === 'mkdir') return // folder baru: bukan file yang diubah, tak perlu preview ulang
        if (path) setChangedFiles((prev) => (prev.includes(path) ? prev : [...prev, path]))
        setDirty(true)
        if (previewOn) void reloadPreview()
      },
      onBuild: (ok, log) => {
        setBuildLog({ ok, log })
        pushActivity({ kind: 'terminal', title: 'npm run build', log, ok, at: Date.now() })
        setInlineEvents((prev) => [...prev, { kind: 'terminal', title: 'npm run build', log, ok }])
        if (!ok) setTab('code')
      },
      onInstall: (ok, log) => {
        pushActivity({ kind: 'terminal', title: 'npm install', log, ok, at: Date.now() })
        setInlineEvents((prev) => [...prev, { kind: 'terminal', title: 'npm install', log, ok }])
      },
      onAssistantDelta: (d) => {
        setStreamText((prev) => {
          const next = prev + d
          setStatus('')
          return next
        })
      },
      onAssistant: (t) => {
        setStreamText('')
        setMessages((m) => [...m, { role: 'assistant', content: t }])
      },
      onAwaitingConfirmation: () => {
        // Gerbang konfirmasi: rencana sudah tampil di chat; tunggu tombol "Setujui".
        didAwaitConfirm = true
        setStatus('')
        setAwaitingConfirm(true)
        setMessages((m) => [...m, { role: 'assistant', content: 'Rencana sudah ditampilkan. Setujui untuk mulai dibangun, atau tulis perubahan yang diinginkan.' }])
      },
      onScreenshot: () => {
        void load()
      },
      onPublished: (newSlug, url) => {
        setSlug(newSlug)
        setPubUrl(url)
        setDirty(false)
        pushActivity({ kind: 'status', text: `Web publik diperbarui: ${newSlug}`, at: Date.now() })
      },
      onError: (t) => {
        setStreamText('')
        setMessages((m) => [...m, { role: 'error', content: t }])
        /* Run yang gagal di tengah jalan bisa tetap memotong credit
           (deduct atas usage sebagian) — segarkan chip saldo. */
        notifyBalanceChanged()
      },
      onDone: () => {
        // Jawaban yang di-stream (konsultasi & narasi) hidup di streamText.
        // Saat run selesai, simpan sebagai bubble permanen — kalau tidak,
        // bubble chat hilang begitu run berakhir / halaman dimuat ulang.
        setStreamText((streamed) => {
          const clean = streamed.trim()
          if (clean) setMessages((m) => [...m, { role: 'assistant', content: clean }])
          return ''
        })
        setStatus('')
        /* Fase 3: saldo berkurang sesudah run — segarkan chip tanpa refresh. */
        notifyBalanceChanged()
        void api.files(projectId).then(({ files }) => setFiles(files.map((f) => ({ path: f.path }))))
        // Saat gerbang konfirmasi aktif, jangan jalankan preview: belum ada
        // perubahan file dan dist bisa belum ada (menghindari 500 yang sia-sia).
        if (!didAwaitConfirm) void autoPreview()
      },
    }

    try {
      /* Wire ke server HANYA bare model id (auto → undefined = default
         server). Prefix provider dari pilihan dilepas di sini — server
         belum punya format wire untuk provider (lihat models.ts). */
      await chatStream(projectId, text, handlers, ctrl.signal, { model: modelIdForServer(model), planMode, confirmPlan: true, confirmed: optsConfirmed })
    } catch (err) {
      setMessages((m) => [...m, { role: 'error', content: (err as Error).message }])
    } finally {
      setSending(false)
      setStatus('')
      abortRef.current = null
    }
  }

  const confirmPlanAndRun = async () => {
    if (!pendingPlan || sending) return
    const prompt = pendingPlan.prompt
    setAwaitingConfirm(false)
    // Hapus pesan "menunggu persetujuan" lama dari tampilan.
    setMessages((m) => m.filter((x) => !(x.role === 'assistant' && x.content.startsWith('Rencana sudah ditampilkan'))))
    await send(prompt, true)
  }

  const cancelPlan = async () => {
    if (!pendingPlan || sending) return
    try {
      await api.cancelPendingPlan(projectId)
    } catch {
      /* gagal hapus di server: tetap bersihkan tampilan */
    }
    setPlan(null)
    setPendingPlan(null)
    setAwaitingConfirm(false)
  }

  const startPreview = async () => {
    setBooting(true)
    try {
      const b = await api.build(projectId)
      if (!b.ok) {
        setBuildLog({ ok: false, log: b.log })
        setTab('code')
        return
      }
      const p = await api.preview(projectId)
      setPreviewPort(p.port)
      setPreviewOn(true)
      setDirty(false)
    } catch (err) {
      setBuildLog({ ok: false, log: (err as Error).message })
    } finally {
      setBooting(false)
    }
  }

  const publish = async () => {
    setPublishing(true)
    setPublishMsg('')
    try {
      const r = await api.publish(projectId, slug ?? undefined)
      setSlug(r.slug)
      setPubUrl(r.url)
      setPreviewPort(r.port)
      setPreviewOn(true)
      setDirty(false)
    } catch (err) {
      setPublishMsg((err as Error).message)
    } finally {
      setPublishing(false)
    }
  }

  const unpublish = async () => {
    await api.unpublish(projectId)
    setSlug(null)
  }

  const reloadPreview = async () => {
    try {
      const p = await api.preview(projectId)
      setPreviewPort(p.port)
      setPreviewOn(true)
      setDirty(false)
    } catch {
      /* biarkan status lama */
    }
  }

  const openFileAt = async (path: string) => {
    setOpenFile(path)
    try {
      const f = await api.file(projectId, path)
      setFileContent(f.content)
      setSavedContent(f.content)
    } catch {
      setFileContent('')
      setSavedContent('')
      setBuildLog({ ok: false, log: `Gagal membaca ${path}` })
    }
  }

  const saveFile = async () => {
    if (!openFile) return
    await api.saveFile(projectId, openFile, fileContent)
    setSavedContent(fileContent)
    setBuildLog(null)
  }

  const rename = async () => {
    const next = name.trim()
    if (!next) return
    await api.renameProject(projectId, next)
    onTitle(next)
  }

  const unsaved = openFile !== null && fileContent !== savedContent

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-edge bg-ink px-3">
        <button
          onClick={onMenu}
          aria-label="Buka daftar proyek"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-edge text-body hover:bg-surface max-md:h-11 max-md:w-11"
        >
          <Icon name="back" size={15} />
        </button>
        <label htmlFor="vb-project-name" className="sr-only">
          Nama proyek
        </label>
        <input
          id="vb-project-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={rename}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          className="min-w-0 max-w-[200px] flex-1 rounded border border-transparent bg-transparent px-1.5 py-1 text-[13px] font-medium text-body outline-none transition-colors hover:border-edge focus:border-edge max-sm:max-w-[130px]"
        />

        <div className="ml-auto flex items-center gap-2">
          {status && (
            <span className="hidden items-center gap-1.5 text-[11.5px] text-quiet xl:flex">
              <Spinner />
              {status}
            </span>
          )}
          {/* Fase 3: chip saldo credit menggantikan chip "N req" token server.
              Klik -> halaman Penggunaan. Saldo dimuat ulang sesudah tiap run
              lewat notifyBalanceChanged() di onDone/onError di bawah. */}
          <CreditChip />
          <SessionMenu
            onShowFiles={() => setTab('code')}
            onShowDatabase={() => setDbOpen(true)}
            onRun={startPreview}
            runLabel={previewOn ? 'Build ulang' : 'Jalankan'}
            running={booting}
            onExport={() => void exportProjectZip(projectId).catch(() => {})}
            canExport={!!files.length}
            onToggleTheme={toggle}
            dark={dark}
            usage={usage}
            onPublish={() => void publish()}
            publishing={publishing}
            published={!!slug}
            onUnpublish={() => void unpublish()}
          />
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <section
          className={`flex min-w-0 flex-col border-r border-edge ${
            tab === 'chat' ? 'w-[46%] max-w-[600px] max-md:w-full max-md:max-w-none' : 'hidden'
          }`}
        >
          <ChatPanel
            messages={messages}
            sending={sending}
            status={status}
            plan={plan}
            audit={audit}
            streamText={streamText}
            activity={activity}
            onSend={send}
            onCancel={() => abortRef.current?.abort()}
            onConfirmPlan={confirmPlanAndRun}
            onCancelPlan={cancelPlan}
            awaitingConfirm={awaitingConfirm}
            onOpenSettings={() => setSettingsOpen(true)}
            waitingForDiscovery={!!pendingDiscovery}
            inlineEvents={inlineEvents}
            onOpenFile={(path) => {
              setTab('code')
              void openFileAt(path)
            }}
            previewOpen={previewOn && !sending}
            previewUrl={slug ? publicUrl(slug) : previewPort ? `http://127.0.0.1:${previewPort}/` : ''}
          />
        </section>

        <section className={`flex min-w-0 flex-1 flex-col ${tab === 'chat' ? 'max-md:hidden' : ''}`}>
          {tab === 'chat' ? (
            <PreviewPane
              previewOn={previewOn}
              previewPort={previewPort}
              dirty={dirty}
              buildLog={buildLog}
              onRun={startPreview}
              booting={booting}
              hasFiles={files.length > 0}
            />
          ) : (
            <CodePane
              files={files}
              openFile={openFile}
              content={fileContent}
              buildLog={buildLog}
              changedFiles={changedFiles}
              projectId={projectId}
              onOpen={openFileAt}
              onChange={setFileContent}
              onSave={saveFile}
              onBuild={startPreview}
              onFilesRefresh={() => void api.files(projectId).then(({ files }) => setFiles(files.map((f) => ({ path: f.path }))))}
            />
          )}
        </section>
      </div>

      <SettingsSheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        projectId={projectId}
        projectName={name}
        model={model}
        onModel={(m) => {
          setModel(m)
          localStorage.setItem('vb-model', m)
        }}
        planMode={planMode}
        onPlanMode={setPlanMode}
      />

      <DatabaseViewer
        open={dbOpen}
        onClose={() => setDbOpen(false)}
        projectId={projectId}
        files={files}
      />

      {publishMsg && (
        <p className="shrink-0 border-t border-edge bg-surface px-3 py-1.5 text-[11px] text-accent">
          {publishMsg}
        </p>
      )}

      {modelNotice && (
        <p className="shrink-0 border-t border-edge bg-surface px-3 py-1.5 text-[11px] text-accent">
          {modelNotice}
        </p>
      )}

      {unsaved && (
        <p className="shrink-0 border-t border-edge bg-surface px-3 py-1.5 text-[11px] text-accent">
          Perubahan pada {openFile} belum disimpan. Tekan Simpan sebelum build.
        </p>
      )}
    </div>
  )
}

function TabBtn({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <Button
      onClick={onClick}
      aria-pressed={active}
      size="sm"
      variant="ghost"
      className={`h-7 max-md:h-11 ${active ? 'bg-accent text-ink' : 'text-quiet'}`}
    >
      {label}
    </Button>
  )
}

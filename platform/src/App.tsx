import { useEffect, useRef, useState } from 'react'
import { Button } from '@cloudflare/kumo/components/button'
import { Icon, Spinner, Wordmark } from './ui'
import { api, auth, ChatHandlers, chatStream, Project, exportProjectZip, type User } from './api'
import { AuthGate, UserBar } from './auth'
import { matchPath, navigate, usePath } from './router'
import { ChatPanel, CodePane, PreviewPane, SettingsSheet, type ChatAudit, type ChatPlan, type InlineEvent, type VisualTarget } from './panels'
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
function SessionMenu({ projectId, usage }: { projectId: string; usage: { requests: number; promptTokens: number; completionTokens: number } | null }) {
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

  const item = 'flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12.5px] text-body transition-colors hover:bg-surface'
  const go = (slug: string) => () => { setOpen(false); navigate(`/proyek/${projectId}/${slug}`) }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Menu sesi"
        aria-expanded={open}
        className="flex h-9 w-9 items-center justify-center rounded-full border border-edge text-body transition-colors hover:border-quiet max-md:h-11 max-md:w-11"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
        </svg>
      </button>
      {open && (
        <div role="menu" className="vb-enter absolute right-0 top-[calc(100%+6px)] z-30 w-56 overflow-hidden rounded-xl border border-edge bg-ink shadow-lg">
          {usage && (
            <div className="border-b border-edge px-3 py-2">
              <p className="text-[10.5px] uppercase tracking-wide text-quiet">Pemakaian LLM</p>
              <p className="mt-0.5 font-mono text-[11px] text-body">
                {usage.requests} req · {usage.promptTokens.toLocaleString('id-ID')} in · {usage.completionTokens.toLocaleString('id-ID')} out
              </p>
            </div>
          )}
          <button className={item} onClick={go('chat')} role="menuitem"><Icon name="back" size={13} /> Chat</button>
          <button className={item} onClick={go('file')} role="menuitem"><Icon name="file" size={13} /> Lihat file</button>
          <button className={item} onClick={go('database')} role="menuitem">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true"><ellipse cx="12" cy="5" rx="8" ry="3" stroke="currentColor" strokeWidth="1.7" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" stroke="currentColor" strokeWidth="1.7" /></svg> Lihat database
          </button>
          <button className={item} onClick={go('jalankan')} role="menuitem"><Icon name="run" size={13} /> Jalankan</button>
          <button className={item} onClick={go('terbitkan')} role="menuitem"><Icon name="check" size={13} /> Terbitkan</button>
          <button className={item} onClick={go('export')} role="menuitem"><Icon name="download" size={13} /> Export ZIP</button>
          <button className={item} onClick={go('tampilan')} role="menuitem"><Icon name="moon" size={13} /> Mode tampilan</button>
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
  const [databaseLabel, setDatabaseLabel] = useState('')
  const [error, setError] = useState('')
  const [mode, setMode] = useState<'Browse' | 'Structure' | 'SQL' | 'Export'>('Browse')
  const [tableFilter, setTableFilter] = useState('')
  const [selectedTable, setSelectedTable] = useState<string | null>(null)
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof api.databaseTable>> | null>(null)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [detailLoading, setDetailLoading] = useState(false)
  const [exportSql, setExportSql] = useState('')
  const [exportBusy, setExportBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [queryResult, setQueryResult] = useState<{ columns: string[]; rows: Record<string, unknown>[]; truncated: boolean } | null>(null)
  const [queryError, setQueryError] = useState('')
  const [running, setRunning] = useState(false)

  const loadTable = async (name: string, nextSearch = search, nextPage = page) => {
    setSelectedTable(name); setDetail(null); setDetailLoading(true)
    try {
      const r = await api.databaseTable(projectId, name, nextSearch, nextPage)
      setDetail(r)
    } catch (e) { setDetail({ ok: false, error: (e as Error).message }) }
    finally { setDetailLoading(false) }
  }

  useEffect(() => {
    if (!open || status !== 'ready' || !tables.length) return
    const first = tables[0].name
    setSelectedTable((cur) => (cur && tables.some((t) => t.name === cur) ? cur : first))
  }, [open, status, tables])

  useEffect(() => {
    if (!open || !selectedTable || mode !== 'Browse') return
    void loadTable(selectedTable)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selectedTable, mode])

  const runQuery = async () => {
    if (!query.trim() || running) return
    setRunning(true); setQueryError(''); setQueryResult(null)
    try {
      const r = await api.dbQuery(projectId, query)
      if (!r.ok || r.error) {
        setQueryError(r.error || 'Query gagal.')
        return
      }
      setQueryResult({ columns: r.columns ?? [], rows: r.rows ?? [], truncated: !!r.truncated })
    } catch (e) {
      setQueryError((e as Error).message || 'Query gagal.')
    } finally {
      setRunning(false)
    }
  }

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
        setDatabaseLabel(r.database ?? '')
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
        className="vb-enter flex max-h-[90dvh] w-full max-w-[980px] flex-col border border-edge bg-surface px-4 pb-5 pt-4 max-md:px-3"
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
        <div className="mb-3 flex items-center gap-1 border-b border-edge pb-2" role="tablist" aria-label="Mode database">
          {(['Browse', 'Structure', 'SQL', 'Export'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              role="tab"
              aria-selected={mode === m}
              className={`h-7 px-2 text-[11.5px] transition-colors ${mode === m ? 'text-body underline underline-offset-4' : 'text-quiet hover:text-body'}`}
            >
              {m}
            </button>
          ))}
          <span className="ml-auto text-[10.5px] text-quiet">{databaseLabel}</span>
        </div>
        {mode === 'SQL' && (
          <div className="mb-3">
            <textarea
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') void runQuery() }}
              spellCheck={false}
              aria-label="Query SQL"
              placeholder={'SELECT * FROM users ORDER BY created_at DESC LIMIT 20'}
              className="vb-scroll h-24 w-full resize-y border border-edge bg-ink px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-body outline-none placeholder:text-quiet focus:border-accent"
            />
            <div className="mt-1.5 flex items-center justify-between gap-2">
              <p className="text-[10.5px] text-quiet">Hanya SELECT/WITH · satu pernyataan · maks 100 baris · Ctrl+Enter</p>
              <button
                onClick={() => void runQuery()}
                disabled={running || !query.trim()}
                className="flex h-7 shrink-0 items-center gap-1 border border-accent bg-accent px-2.5 text-[11px] text-on-accent transition-opacity disabled:opacity-40"
              >
                <Icon name="run" size={10} /> {running ? 'Jalankan…' : 'Jalankan query'}
              </button>
            </div>
            {queryError && <p className="mt-2 border-l-2 border-accent pl-2 text-[11.5px] text-body">{queryError}</p>}
            {queryResult && (
              <div className="vb-scroll mt-2 max-h-56 overflow-auto border border-edge">
                {queryResult.columns.length ? (
                  <table className="w-max border-collapse text-[11.5px]">
                    <thead>
                      <tr>{queryResult.columns.map((c) => <th key={c} className="whitespace-nowrap border border-edge bg-ink px-2 py-1 text-left font-medium text-body">{c}</th>)}</tr>
                    </thead>
                    <tbody>
                      {queryResult.rows.map((row, i) => (
                        <tr key={i}>{queryResult.columns.map((c) => {
                          const raw = queryResult.rows[i]?.[c]
                          const isNull = raw === null || raw === undefined
                          const text = isNull ? 'NULL' : String(raw)
                          return <td key={c} className="max-w-[180px] border border-edge px-2 py-1 align-top text-body"><span className={`block max-w-[176px] truncate ${isNull ? 'italic text-quiet' : ''}`} title={text}>{text}</span></td>
                        })}</tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="px-2 py-2 text-[11.5px] text-quiet">Query berhasil, tanpa baris hasil.</p>
                )}
              </div>
            )}
            {queryResult && (
              <p className="mt-1 text-[10.5px] text-quiet">
                {queryResult.rows.length} baris{queryResult.truncated ? ' · dibatasi 100 baris pertama' : ''}
              </p>
            )}
          </div>
        )}
        <div className="vb-scroll min-h-0 flex-1 overflow-y-auto">
          {mode === 'Browse' && <>
          {status === 'loading' && <p className="text-[12px] text-quiet">Membaca database…</p>}
          {status === 'error' && <p className="border-l-2 border-accent pl-2 text-[12px] text-body">{error}</p>}
          {status === 'ready' && (
            <div className="flex gap-3 max-md:flex-col">
              {/* Sidebar daftar tabel, seperti panel kiri phpMyAdmin */}
              <aside className="w-[176px] shrink-0 max-md:w-full">
                <input
                  value={tableFilter}
                  onChange={(e) => setTableFilter(e.target.value)}
                  placeholder="Cari tabel…"
                  aria-label="Cari tabel"
                  className="mb-2 h-7 w-full border border-edge bg-ink px-2 text-[11.5px] text-body outline-none placeholder:text-quiet focus:border-accent"
                />
                <ul className="vb-scroll max-h-[40dvh] overflow-y-auto border border-edge max-md:max-h-32">
                  {tables.filter((t) => t.name.toLowerCase().includes(tableFilter.toLowerCase())).map((t) => (
                    <li key={t.name}>
                      <button
                        onClick={() => { setPage(0); setSearch(''); void loadTable(t.name, '', 0) }}
                        aria-current={selectedTable === t.name}
                        className={`block w-full truncate px-2 py-1.5 text-left font-mono text-[11.5px] transition-colors ${selectedTable === t.name ? 'bg-accent/15 text-body' : 'text-quiet hover:bg-ink hover:text-body'}`}
                        title={`${t.name} · ${t.note ?? ''}`}
                      >
                        {t.name}
                      </button>
                    </li>
                  ))}
                  {!tables.filter((t) => t.name.toLowerCase().includes(tableFilter.toLowerCase())).length && (
                    <li className="px-2 py-1.5 text-[11px] text-quiet">Tidak ada tabel cocok.</li>
                  )}
                </ul>
                <p className="mt-1.5 text-[10.5px] text-quiet">{tables.length} tabel</p>
              </aside>

              {/* Panel kanan: isi tabel terpilih */}
              <div className="min-w-0 flex-1">
                {!selectedTable && <p className="text-[12px] text-quiet">Pilih tabel di kiri.</p>}
                {selectedTable && (
                  <>
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <h3 className="font-mono text-[12.5px] font-medium text-body">{selectedTable}</h3>
                      {detail?.total !== undefined && detailLoading === false && (
                        <span className="text-[11px] text-quiet">{detail.total} baris</span>
                      )}
                      <form
                        className="ml-auto flex items-center gap-1"
                        onSubmit={(e) => { e.preventDefault(); setPage(0); void loadTable(selectedTable, search, 0) }}
                      >
                        <input
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                          placeholder="Cari isi tabel…"
                          aria-label="Cari isi tabel"
                          className="h-7 w-[130px] border border-edge bg-ink px-2 text-[11.5px] text-body outline-none placeholder:text-quiet focus:border-accent"
                        />
                        <button type="submit" className="h-7 border border-edge px-2 text-[11px] text-body hover:border-accent">Cari</button>
                      </form>
                    </div>
                    {detailLoading && <p className="text-[11.5px] text-quiet">Memuat…</p>}
                    {detail?.error && <p className="border-l-2 border-accent pl-2 text-[11.5px] text-body">{detail.error}</p>}
                    {detail?.rows && (
                      <>
                        <div className="vb-scroll max-h-[42dvh] overflow-auto border border-edge" title="Geser horizontal untuk melihat semua kolom">
                          <table className="w-max border-collapse text-[12px]">
                            <thead>
                              <tr>
                                {(detail.columns ?? []).map((c) => (
                                  <th key={c.name} className="sticky top-0 z-10 whitespace-nowrap border border-edge bg-ink px-2 py-1.5 text-left font-medium text-body">
                                    {c.name}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {detail.rows.map((row, i) => (
                                <tr key={i} className="hover:bg-ink/60">
                                  {(detail.columns ?? []).map((c) => {
                                    const raw = row[c.name]
                                    const isNull = raw === null || raw === undefined
                                    const text = isNull ? 'NULL' : String(raw)
                                    return (
                                      <td key={c.name} className="max-w-[180px] border border-edge px-2 py-1 align-top text-body">
                                        <span className={`block max-w-[176px] truncate ${isNull ? 'italic text-quiet' : ''}`} title={text}>
                                          {text}
                                        </span>
                                      </td>
                                    )
                                  })}
                                </tr>
                              ))}
                              {!detail.rows.length && (
                                <tr><td colSpan={(detail.columns ?? []).length || 1} className="border border-edge px-2 py-2 text-[11.5px] text-quiet">Tabel kosong.</td></tr>
                              )}
                            </tbody>
                          </table>
                        </div>
                        <div className="mt-1.5 flex items-center gap-2 text-[10.5px] text-quiet">
                          <button
                            disabled={page <= 0}
                            onClick={() => { const p = Math.max(0, page - 1); setPage(p); void loadTable(selectedTable, search, p) }}
                            className="h-6 border border-edge px-2 disabled:opacity-40"
                          >‹ Sebelumnya</button>
                          <span>Halaman {page + 1} dari {detail.pageCount ?? 1}</span>
                          <button
                            disabled={page + 1 >= (detail.pageCount ?? 1)}
                            onClick={() => { const p = page + 1; setPage(p); void loadTable(selectedTable, search, p) }}
                            className="h-6 border border-edge px-2 disabled:opacity-40"
                          >Berikutnya ›</button>
                        </div>
                      </>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
          </>}
          {mode === 'Structure' && (
            <div>
              {!selectedTable && <p className="text-[12px] text-quiet">Pilih tabel di tab Browse dulu.</p>}
              {selectedTable && detailLoading && <p className="text-[11.5px] text-quiet">Memuat struktur…</p>}
              {selectedTable && detail?.error && <p className="border-l-2 border-accent pl-2 text-[11.5px] text-body">{detail.error}</p>}
              {selectedTable && detail?.columns && (
                <>
                  <h3 className="mb-2 font-mono text-[12.5px] font-medium text-body">{selectedTable}</h3>
                  <div className="vb-scroll max-h-[50dvh] overflow-auto border border-edge">
                    <table className="w-max border-collapse text-[12px]">
                      <thead>
                        <tr>
                          {['Kolom', 'Tipe', 'Null', 'Default'].map((h) => (
                            <th key={h} className="sticky top-0 z-10 whitespace-nowrap border border-edge bg-ink px-2 py-1.5 text-left font-medium text-body">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {detail.columns.map((c) => (
                          <tr key={c.name}>
                            <td className="border border-edge px-2 py-1 font-mono text-body">{c.name}</td>
                            <td className="border border-edge px-2 py-1 text-quiet">{c.type}</td>
                            <td className="border border-edge px-2 py-1 text-quiet">{c.nullable ? 'Ya' : 'Tidak'}</td>
                            <td className="max-w-[180px] border border-edge px-2 py-1">
                              <span className="block max-w-[176px] truncate text-quiet" title={c.default ?? 'NULL'}>{c.default ?? 'NULL'}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          )}
          {mode === 'Export' && (
            <div>
              <p className="mb-2 text-[11.5px] leading-relaxed text-quiet">
                Dump SQL seluruh tabel (CREATE TABLE + INSERT) — bisa diimpor ke Postgres lain.
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={async () => {
                    setExportBusy(true); setExportSql('')
                    try {
                      const r = await api.databaseExport(projectId)
                      setExportSql(r.ok && r.sql ? r.sql : `Gagal: ${r.error ?? 'tidak ada data'}`)
                    } catch (e) { setExportSql(`Gagal: ${(e as Error).message}`) }
                    finally { setExportBusy(false) }
                  }}
                  disabled={exportBusy}
                  className="h-7 border border-accent bg-accent px-2.5 text-[11px] text-on-accent disabled:opacity-40"
                >
                  {exportBusy ? 'Menyiapkan…' : 'Buat dump SQL'}
                </button>
                {exportSql && !exportSql.startsWith('Gagal') && (
                  <a
                    href={`data:text/plain;charset=utf-8,${encodeURIComponent(exportSql)}`}
                    download={`${databaseLabel || 'database'}.sql`}
                    className="h-7 border border-edge px-2.5 text-[11px] leading-7 text-body hover:border-accent"
                  >
                    Unduh .sql
                  </a>
                )}
              </div>
              {exportSql && (
                <textarea
                  readOnly
                  value={exportSql}
                  aria-label="Hasil dump SQL"
                  className="vb-scroll mt-2 h-[36dvh] w-full resize-y border border-edge bg-ink px-2 py-1.5 font-mono text-[10.5px] leading-relaxed text-body outline-none"
                />
              )}
            </div>
          )}
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
  const [showStarters, setShowStarters] = useState(false)
  const { dark, toggle } = useTheme()

  // Routing: '/' home, '/proyek/:id' workspace, '/profil' account page,
  // '/penggunaan' credit usage page (fase 3).
  const sessionSlugs = ['chat', 'file', 'database', 'jalankan', 'terbitkan', 'export', 'tampilan'] as const
  const sessionSlug = sessionSlugs.find((slug) => matchPath(`/proyek/:id/${slug}`, path))
  const projectRoute =
    (sessionSlug ? matchPath(`/proyek/:id/${sessionSlug}`, path) : null) ??
    matchPath('/proyek/:id', path)
  const routeTab: Route = sessionSlug ?? 'chat'
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

  const createProject = async (starter: 'blank' | 'lms' | 'tiket' = 'blank') => {
    const name = starter === 'lms' ? 'LMS baru' : starter === 'tiket' ? 'Event & Tiket baru' : 'Proyek tanpa nama'
    const { project } = await api.createProject(name, '', starter)
    setProjects((p) => [project, ...p])
    setShowStarters(false)
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
          routeTab={routeTab}
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
        showStarters={showStarters}
        setShowStarters={setShowStarters}
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
  showStarters,
  setShowStarters,
}: {
  projects: Project[]
  loading: boolean
  onCreate: (starter?: 'blank' | 'lms' | 'tiket') => void
  onSelect: (id: string) => void
  user: User
  dark: boolean
  onToggleTheme: () => void
  onLogout: () => void
  onMenu: () => void
  navOpen: boolean
  onCloseNav: () => void
  showStarters: boolean
  setShowStarters: (show: boolean) => void
}) {
  const working = projects.filter((p) => p.status === 'working').length
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-edge bg-surface px-4 max-md:h-12">
        <button
          onClick={onMenu}
          aria-label="Buka menu"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-edge text-body transition-colors hover:bg-surface-muted max-md:h-11 max-md:w-11"
        >
          <Icon name="back" size={15} />
        </button>
        <h1 className="text-[13px] font-medium text-body">Beranda</h1>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={onToggleTheme}
            aria-label={dark ? 'Mode terang' : 'Mode gelap'}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-edge text-quiet transition-colors hover:bg-surface-muted hover:text-body"
          >
            <Icon name={dark ? 'sun' : 'moon'} size={13} />
          </button>
          <button
            onClick={onLogout}
            className="vb-btn-ghost h-8 text-[11.5px] text-quiet"
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
              onClick={() => setShowStarters(!showStarters)}
              className="vb-btn-primary h-9 max-md:h-11"
            >
              <Icon name="plus" size={12} />
              Proyek baru
            </button>
            {showStarters && (
              <div className="mt-3 grid max-w-xl gap-3 sm:grid-cols-2" role="group" aria-label="Pilih starter proyek">
                <button onClick={() => { setShowStarters(false); onCreate(); }} className="vb-card p-4 text-left transition-colors hover:border-accent">
                  <span className="block text-sm font-semibold text-body">Proyek kosong</span>
                  <span className="mt-1 block text-xs text-quiet">Template standar untuk mulai dari awal</span>
                </button>
                <button onClick={() => { setShowStarters(false); onCreate('lms'); }} className="vb-card border-accent/40 bg-accent-soft/60 p-4 text-left transition-colors hover:border-accent">
                  <span className="block text-sm font-semibold text-body">Starter LMS</span>
                  <span className="mt-1 block text-xs text-quiet">Kursus, materi, enrollment, tugas, dan penilaian</span>
                </button>
                <button onClick={() => { setShowStarters(false); onCreate('tiket'); }} className="vb-card p-4 text-left transition-colors hover:border-accent">
                  <span className="block text-sm font-semibold text-body">Starter Event & Tiket</span>
                  <span className="mt-1 block text-xs text-quiet">Event, tiket, pesanan, promo, dan check-in</span>
                </button>
              </div>
            )}
            <a
              href="/profil"
              className="vb-btn-ghost h-9 max-md:h-11"
            >
              Profil akun
            </a>
            <a
              href="/marketplace"
              className="vb-btn-ghost h-9 max-md:h-11"
            >
              Marketplace
            </a>
          </div>

          <div className="vb-grid-3 mt-8 max-sm:grid-cols-1">
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
            <ul className="vb-card mt-3 divide-y divide-edge overflow-hidden">
              {projects.map((p) => (
                <li key={p.id}>
                  <button
                    onClick={() => onSelect(p.id)}
                    className="vb-link-row"
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
    <div className="vb-card px-4 py-3.5">
      <p className="vb-eyebrow">{label}</p>
      <p className="mt-1 font-display text-[22px] leading-tight text-body">{value}</p>
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
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-edge bg-surface px-4 max-md:h-12">
        <button
          onClick={onMenu}
          aria-label="Buka menu"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-edge text-body transition-colors hover:bg-surface-muted max-md:h-11 max-md:w-11"
        >
          <Icon name="back" size={15} />
        </button>
        <h1 className="text-[13px] font-medium text-body">Profil</h1>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={onToggleTheme}
            aria-label={dark ? 'Mode terang' : 'Mode gelap'}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-edge text-quiet transition-colors hover:bg-surface-muted hover:text-body"
          >
            <Icon name={dark ? 'sun' : 'moon'} size={13} />
          </button>
          <button
            onClick={onLogout}
            className="vb-btn-ghost h-8 text-[11.5px] text-quiet"
          >
            Keluar
          </button>
        </div>
      </header>
      <div className="flex-1 overflow-y-auto px-5 py-8 max-md:px-4 max-md:py-6">
        <div className="mx-auto max-w-2xl">
          <div className="vb-card p-5">
            <p className="vb-eyebrow">Akun</p>
            <p className="mt-1 text-[17px] font-semibold text-body">{user.name || 'Tanpa nama'}</p>
            <p className="text-[12.5px] text-quiet">{user.email}</p>
            <button onClick={onLogout} className="vb-btn-ghost mt-4 h-8">
              Keluar dari akun
            </button>
          </div>

          <div className="vb-card mt-4 p-5">
            <p className="vb-eyebrow">Tema</p>
            <button onClick={onToggleTheme} className="vb-btn-ghost mt-3 h-8 text-[12px]">
              <Icon name={dark ? 'sun' : 'moon'} size={12} />
              {dark ? 'Aktifkan mode terang' : 'Aktifkan mode gelap'}
            </button>
          </div>

          <div className="mt-6">
            <div className="flex items-center justify-between">
              <p className="text-[10.5px] uppercase tracking-wide text-quiet">Proyek ({projects.length})</p>
              <button onClick={() => { onCreate(); }} className="flex h-7 items-center gap-1 text-[11.5px] text-accent">
                <Icon name="plus" size={11} />
                Baru
              </button>
            </div>
            {!projects.length ? (
              <p className="mt-3 text-[12.5px] text-quiet">Belum ada proyek.</p>
            ) : (
              <ul className="vb-card mt-3 divide-y divide-edge overflow-hidden">
                {projects.map((p) => (
                  <li key={p.id}>
                    <button
                      onClick={() => onSelect(p.id)}
                      className="vb-link-row min-h-[48px] py-2.5"
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

        <a
          href="/admin/settings"
          className="flex min-h-[38px] max-md:min-h-[44px] items-center gap-2 border-t border-edge px-3 py-2 text-[12.5px] text-body transition-colors hover:bg-surface-muted"
          title="Pengaturan admin — API key, model, pembayaran"
        >
          <Icon name="gear" size={13} className="text-quiet" />
          Pengaturan admin
        </a>

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

function EmptyState({ onCreate, showStarters, setShowStarters }: { onCreate: (starter?: 'blank' | 'lms' | 'tiket') => void; showStarters: boolean; setShowStarters: (show: boolean) => void }) {
  return (
    <div className="flex flex-1 items-center justify-center px-6">
      <div className="max-w-[44ch]">
        <h1 className="font-display text-[26px] leading-tight text-body">
          Satu ruang kerja untuk menulis dan menjalankan aplikasi
        </h1>
        <p className="mt-3 text-[13px] leading-relaxed text-quiet">
          Pilih proyek kosong, starter LMS (kursus, materi, tugas, penilaian), atau starter Event & Tiket (event, pesanan, promo, check-in).
        </p>
        {!showStarters ? (
          <button
            onClick={() => setShowStarters(true)}
            className="vb-btn-primary mt-6 max-md:h-11"
          >
            <Icon name="plus" size={12} />
            Buat proyek pertama
          </button>
        ) : (
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            <button onClick={() => onCreate('blank')} className="vb-card p-4 text-left transition-colors hover:border-accent">
              <span className="block text-sm font-semibold text-body">Proyek kosong</span>
              <span className="mt-1 block text-xs text-quiet">Mulai dari template standar</span>
            </button>
            <button onClick={() => onCreate('lms')} className="vb-card border-accent/40 bg-accent-soft p-4 text-left transition-colors hover:border-accent">
              <span className="block text-sm font-semibold text-body">Starter LMS</span>
              <span className="mt-1 block text-xs text-quiet">Kursus, materi, enrollment, tugas & grading</span>
            </button>
            <button onClick={() => onCreate('tiket')} className="vb-card p-4 text-left transition-colors hover:border-accent">
              <span className="block text-sm font-semibold text-body">Starter Event & Tiket</span>
              <span className="mt-1 block text-xs text-quiet">Event, tiket, pesanan, promo & check-in</span>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

type Route = 'chat' | 'file' | 'database' | 'jalankan' | 'terbitkan' | 'export' | 'tampilan'

function Workspace({ projectId, routeTab, onTitle, onMenu }: { projectId: string; routeTab: Route; onTitle: (n: string) => void; onMenu: () => void }) {
  const { dark, toggle } = useTheme()
  const [tab, setTab] = useState<'chat' | 'code'>(routeTab === 'file' ? 'code' : 'chat')
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
  /* Route adalah sumber kebenaran: /chat, /file, /database. Berpindah URL
     (kembali, refresh, tautan langsung) selalu mengarahkan panel yang benar. */
  useEffect(() => {
    setTab(routeTab === 'file' ? 'code' : 'chat')
    if (routeTab === 'file' && openFile) saveView(projectId, { tab: 'code', file: openFile })
  }, [routeTab, projectId, openFile])

  const [planMode, setPlanMode] = useState(false)
  const [pendingPlan, setPendingPlan] = useState<{ prompt: string } | null>(null)
  const [awaitingConfirm, setAwaitingConfirm] = useState(false)
  const { entries: activity, push: pushActivity, reset: resetActivity } = useActivity()
  const abortRef = useRef<AbortController | null>(null)

  /* Muat daftar file sekali saat workspace dipasang. State `filesReady`
     membedakan "belum selesai dimuat" dari "benar-benar kosong": panel Kode
     tidak boleh berbohong "Belum ada file" hanya karena request masih
     berjalan (endpoint bisa memakan beberapa detik). */
  const [filesReady, setFilesReady] = useState(false)
  const load = async () => {
    const d = await api.getProject(projectId)
    setMessages(d.messages.map((m) => ({ role: m.role, content: m.content, id: m.id })))
    setFiles(d.files.map((f) => ({ path: f.path })))
    setFilesReady(true)
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
      /* File dibuka ulang hanya bila route memang /file, atau user nieuwe
         masuk lewat /proyek/:id dengan state tersimpan (kompatibilitas). */
      const saved = loadView(projectId)
      if (saved.tab === 'code' && saved.file && routeTab === 'file') void openFileAt(saved.file)
    })
    void api.usage().then(setUsage).catch(() => {})
    return () => abortRef.current?.abort()
  }, [projectId])

  /* One-view: simpan tab + file yang dibuka tiap berubah supaya kembali dari
     daftar proyek langsung ke tampilan yang sama, bukan mulai dari Chat. */
  useEffect(() => {
    if (routeTab === 'file' || routeTab === 'chat') saveView(projectId, { tab, file: openFile })
  }, [projectId, tab, openFile, routeTab])

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
        if (!ok) navigate(`/proyek/${projectId}/file`)
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

  /* Visual edit: klik elemen di preview → agent menerima selector + teks +
     posisi, lalu mengubah file yang menaungi komponen tersebut. */
  const pickElement = (t: VisualTarget) => {
    if (sending) return
    const prompt = [
      'Ubah elemen yang saya pilih di preview.',
      `Tag: <${t.tag}>`,
      `Teks: ${t.label || '(tanpa teks)'}`,
      `Selector CSS: ${t.selector}`,
      `Posisi: x=${t.x} y=${t.y} ukuran=${t.width}x${t.height}`,
      'Cari komponen/file yang menaungi elemen ini (cocokkan teks/selector), lalu ubah hanya bagian yang diminta. Jawab singkat file apa yang diubah.',
    ].join('\n')
    setMessages((m) => [...m, { role: 'user', content: `🎯 ${t.label || t.tag} — ${t.selector}` }])
    void send(prompt)
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
        navigate(`/proyek/${projectId}/file`)
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
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-edge bg-surface px-4 max-md:h-12">
        <button
          onClick={() => navigate(`/proyek/${projectId}/chat`)}
          aria-label="Kembali ke chat"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-edge text-body transition-colors hover:bg-surface-muted max-md:h-11 max-md:w-11"
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
          <SessionMenu projectId={projectId} usage={usage} />
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
              navigate(`/proyek/${projectId}/file`)
              void openFileAt(path)
            }}
            previewOpen={previewOn && !sending}
            previewUrl={slug ? publicUrl(slug) : previewPort ? `http://127.0.0.1:${previewPort}/` : ''}
          />
        </section>

        <section className={`flex min-w-0 flex-1 flex-col ${routeTab === 'chat' ? 'max-md:hidden' : ''}`}>
          {routeTab === 'chat' ? (
            <PreviewPane
              previewOn={previewOn}
              previewPort={previewPort}
              projectId={projectId}
              onPick={pickElement}
              dirty={dirty}
              buildLog={buildLog}
              onRun={startPreview}
              booting={booting}
              hasFiles={files.length > 0}
            />
          ) : routeTab === 'file' ? (
            <CodePane
              files={files}
              filesReady={filesReady}
              openFile={openFile}
              content={fileContent}
              buildLog={buildLog}
              changedFiles={changedFiles}
              projectId={projectId}
              onOpen={openFileAt}
              onChange={setFileContent}
              onSave={saveFile}
              onBuild={startPreview}
              onFilesRefresh={() => void api.files(projectId).then(({ files }) => { setFiles(files.map((f) => ({ path: f.path }))); setFilesReady(true) })}
            />
          ) : routeTab === 'jalankan' ? (
            <RunPane running={booting} buildLog={buildLog} hasFiles={files.length > 0} dirty={dirty} onRun={() => void startPreview()} onBack={() => navigate(`/proyek/${projectId}/chat`)} />
          ) : routeTab === 'terbitkan' ? (
            <PublishPane slug={slug} pubUrl={pubUrl} publishing={publishing} publishMsg={publishMsg} canPublish={files.length > 0} onPublish={publish} onUnpublish={() => void unpublish()} onBack={() => navigate(`/proyek/${projectId}/chat`)} />
          ) : routeTab === 'export' ? (
            <ExportPane canExport={files.length > 0} onExport={() => void exportProjectZip(projectId).catch(() => {})} onBack={() => navigate(`/proyek/${projectId}/chat`)} />
          ) : routeTab === 'tampilan' ? (
            <AppearancePane dark={dark} onToggle={toggle} onBack={() => navigate(`/proyek/${projectId}/chat`)} />
          ) : null}
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
        open={routeTab === 'database'}
        onClose={() => navigate(`/proyek/${projectId}/chat`)}
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

/* Panel aksi: route hanya menampilkan halaman; efek samping terjadi saat
   tombol eksplisit ditekan, tidak saat URL dibuka atau di-refresh. */
function PanelShell({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <div className="vb-scroll h-full overflow-y-auto bg-surface px-4 py-5 max-md:px-3">
      <h2 className="font-display text-[17px] text-body">{title}</h2>
      <p className="mt-1 max-w-[640px] text-[12px] leading-relaxed text-quiet">{note}</p>
      <div className="mt-4 max-w-[640px]">{children}</div>
    </div>
  )
}

function RunPane({ running, buildLog, hasFiles, dirty, onRun, onBack }: {
  running: boolean; buildLog: { ok: boolean; log: string } | null; hasFiles: boolean; dirty: boolean
  onRun: () => void; onBack: () => void
}) {
  return (
    <PanelShell title="Jalankan proyek" note="Build kode lalu nyalakan preview. Perubahan yang belum disimpan akan ikut dibangun bila sudah ada di server.">
      <button onClick={onRun} disabled={running || !hasFiles} className="vb-btn-primary h-10 px-4">
        <Icon name="run" size={13} /> {running ? 'Sedang build…' : 'Build & jalankan preview'}
      </button>
      {dirty && <p className="mt-3 border-l-2 border-accent pl-2 text-[11.5px] text-body">Ada file yang belum disimpan — simpan dulu di menu Lihat file agar hasil build sesuai editor.</p>}
      {buildLog && (
        <pre className="vb-scroll mt-4 max-h-[320px] overflow-auto rounded-lg border border-edge bg-surface-muted p-3 font-mono text-[11px] leading-relaxed text-body">{buildLog.log}</pre>
      )}
      <button onClick={onBack} className="mt-4 text-[12px] text-quiet underline hover:text-body">Kembali ke chat</button>
    </PanelShell>
  )
}

function PublishPane({ slug, pubUrl, publishing, publishMsg, canPublish, onPublish, onUnpublish, onBack }: {
  slug: string | null; pubUrl: string | null; publishing: boolean; publishMsg: string; canPublish: boolean
  onPublish: () => void; onUnpublish: () => void; onBack: () => void
}) {
  return (
    <PanelShell title="Terbitkan website" note="Website dipublikasikan ke subdomain clidi.net. Publikasi ulang hanya berjalan saat tombol ditekan.">
      {slug ? (
        <>
          <p className="text-[12.5px] text-body">Sudah tayang di <a href={pubUrl ?? '#'} target="_blank" rel="noreferrer" className="text-accent underline">{slug}.clidi.net</a></p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button onClick={() => void onPublish()} disabled={publishing || !canPublish} className="vb-btn-primary h-10 px-4 disabled:opacity-50">Perbarui publikasi</button>
            <button onClick={onUnpublish} disabled={publishing} className="vb-btn-ghost h-10 px-4 disabled:opacity-50">Tarik publikasi</button>
          </div>
        </>
      ) : (
        <button onClick={() => void onPublish()} disabled={publishing || !canPublish} className="vb-btn-primary h-10 px-4 disabled:opacity-50">
          <Icon name="check" size={13} /> {publishing ? 'Menerbitkan…' : 'Terbitkan sekarang'}
        </button>
      )}
      {!canPublish && <p className="mt-3 text-[11.5px] text-quiet">Build proyek dulu sebelum menerbitkan.</p>}
      {publishMsg && <p className="mt-3 border-l-2 border-accent pl-2 text-[12px] text-body">{publishMsg}</p>}
      <button onClick={onBack} className="mt-4 text-[12px] text-quiet underline hover:text-body">Kembali ke chat</button>
    </PanelShell>
  )
}

function ExportPane({ canExport, onExport, onBack }: { canExport: boolean; onExport: () => void; onBack: () => void }) {
  return (
    <PanelShell title="Export ZIP" note="Unduh seluruh file proyek sebagai arsip ZIP. Proyek lain tidak ikut terunduh.">
      <button onClick={onExport} disabled={!canExport} className="vb-btn-primary h-10 px-4 disabled:opacity-50">
        <Icon name="download" size={13} /> Unduh ZIP proyek
      </button>
      {!canExport && <p className="mt-3 text-[11.5px] text-quiet">Belum ada file untuk diexport.</p>}
      <button onClick={onBack} className="mt-4 text-[12px] text-quiet underline hover:text-body">Kembali ke chat</button>
    </PanelShell>
  )
}

function AppearancePane({ dark, onToggle, onBack }: { dark: boolean; onToggle: () => void; onBack: () => void }) {
  return (
    <PanelShell title="Mode tampilan" note="Pilih tema editor. Pengaturan ini tersimpan di perangkat ini dan tidak mengubah website yang kamu bangun.">
      <div className="grid gap-2 sm:grid-cols-2">
        <button onClick={() => { if (dark) onToggle() }} aria-pressed={!dark} className={`vb-card p-4 text-left text-[12.5px] transition-colors ${!dark ? 'border-accent bg-accent-soft text-body' : 'text-quiet'}`}>
          Terang {!dark && '· aktif'}
        </button>
        <button onClick={() => { if (!dark) onToggle() }} aria-pressed={dark} className={`vb-card p-4 text-left text-[12.5px] transition-colors ${dark ? 'border-accent bg-accent-soft text-body' : 'text-quiet'}`}>
          Gelap {dark && '· aktif'}
        </button>
      </div>
      <button onClick={onBack} className="mt-4 text-[12px] text-quiet underline hover:text-body">Kembali ke chat</button>
    </PanelShell>
  )
}

function TabBtn({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <Button
      onClick={onClick}
      aria-pressed={active}
      size="sm"
      variant="ghost"
      className={`h-7 max-md:h-11 ${active ? 'bg-accent text-on-accent' : 'text-quiet'}`}
    >
      {label}
    </Button>
  )
}

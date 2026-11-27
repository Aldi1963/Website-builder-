import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { api } from './api'
import { Icon } from './ui'

/*
 * Halaman Database penuh (bukan popup) untuk proyek.
 * Semua query berjalan di database Postgres terkelola proyek — Neon bila
 * kredensial terpasang di panel admin, lokal bila tidak. Data selalu
 * dibaca dari server, bukan dari file/state lokal.
 */

type TableInfo = { name: string; columns: string[]; rows: unknown[][]; note?: string }
type ColumnInfo = { name: string; type: string; nullable: boolean; default: string | null }
type QueryResult = { columns: string[]; rows: Record<string, unknown>[]; truncated: boolean; command?: string }
type Mode = 'browse' | 'sql' | 'structure' | 'export'

const MODES: Array<{ id: Mode; label: string; icon: string }> = [
  { id: 'browse', label: 'Data', icon: 'list' },
  { id: 'sql', label: 'SQL Editor', icon: 'code' },
  { id: 'structure', label: 'Struktur', icon: 'table' },
  { id: 'export', label: 'Ekspor', icon: 'download' },
]

function cellText(v: unknown): { text: string; null: boolean } {
  if (v === null || v === undefined) return { text: 'NULL', null: true }
  if (v instanceof Date) return { text: v.toISOString(), null: false }
  if (typeof v === 'object') return { text: JSON.stringify(v), null: false }
  return { text: String(v), null: false }
}

export function DatabasePage({ projectId, onBack }: { projectId: string; onBack: () => void }) {
  const [mode, setMode] = useState<Mode>('browse')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [database, setDatabase] = useState('')
  const [tables, setTables] = useState<TableInfo[]>([])
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof api.databaseTable>> | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [sql, setSql] = useState('SELECT * FROM ')
  const [result, setResult] = useState<QueryResult | null>(null)
  const [sqlError, setSqlError] = useState('')
  const [running, setRunning] = useState(false)
  const [exportText, setExportText] = useState('')
  const [exportBusy, setExportBusy] = useState(false)
  const [toast, setToast] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const r = await api.database(projectId)
      if (!r.managed) { setError(r.note || 'Database belum aktif.'); return }
      if (r.error) { setError(r.error); return }
      setTables((r.tables || []) as unknown as TableInfo[])
      setDatabase(r.database || '')
      setSelected((cur) => cur && r.tables?.some((t) => t.name === cur) ? cur : r.tables?.[0]?.name ?? null)
    } catch (e) { setError((e as Error).message) }
    finally { setLoading(false) }
  }, [projectId])

  useEffect(() => { void load() }, [load])

  const loadTable = useCallback(async (name: string, nextSearch = '', nextPage = 0) => {
    setSelected(name); setDetail(null); setDetailLoading(true)
    try { setDetail(await api.databaseTable(projectId, name, nextSearch, nextPage)) }
    catch (e) { setDetail({ ok: false, error: (e as Error).message }) }
    finally { setDetailLoading(false) }
  }, [projectId])

  useEffect(() => {
    /* Detail dimuat untuk tab Data DAN Struktur (bukan SQL Editor/Ekspor). */
    if (selected && mode !== 'sql' && mode !== 'export') void loadTable(selected, search, page)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, selected])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(''), 3000)
    return () => clearTimeout(t)
  }, [toast])

  const filtered = useMemo(
    () => tables.filter((t) => t.name.toLowerCase().includes(filter.toLowerCase())),
    [tables, filter],
  )

  const runSql = async () => {
    const text = sql.trim()
    if (!text || running) return
    setRunning(true); setSqlError(''); setResult(null)
    try {
      const first = text.split(/\s+/)[0]?.toLowerCase()
      if (first === 'insert' || first === 'update' || first === 'delete') {
        const r = await api.dbExec(projectId, text)
        if (!r.ok) { setSqlError(r.error || 'Query gagal.'); return }
        setResult({ columns: [], rows: [], truncated: false, command: `${r.command || first} · ${r.rowCount ?? 0} baris terdampak` })
        setToast(`Berhasil: ${r.rowCount ?? 0} baris ${first === 'delete' ? 'dihapus' : first === 'update' ? 'diubah' : 'ditambahkan'}.`)
        /* Segarkan juga detail browse yang sedang tampil (bukan hanya daftar
           tabel) supaya baris yang baru diubah/dihapus langsung terlihat. */
        void load().then(() => { if (selected) void loadTable(selected, search, page) })
      } else {
        const r = await api.dbQuery(projectId, text)
        if (!r.ok) { setSqlError(r.error || 'Query gagal.'); return }
        setResult({ columns: r.columns || [], rows: r.rows || [], truncated: !!r.truncated })
      }
    } catch (e) { setSqlError((e as Error).message || 'Query gagal.') }
    finally { setRunning(false) }
  }

  const doExport = async () => {
    setExportBusy(true)
    try {
      const r = await api.databaseExport(projectId)
      if (!r.ok) { setError(r.error || 'Ekspor gagal.'); return }
      setExportText(r.sql || '')
    } finally { setExportBusy(false) }
  }

  const download = () => {
    const blob = new Blob([exportText], { type: 'text/plain;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `database-${projectId.slice(0, 8)}.sql`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const submitSearch = (e: FormEvent) => { e.preventDefault(); setPage(0); void loadTable(selected || '', search, 0) }

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-surface text-body">
      {/* Header */}
      <header className="flex shrink-0 items-center gap-3 border-b border-edge px-4 py-3 max-md:px-3">
        <button onClick={onBack} aria-label="Kembali ke chat" className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-edge text-quiet hover:border-accent hover:text-body">
          <Icon name="arrow-left" size={14} />
        </button>
        <div className="min-w-0">
          <h1 className="truncate font-display text-[15px] text-body">Database aplikasi</h1>
          <p className="truncate font-mono text-[10.5px] text-quiet">{database || 'Memuat…'} · Postgres terkelola</p>
        </div>
        <span className="ml-auto hidden shrink-0 rounded border border-edge px-2 py-1 text-[10.5px] text-quiet sm:inline">
          {tables.length} tabel
        </span>
        <button onClick={() => void load()} className="flex h-8 items-center gap-1.5 rounded border border-edge px-2.5 text-[11px] text-body hover:border-accent">
          <Icon name="arrows-clockwise" size={12} /> Muat ulang
        </button>
      </header>

      {/* Tab bar */}
      <nav className="flex shrink-0 gap-1 border-b border-edge px-3" role="tablist" aria-label="Mode database">
        {MODES.map((m) => (
          <button key={m.id} role="tab" aria-selected={mode === m.id} onClick={() => setMode(m.id)}
            className={`flex h-9 items-center gap-1.5 px-3 text-[11.5px] transition-colors ${mode === m.id ? 'border-b-2 border-accent text-body' : 'text-quiet hover:text-body'}`}>
            <Icon name={m.icon} size={12} /> {m.label}
          </button>
        ))}
      </nav>

      {toast && <div className="shrink-0 border-b border-success/30 bg-success-soft px-4 py-2 text-[11.5px] text-body">{toast}</div>}

      <div className="flex min-h-0 flex-1">
        {/* Sidebar tabel — seperti SQL client */}
        <aside className="flex w-[230px] shrink-0 flex-col border-r border-edge max-md:hidden">
          <div className="p-2">
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Cari tabel…" aria-label="Cari tabel"
              className="h-8 w-full rounded border border-edge bg-ink px-2 text-[11.5px] text-body outline-none placeholder:text-quiet focus:border-accent" />
          </div>
          <ul className="vb-scroll min-h-0 flex-1 overflow-y-auto px-1 pb-2">
            {filtered.map((t) => (
              <li key={t.name}>
                <button onClick={() => { setPage(0); setSearch(''); void loadTable(t.name, '', 0) }}
                  aria-current={selected === t.name}
                  className={`mb-0.5 flex w-full items-center gap-2 rounded px-2 py-1.5 text-left font-mono text-[11.5px] transition-colors ${selected === t.name ? 'bg-accent/15 text-body' : 'text-quiet hover:bg-surface hover:text-body'}`}>
                  <Icon name="table" size={12} />
                  <span className="truncate">{t.name}</span>
                </button>
              </li>
            ))}
            {!filtered.length && <li className="px-2 py-2 text-[11px] text-quiet">Tidak ada tabel.</li>}
          </ul>
        </aside>

        {/* Konten */}
        <main className="vb-scroll min-h-0 min-w-0 flex-1 overflow-auto p-4 max-md:p-3">
          {loading && <p className="text-[12px] text-quiet">Membaca database…</p>}
          {error && <p className="rounded border border-danger/30 bg-danger-soft px-3 py-2 text-[12px] text-body">{error}</p>}

          {!loading && !error && mode === 'browse' && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-mono text-[13px] text-body">{selected || (tables.length === 0 ? 'Belum ada tabel' : 'Pilih tabel')}</h2>
                {detail?.total !== undefined && <span className="text-[11px] text-quiet">{detail.total} baris</span>}
                <form onSubmit={submitSearch} className="ml-auto flex gap-1.5">
                  <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Cari data…" aria-label="Cari data"
                    className="h-8 w-[170px] rounded border border-edge bg-ink px-2 text-[11.5px] text-body outline-none placeholder:text-quiet focus:border-accent" />
                  <button className="h-8 rounded border border-edge px-2.5 text-[11px] text-body hover:border-accent">Cari</button>
                </form>
              </div>

              {tables.length === 0 && (
                <div className="rounded border border-edge bg-ink p-4">
                  <h3 className="font-display text-[13px] text-body">Belum ada tabel di database ini.</h3>
                  <p className="mt-1 text-[12px] leading-relaxed text-quiet">Database proyek masih kosong — aplikasi belum membuat tabel apa pun. Buat tabel lewat SQL Editor, contoh:</p>
                  <pre className="mt-2 overflow-x-auto rounded border border-edge bg-surface p-2 font-mono text-[11.5px] text-body">CREATE TABLE users (id serial primary key, email text unique);</pre>
                  <p className="mt-2 text-[12px] text-quiet">Atau minta agent membuat fitur yang menyimpan data (kursus, produk, tiket) — tabel dibuat otomatis saat aplikasi dibangun.</p>
                </div>
              )}

              {/* mobile table picker */}
              <select value={selected || ''} onChange={(e) => { setPage(0); setSearch(''); void loadTable(e.target.value, '', 0) }}
                aria-label="Pilih tabel" className="h-8 w-full rounded border border-edge bg-ink px-2 text-[11.5px] text-body md:hidden">
                {tables.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
              </select>

              {detailLoading && <p className="text-[11.5px] text-quiet">Memuat data…</p>}
              {detail?.error && <p className="rounded border border-danger/30 bg-danger-soft px-3 py-2 text-[11.5px] text-body">{detail.error}</p>}
              {detail?.rows && (
                <>
                  <div className="vb-scroll max-h-[62vh] overflow-auto rounded border border-edge" title="Geser horizontal untuk melihat semua kolom">
                    <table className="w-max border-collapse text-[12px]">
                      <thead>
                        <tr>{(detail.columns || []).map((c) => (
                          <th key={c.name} className="sticky top-0 z-10 whitespace-nowrap border-b border-r border-edge bg-ink px-2.5 py-2 text-left font-medium text-body">
                            {c.name}<span className="ml-1 font-normal text-quiet">{c.type}</span>
                          </th>
                        ))}</tr>
                      </thead>
                      <tbody>
                        {detail.rows.map((row, i) => (
                          <tr key={i} className="hover:bg-ink/50">
                            {(detail.columns || []).map((c) => {
                              const cell = cellText((row as Record<string, unknown>)[c.name])
                              return (
                                <td key={c.name} className="max-w-[220px] border-b border-r border-edge px-2.5 py-1.5 align-top">
                                  <span className={`block max-w-[210px] truncate ${cell.null ? 'italic text-quiet' : 'text-body'}`} title={cell.text}>{cell.text}</span>
                                </td>
                              )
                            })}
                          </tr>
                        ))}
                        {!detail.rows.length && (
                          <tr><td colSpan={(detail.columns || []).length || 1} className="border border-edge px-3 py-4 text-center text-[11.5px] text-quiet">Tabel kosong.</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex items-center gap-2 text-[10.5px] text-quiet">
                    <button disabled={page <= 0} onClick={() => { const p = Math.max(0, page - 1); setPage(p); void loadTable(selected || '', search, p) }}
                      className="h-7 rounded border border-edge px-2.5 disabled:opacity-40">‹ Sebelumnya</button>
                    <span>Halaman {(detail.page || 0) + 1} / {detail.pageCount || 1}</span>
                    <button disabled={(detail.page || 0) + 1 >= (detail.pageCount || 1)} onClick={() => { const p = page + 1; setPage(p); void loadTable(selected || '', search, p) }}
                      className="h-7 rounded border border-edge px-2.5 disabled:opacity-40">Berikutnya ›</button>
                  </div>
                </>
              )}
            </div>
          )}

          {!loading && !error && mode === 'sql' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h2 className="font-display text-[14px] text-body">SQL Editor</h2>
                  <p className="text-[11px] text-quiet">SELECT untuk membaca · INSERT/UPDATE/DELETE untuk mengedit data langsung di {database || 'database proyek'}</p>
                </div>
                <button onClick={() => setMode('browse')} className="shrink-0 rounded border border-edge px-2.5 py-1.5 text-[11px] text-quiet hover:border-accent hover:text-body">← Data</button>
              </div>
              <textarea value={sql} onChange={(e) => setSql(e.target.value)} spellCheck={false}
                onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') void runSql() }}
                aria-label="Editor SQL"
                className="vb-scroll h-40 w-full resize-y rounded border border-edge bg-ink p-3 font-mono text-[12px] leading-relaxed text-body outline-none placeholder:text-quiet focus:border-accent"
                placeholder="SELECT * FROM users LIMIT 20" />
              <div className="flex flex-wrap items-center gap-2">
                <button onClick={() => void runSql()} disabled={running || !sql.trim()}
                  className="flex h-8 items-center gap-1.5 rounded bg-accent px-3 text-[11.5px] text-on-accent transition-opacity disabled:opacity-40">
                  <Icon name="run" size={12} /> {running ? 'Menjalankan…' : 'Jalankan (Ctrl+Enter)'}
                </button>
                <div className="flex gap-1.5">
                  {['SELECT * FROM ', 'INSERT INTO ', 'UPDATE ', 'DELETE FROM '].map((s) => (
                    <button key={s} onClick={() => setSql(s)} className="h-8 rounded border border-edge px-2 font-mono text-[10.5px] text-quiet hover:border-accent hover:text-body">{s.trim()}</button>
                  ))}
                </div>
              </div>
              {sqlError && <p className="rounded border border-danger/30 bg-danger-soft px-3 py-2 text-[11.5px] text-body">{sqlError}</p>}
              {result?.command && <p className="rounded border border-success/30 bg-success-soft px-3 py-2 text-[11.5px] text-body">{result.command}</p>}
              {result && result.columns.length > 0 && (
                <div className="vb-scroll max-h-[52vh] overflow-auto rounded border border-edge">
                  <table className="w-max border-collapse text-[12px]">
                    <thead><tr>{result.columns.map((c) => (
                      <th key={c} className="sticky top-0 z-10 whitespace-nowrap border-b border-r border-edge bg-ink px-2.5 py-2 text-left font-medium text-body">{c}</th>
                    ))}</tr></thead>
                    <tbody>
                      {result.rows.map((row, i) => (
                        <tr key={i} className="hover:bg-ink/50">{result.columns.map((c) => {
                          const cell = cellText(row[c])
                          return <td key={c} className="max-w-[220px] border-b border-r border-edge px-2.5 py-1.5"><span className={`block max-w-[210px] truncate ${cell.null ? 'italic text-quiet' : ''}`} title={cell.text}>{cell.text}</span></td>
                        })}</tr>
                      ))}
                      {!result.rows.length && <tr><td colSpan={result.columns.length || 1} className="px-3 py-3 text-center text-[11.5px] text-quiet">Tanpa baris hasil.</td></tr>}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {!loading && !error && mode === 'structure' && (
            <div className="space-y-3">
              {selected ? (
                <h2 className="font-display text-[14px] text-body">Struktur · <span className="font-mono text-[12px]">{selected}</span></h2>
              ) : (
                <h2 className="font-display text-[14px] text-body">Struktur</h2>
              )}
              {!selected && <p className="text-[12px] text-quiet">Belum ada tabel yang dipilih — pilih tabel di sidebar untuk melihat strukturnya.</p>}
              {detailLoading && !detail?.columns && <p className="text-[11.5px] text-quiet">Memuat struktur…</p>}
              {detail?.error && <p className="rounded border border-danger/30 bg-danger-soft px-3 py-2 text-[11.5px] text-body">{detail.error}</p>}
              {detail?.columns && (
                <div className="vb-scroll overflow-auto rounded border border-edge">
                  <table className="w-max border-collapse text-[12px]">
                    <thead><tr>{['Kolom', 'Tipe', 'Nullable', 'Default'].map((h) => (
                      <th key={h} className="sticky top-0 border-b border-r border-edge bg-ink px-2.5 py-2 text-left font-medium text-body">{h}</th>
                    ))}</tr></thead>
                    <tbody>{detail.columns.map((c: ColumnInfo) => (
                      <tr key={c.name} className="hover:bg-ink/50">
                        <td className="border-b border-r border-edge px-2.5 py-1.5 font-mono text-body">{c.name}</td>
                        <td className="border-b border-r border-edge px-2.5 py-1.5 text-quiet">{c.type}</td>
                        <td className="border-b border-r border-edge px-2.5 py-1.5 text-quiet">{c.nullable ? 'Ya' : 'Tidak'}</td>
                        <td className="border-b border-r border-edge px-2.5 py-1.5 font-mono text-quiet">{c.default || '—'}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {!loading && !error && mode === 'export' && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <div>
                  <h2 className="font-display text-[14px] text-body">Ekspor database</h2>
                  <p className="text-[11px] text-quiet">Schema + data dalam bentuk SQL, siap dipakai ulang.</p>
                </div>
                <div className="ml-auto flex gap-2">
                  <button onClick={() => void doExport()} disabled={exportBusy}
                    className="h-8 rounded border border-edge px-3 text-[11px] text-body hover:border-accent disabled:opacity-40">{exportBusy ? 'Menyusun…' : 'Buat SQL'}</button>
                  <button onClick={download} disabled={!exportText}
                    className="flex h-8 items-center gap-1.5 rounded bg-accent px-3 text-[11px] text-on-accent disabled:opacity-40">
                    <Icon name="download" size={12} /> Unduh .sql
                  </button>
                </div>
              </div>
              <textarea value={exportText} readOnly aria-label="Hasil ekspor SQL"
                className="vb-scroll h-[55vh] w-full resize-y rounded border border-edge bg-ink p-3 font-mono text-[11px] leading-relaxed text-body outline-none placeholder:text-quiet"
                placeholder="Klik 'Buat SQL' untuk menghasilkan dump database." />
            </div>
          )}
        </main>
      </div>
    </div>
  )
}

export default DatabasePage

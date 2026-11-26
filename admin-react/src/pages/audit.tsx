import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { useToast } from '../lib/toast'
import { PageHeader } from '../components/PageHeader'
import { Table, Th, Td, EmptyRow } from '../components/Table'
import { btnOutlineLg } from '../components/DFormat'
import { fmtDate, fmtNum } from '../components/BFormat'
import { Badge } from '../components/Badge'
import { SearchInput } from '../components/SearchInput'
import { Select } from '../components/Select'
import { Spinner } from '../components/Spinner'

interface AuditLog {
  id: number
  admin_email: string | null
  action: string
  target_type: string | null
  target_id: string | null
  detail: string | null
  created_at: number
}

export default function AuditPage() {
  const toast = useToast()
  const [logs, setLogs] = useState<AuditLog[] | null>(null)
  const [searchInput, setSearchInput] = useState('')
  const [action, setAction] = useState('')
  const actionsCache = useRef<string[]>([])

  const load = useCallback(
    async (q: string, act: string) => {
      const params = new URLSearchParams({ limit: '100' })
      if (q) params.set('q', q)
      if (act) params.set('action', act)
      try {
        const data = await api.get<{ logs: AuditLog[] }>(
          `/api/admin/audit?${params.toString()}`,
        )
        const next = data.logs || []
        setLogs(next)
        /* Daftar aksi di-cache dari muatan tanpa filter, supaya dropdown
           tidak menyusut jadi satu opsi saat sedang memfilter per aksi. */
        const actions = [...new Set(next.map((l) => l.action))].sort()
        if (!act && actions.length) actionsCache.current = actions
      } catch (e) {
        toast.error(e instanceof ApiError ? e.message : 'Gagal memuat log audit.')
      }
    },
    [toast],
  )

  useEffect(() => {
    load('', '')
  }, [load])

  const subtitle =
    logs === null ? 'Log audit.' : `Log audit — ${fmtNum(logs.length)} entri log`

  const currentActions =
    logs === null ? [] : [...new Set(logs.map((l) => l.action))].sort()
  const options = actionsCache.current.length
    ? actionsCache.current
    : currentActions

  function runSearch(q: string, act: string) {
    load(q, act)
  }

  function onFilterChange(v: string) {
    setAction(v)
    runSearch(searchInput.trim(), v)
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Log Audit"
        description={subtitle}
        actions={
          <div className="flex flex-wrap gap-2">
            <div className="w-full max-w-[220px] sm:w-auto">
              <Select
                value={action}
                onChange={(e) => onFilterChange(e.target.value)}
                aria-label="Filter aksi"
              >
                <option value="">Semua aksi</option>
                {options.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </Select>
            </div>
            <form className="flex w-full max-w-[320px] gap-2 sm:w-auto" 
              onSubmit={(e) => {
                e.preventDefault()
                runSearch(searchInput.trim(), action)
              }}
            >
              <div className="min-w-0 flex-1">
                <SearchInput
                  value={searchInput}
                  onChange={setSearchInput}
                  placeholder="Cari admin, aksi, target…"
                  ariaLabel="Cari log"
                />
              </div>
              <button type="submit" aria-label="Cari" className={`shrink-0 ${btnOutlineLg}`}>
                Cari
              </button>
            </form>
          </div>
        }
      />

      {logs === null ? (
        <Spinner label="Memuat log audit…" />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Waktu</Th>
              <Th>Admin</Th>
              <Th>Aksi</Th>
              <Th>Target</Th>
              <Th>Detail</Th>
            </tr>
          </thead>
          <tbody>
            {logs.length === 0 ? (
              <EmptyRow colSpan={5}>Tidak ada log yang cocok.</EmptyRow>
            ) : (
              logs.map((l) => (
                <tr key={l.id}>
                  <Td className="whitespace-nowrap">{fmtDate(l.created_at)}</Td>
                  <Td>{l.admin_email || '–'}</Td>
                  <Td>
                    <Badge tone="default">{l.action}</Badge>
                  </Td>
                  <Td>
                    {l.target_type || ''}
                    {l.target_id ? (
                      <>
                        <br />
                        <span className="font-mono text-xs text-muted">{l.target_id}</span>
                      </>
                    ) : null}
                  </Td>
                  <Td className="min-w-[220px] break-words">
                    {l.detail || '–'}
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </Table>
      )}
    </div>
  )
}

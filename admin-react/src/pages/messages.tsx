import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, ApiError } from '../lib/api'
import { useToast } from '../lib/toast'
import { PageHeader } from '../components/PageHeader'
import { Table, Th, Td, EmptyRow } from '../components/Table'
import { btnOutlineLg } from '../components/DFormat'
import { Badge } from '../components/Badge'
import { Spinner } from '../components/Spinner'
import { SearchInput } from '../components/SearchInput'
import { fmtDate } from '../components/BFormat'

interface MessageRow {
  id: number
  project_id: string
  role: string
  excerpt: string
  created_at: number
  project_name: string | null
  owner_email: string | null
}

function roleTone(role: string): 'accent' | 'success' | 'default' {
  if (role === 'user') return 'accent'
  if (role === 'assistant') return 'success'
  return 'default'
}

export default function MessagesPage() {
  const toast = useToast()
  const [messages, setMessages] = useState<MessageRow[] | null>(null)
  const [query, setQuery] = useState('')

  const load = useCallback(
    async (q: string) => {
      try {
        const suffix = q ? `?q=${encodeURIComponent(q)}&limit=100` : '?limit=100'
        const data = await api.get<{ messages: MessageRow[] }>(`/api/admin/messages${suffix}`)
        setMessages(data.messages || [])
      } catch (e) {
        toast.error(e instanceof ApiError ? e.message : 'Gagal memuat pesan.')
      }
    },
    [toast],
  )

  useEffect(() => {
    void load('')
  }, [load])

  const runSearch = (e?: FormEvent) => {
    e?.preventDefault()
    void load(query.trim())
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Pesan"
        description="Semua pesan chat di semua proyek."
        actions={
          <form onSubmit={runSearch} className="flex w-full gap-2 sm:w-[320px]">
            <div className="min-w-0 flex-1">
              <SearchInput value={query} onChange={setQuery} placeholder="Cari isi pesan…" ariaLabel="Cari pesan" />
            </div>
            <button type="submit" className={`shrink-0 ${btnOutlineLg}`}>
              Cari
            </button>
          </form>
        }
      />
      {messages === null ? (
        <Spinner />
      ) : (
        <Table>
            <thead>
              <tr>
                <Th>Proyek</Th>
                <Th>Pemilik</Th>
                <Th>Peran</Th>
                <Th>Isi</Th>
                <Th>Waktu</Th>
              </tr>
            </thead>
            <tbody>
              {messages.length === 0 ? (
                <EmptyRow colSpan={5}>Tidak ada pesan.</EmptyRow>
              ) : (
                messages.map((m) => (
                  <tr key={m.id}>
                    <Td>
                      <strong>{m.project_name}</strong>
                      <br />
                      <span className="font-mono text-xs text-muted">{m.project_id}</span>
                    </Td>
                    <Td>{m.owner_email || '–'}</Td>
                    <Td>
                      <Badge tone={roleTone(m.role)}>{m.role}</Badge>
                    </Td>
                    <Td className="min-w-[300px] break-words">{m.excerpt}</Td>
                    <Td>{fmtDate(m.created_at)}</Td>
                  </tr>
                ))
              )}
            </tbody>
          </Table>
      )}
    </div>
  )
}

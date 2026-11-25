import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useToast } from '../lib/toast'
import { PageHeader } from '../components/PageHeader'
import { Card } from '../components/Card'
import { Table, Th, Td } from '../components/Table'
import { Badge } from '../components/Badge'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { Spinner } from '../components/Spinner'
import { errMessage, fmtDateShort, fmtNum } from '../components/BFormat'

interface AdminProject {
  id: string
  name: string
  status: string
  slug: string | null
  created_at: number
  updated_at: number
  owner_id: number | null
  owner_email: string | null
  owner_name: string | null
  messages: number
  files: number
  last_build_ok: boolean | null
}

function statusTone(s: string): 'success' | 'accent' | 'warning' | 'danger' | 'default' {
  if (s === 'idle') return 'success'
  if (s === 'working') return 'accent'
  if (s === 'building') return 'warning'
  if (s === 'error') return 'danger'
  return 'default'
}

const btnPrimary =
  'rounded-lg border border-accent/40 bg-surface px-3 py-1.5 text-sm font-medium text-accent hover:bg-accent-soft'
const btnDanger =
  'rounded-lg border border-danger/40 bg-surface px-3 py-1.5 text-sm font-medium text-danger hover:bg-danger-soft disabled:opacity-50'

export default function ProjectsPage() {
  const toast = useToast()
  const [rows, setRows] = useState<AdminProject[] | null>(null)
  const [pending, setPending] = useState<AdminProject | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ projects: AdminProject[] }>('/api/admin/projects')
      setRows(data.projects)
    } catch (e) {
      toast.error(errMessage(e))
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load])

  const confirmDelete = async () => {
    if (!pending) return
    setBusy(true)
    try {
      await api.del(`/api/admin/projects/${encodeURIComponent(pending.id)}`)
      toast.success('Proyek dihapus.')
      setPending(null)
      await load()
    } catch (e) {
      toast.error(errMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Proyek"
        description={rows === null ? '' : `${fmtNum(rows.length)} proyek dari semua pengguna`}
      />
      <Card>
        {rows === null ? (
          <Spinner />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Proyek</Th>
                <Th>Pemilik</Th>
                <Th>Status</Th>
                <Th>Pesan</Th>
                <Th>File</Th>
                <Th>Slug</Th>
                <Th>Diperbarui</Th>
                <Th className="text-right">Aksi</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <Td>
                    <strong>{p.name}</strong>
                    <br />
                    <small className="font-mono text-muted">{p.id}</small>
                  </Td>
                  <Td>{p.owner_email || 'tanpa pemilik'}</Td>
                  <Td>
                    <Badge tone={statusTone(p.status)}>{p.status}</Badge>
                  </Td>
                  <Td>{fmtNum(p.messages)}</Td>
                  <Td>{fmtNum(p.files)}</Td>
                  <Td>
                    {p.slug ? (
                      <a href={`/p/${p.slug}`} target="_blank" rel="noopener" className="text-accent hover:underline">
                        {p.slug}
                      </a>
                    ) : (
                      <span className="text-muted">–</span>
                    )}
                  </Td>
                  <Td>{fmtDateShort(p.updated_at)}</Td>
                  <Td className="text-right whitespace-nowrap">
                    <span className="inline-flex gap-2">
                      <a href={`/proyek/${p.id}`} className={btnPrimary}>
                        Buka
                      </a>
                      <button type="button" className={btnDanger} onClick={() => setPending(p)}>
                        Hapus
                      </button>
                    </span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <ConfirmDialog
        open={pending !== null}
        title="Hapus proyek"
        message={
          pending
            ? `Hapus proyek "${pending.name}" beserta semua file, pesan, dan build-nya? Tindakan ini tidak bisa dibatalkan.`
            : ''
        }
        confirmLabel="Ya, hapus"
        loading={busy}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPending(null)}
      />
    </div>
  )
}

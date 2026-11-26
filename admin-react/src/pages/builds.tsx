import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { useToast } from '../lib/toast'
import { PageHeader } from '../components/PageHeader'
import { Table, Th, Td, EmptyRow } from '../components/Table'
import { btnOutlineSm } from '../components/DFormat'
import { Badge } from '../components/Badge'
import { Spinner } from '../components/Spinner'
import { Modal } from '../components/Modal'
import { fmtNum, fmtDate } from '../components/BFormat'

interface BuildRow {
  id: number
  project_id: string
  ok: number
  log: string | null
  created_at: number
  project_name: string | null
  owner_email: string | null
}

export default function BuildsPage() {
  const toast = useToast()
  const [builds, setBuilds] = useState<BuildRow[] | null>(null)
  const [logBuild, setLogBuild] = useState<BuildRow | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ builds: BuildRow[] }>('/api/admin/builds?limit=100')
      setBuilds(data.builds || [])
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Gagal memuat build.')
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="space-y-4">
      <PageHeader
        title="Build"
        description={
          builds === null
            ? 'Riwayat build produksi semua proyek.'
            : `Riwayat build produksi semua proyek — ${fmtNum(builds.length)} build terakhir`
        }
      />
      {builds === null ? (
        <Spinner />
      ) : (
        <Table>
            <thead>
              <tr>
                <Th>#</Th>
                <Th>Proyek</Th>
                <Th>Pemilik</Th>
                <Th>Hasil</Th>
                <Th>Waktu</Th>
                <Th className="text-right">Log</Th>
              </tr>
            </thead>
            <tbody>
              {builds.length === 0 ? (
                <EmptyRow colSpan={6}>Belum ada build.</EmptyRow>
              ) : (
                builds.map((b) => (
                  <tr key={b.id}>
                    <Td className="font-mono">{b.id}</Td>
                    <Td>
                      <strong>{b.project_name}</strong>
                      <br />
                      <span className="font-mono text-xs text-muted">{b.project_id}</span>
                    </Td>
                    <Td>{b.owner_email || '–'}</Td>
                    <Td>
                      {b.ok ? <Badge tone="success">Berhasil</Badge> : <Badge tone="danger">Gagal</Badge>}
                    </Td>
                    <Td>{fmtDate(b.created_at)}</Td>
                    <Td className="text-right">
                      <button
                        type="button"
                        onClick={() => setLogBuild(b)}
                        className={btnOutlineSm}
                      >
                        Lihat log
                      </button>
                    </Td>
                  </tr>
                ))
              )}
            </tbody>
          </Table>
      )}

      <Modal
        open={logBuild !== null}
        onClose={() => setLogBuild(null)}
        title={logBuild ? `Log build #${logBuild.id} — ${logBuild.project_name}` : 'Log build'}
        size="lg"
      >
        <pre className="max-h-[60vh] overflow-auto text-sm whitespace-pre-wrap">{logBuild?.log || '(log kosong)'}</pre>
      </Modal>
    </div>
  )
}

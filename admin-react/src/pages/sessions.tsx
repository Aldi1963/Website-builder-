import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { useToast } from '../lib/toast'
import { PageHeader } from '../components/PageHeader'
import { Badge } from '../components/Badge'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { Spinner } from '../components/Spinner'
import { Table, Th, Td } from '../components/Table'
import { btnOutlineDangerSm, fmtDate } from '../components/DFormat'

interface SessionRow {
  hash: string
  user_id: number
  created_at: number
  expires_at: number
  email: string | null
  name: string | null
  active: boolean
}

export default function SessionsPage() {
  const toast = useToast()
  const [sessions, setSessions] = useState<SessionRow[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [revokeTarget, setRevokeTarget] = useState<SessionRow | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ sessions: SessionRow[] }>('/api/admin/sessions')
      setSessions(data.sessions)
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Gagal memuat sesi.')
      setSessions([])
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load])

  async function doRevoke() {
    if (!revokeTarget) return
    setBusy(true)
    try {
      await api.del(`/api/admin/sessions/${encodeURIComponent(revokeTarget.hash)}`)
      toast.success('Sesi dicabut.')
      setRevokeTarget(null)
      await load()
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Gagal mencabut sesi.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Sesi"
        description="Sesi login aktif dan kedaluwarsa. Hash sesi hanya ditampilkan 12 karakter pertama."
      />
      {sessions === null ? (
        <Spinner />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Pengguna</Th>
              <Th>Dibuat</Th>
              <Th>Kedaluwarsa</Th>
              <Th>Status</Th>
              <Th>Hash</Th>
              <Th className="text-right">Aksi</Th>
            </tr>
          </thead>
          <tbody>
            {sessions.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-3 text-sm text-muted">
                  Tidak ada sesi.
                </td>
              </tr>
            ) : (
              sessions.map((s) => (
                <tr key={s.hash}>
                  <Td>
                    {s.name || s.email || '–'}
                    {s.email ? (
                      <>
                        <br />
                        <small className="text-muted">{s.email}</small>
                      </>
                    ) : null}
                  </Td>
                  <Td className="whitespace-nowrap">{fmtDate(s.created_at)}</Td>
                  <Td className="whitespace-nowrap">{fmtDate(s.expires_at)}</Td>
                  <Td>
                    {s.active ? (
                      <Badge tone="success">Aktif</Badge>
                    ) : (
                      <Badge tone="default">Kedaluwarsa</Badge>
                    )}
                  </Td>
                  <Td className="font-mono">{s.hash}</Td>
                  <Td className="text-right">
                    {s.active ? (
                      <button
                        type="button"
                        className={btnOutlineDangerSm}
                        disabled={busy}
                        onClick={() => setRevokeTarget(s)}
                      >
                        Cabut
                      </button>
                    ) : (
                      <span className="text-sm text-muted">–</span>
                    )}
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </Table>
      )}

      <ConfirmDialog
        open={revokeTarget !== null}
        title="Cabut sesi"
        message={`Cabut sesi login milik ${revokeTarget?.email ?? ''}? Pengguna harus masuk lagi.`}
        confirmLabel="Ya, cabut"
        loading={busy}
        onConfirm={() => void doRevoke()}
        onCancel={() => setRevokeTarget(null)}
      />
    </div>
  )
}

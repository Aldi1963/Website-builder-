import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useToast } from '../lib/toast'
import { PageHeader } from '../components/PageHeader'
import { Card } from '../components/Card'
import { Table, Th, Td } from '../components/Table'
import { Badge } from '../components/Badge'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { Spinner } from '../components/Spinner'
import { avatarInitial, errMessage, fmtDateShort, fmtNum, timeAgo } from '../components/BFormat'

interface AdminUser {
  id: number
  email: string
  name: string
  created_at: number
  disabled: boolean
  projects: number
  messages: number
  tokens: number
  last_seen: number | null
  plan_id: string | null
  plan_name: string | null
  plan_limit: number
  isAdmin: boolean
}

type Pending =
  | { kind: 'toggle'; user: AdminUser; disable: boolean }
  | { kind: 'delete'; user: AdminUser }
  | null

const btnWarn =
  'rounded-lg border border-warning/40 bg-surface px-3 py-1.5 text-sm font-medium text-warning hover:bg-warning-soft disabled:opacity-50'
const btnDanger =
  'rounded-lg border border-danger/40 bg-surface px-3 py-1.5 text-sm font-medium text-danger hover:bg-danger-soft disabled:opacity-50'

export default function UsersPage() {
  const toast = useToast()
  const { user: me } = useAuth()
  const [rows, setRows] = useState<AdminUser[] | null>(null)
  const [pending, setPending] = useState<Pending>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ adminEmail: string | null; users: AdminUser[] }>('/api/admin/users')
      setRows(data.users)
    } catch (e) {
      toast.error(errMessage(e))
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load])

  const confirmPending = async () => {
    if (!pending) return
    setBusy(true)
    try {
      if (pending.kind === 'toggle') {
        const { user, disable } = pending
        await api.patch(`/api/admin/users/${encodeURIComponent(String(user.id))}`, { disabled: disable })
        toast.success(`Akun ${user.email} ${disable ? 'dinonaktifkan' : 'diaktifkan'}.`)
      } else {
        const { user } = pending
        const res = await api.del<{ ok: boolean; deletedProjects: number }>(
          `/api/admin/users/${encodeURIComponent(String(user.id))}`,
        )
        toast.success(`Akun ${user.email} dihapus (${fmtNum(res.deletedProjects)} proyek ikut terhapus).`)
      }
      setPending(null)
      await load()
    } catch (e) {
      toast.error(errMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const confirmTitle =
    pending?.kind === 'toggle'
      ? pending.disable
        ? 'Nonaktifkan akun'
        : 'Aktifkan akun'
      : 'Hapus pengguna'
  const confirmMessage =
    pending?.kind === 'toggle'
      ? `${pending.disable ? 'Nonaktifkan' : 'Aktifkan'} akun ${pending.user.email}?${
          pending.disable ? ' Akun tidak bisa masuk sampai diaktifkan lagi.' : ''
        }`
      : pending
        ? `Hapus akun ${pending.user.email} beserta SEMUA proyeknya? Tindakan ini tidak bisa dibatalkan.`
        : ''
  const confirmLabel =
    pending?.kind === 'toggle' ? (pending.disable ? 'Ya, nonaktifkan' : 'Ya, aktifkan') : 'Ya, hapus'

  return (
    <div className="space-y-4">
      <PageHeader
        title="Pengguna"
        description={rows === null ? '' : `${fmtNum(rows.length)} akun terdaftar`}
      />
      <Card>
        {rows === null ? (
          <Spinner />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Pengguna</Th>
                <Th>Dibuat</Th>
                <Th>Proyek</Th>
                <Th>Pesan</Th>
                <Th>Token</Th>
                <Th>Plan</Th>
                <Th>Terakhir aktif</Th>
                <Th>Status</Th>
                <Th className="text-right">Aksi</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => {
                const isSelf = me ? u.email.toLowerCase() === me.email.toLowerCase() : false
                return (
                  <tr key={u.id}>
                    <Td>
                      <div className="flex items-center gap-2">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-sm font-semibold text-accent">
                          {avatarInitial(u.name, u.email)}
                        </span>
                        <span>
                          {u.name || ''}
                          <br />
                          <small className="text-muted">{u.email}</small>
                        </span>
                      </div>
                    </Td>
                    <Td>{fmtDateShort(u.created_at)}</Td>
                    <Td>{fmtNum(u.projects)}</Td>
                    <Td>{fmtNum(u.messages)}</Td>
                    <Td>{fmtNum(u.tokens)}</Td>
                    <Td>
                      {u.plan_name ? <Badge tone="info">{u.plan_name}</Badge> : <span className="text-muted">–</span>}
                    </Td>
                    <Td>{timeAgo(u.last_seen)}</Td>
                    <Td>
                      {u.isAdmin ? (
                        <Badge tone="accent">Admin</Badge>
                      ) : u.disabled ? (
                        <Badge tone="default">Nonaktif</Badge>
                      ) : (
                        <Badge tone="success">Aktif</Badge>
                      )}
                    </Td>
                    <Td className="text-right whitespace-nowrap">
                      {isSelf ? (
                        <span className="text-sm text-muted">akun ini</span>
                      ) : (
                        <span className="inline-flex gap-2">
                          <button
                            type="button"
                            className={btnWarn}
                            onClick={() => setPending({ kind: 'toggle', user: u, disable: !u.disabled })}
                          >
                            {u.disabled ? 'Aktifkan' : 'Nonaktifkan'}
                          </button>
                          <button
                            type="button"
                            className={btnDanger}
                            onClick={() => setPending({ kind: 'delete', user: u })}
                          >
                            Hapus
                          </button>
                        </span>
                      )}
                    </Td>
                  </tr>
                )
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <ConfirmDialog
        open={pending !== null}
        title={confirmTitle}
        message={confirmMessage}
        confirmLabel={confirmLabel}
        loading={busy}
        onConfirm={() => void confirmPending()}
        onCancel={() => setPending(null)}
      />
    </div>
  )
}

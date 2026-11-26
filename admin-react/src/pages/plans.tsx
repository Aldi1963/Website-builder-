import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useToast } from '../lib/toast'
import { PageHeader } from '../components/PageHeader'
import { Card } from '../components/Card'
import { Table, Th, Td, EmptyRow } from '../components/Table'
import { Badge } from '../components/Badge'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { Select } from '../components/Select'
import { Spinner } from '../components/Spinner'
import { CFormDialog, type CFormField, type CFormValues } from '../components/CFormDialog'
import { btnOutlineDangerSm, btnOutlineSm, btnPrimary } from '../components/DFormat'
import { errMessage, fmtNum, fmtRp } from '../components/BFormat'

interface Plan {
  id: string
  name: string
  token_limit: number
  price_idr: number
  description: string | null
  monthly_credits: number
  created_at: number
  updated_at: number
  users: number
}

interface PlanUser {
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

const PLAN_FIELDS: CFormField[] = [
  { name: 'name', label: 'Nama plan', required: true },
  { name: 'tokenLimit', label: 'Kuota token (0 = tanpa batas)', type: 'number', min: 0, help: 'Jumlah token maksimum per pengguna.' },
  { name: 'priceIdr', label: 'Harga (Rp)', type: 'number', min: 0 },
  { name: 'monthlyCredits', label: 'Credit bulanan', type: 'number', min: 0, help: 'Jatah credit yang diberikan tiap bulan ke pengguna plan ini.' },
  { name: 'description', label: 'Keterangan', type: 'textarea' },
]

interface PlansPageProps {
  /** Disematkan di halaman gabungan: PageHeader induk disembunyikan. */
  embedded?: boolean
}

export default function PlansPage({ embedded = false }: PlansPageProps) {
  const toast = useToast()
  const [plans, setPlans] = useState<Plan[] | null>(null)
  const [users, setUsers] = useState<PlanUser[] | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [editPlan, setEditPlan] = useState<Plan | null>(null)
  const [deletePlan, setDeletePlan] = useState<Plan | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const [plansData, usersData] = await Promise.all([
        api.get<{ plans: Plan[] }>('/api/admin/plans'),
        api.get<{ users: PlanUser[] }>('/api/admin/users'),
      ])
      setPlans(plansData.plans || [])
      setUsers(usersData.users)
    } catch (e) {
      toast.error(errMessage(e))
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load])

  const submitAdd = async (vals: CFormValues) => {
    setAddOpen(false)
    if (!String(vals.name || '').trim()) return
    try {
      await api.post('/api/admin/plans', {
        name: vals.name,
        tokenLimit: vals.tokenLimit,
        priceIdr: vals.priceIdr,
        monthlyCredits: vals.monthlyCredits,
        description: vals.description,
      })
      toast.success('Plan dibuat.')
      await load()
    } catch (e) {
      toast.error(errMessage(e))
    }
  }

  const submitEdit = async (vals: CFormValues) => {
    const p = editPlan
    setEditPlan(null)
    if (!p) return
    try {
      await api.patch(`/api/admin/plans/${encodeURIComponent(p.id)}`, {
        name: vals.name,
        tokenLimit: vals.tokenLimit,
        priceIdr: vals.priceIdr,
        monthlyCredits: vals.monthlyCredits,
        description: vals.description,
      })
      toast.success('Plan diperbarui.')
      await load()
    } catch (e) {
      toast.error(errMessage(e))
    }
  }

  const confirmDelete = async () => {
    if (!deletePlan) return
    setBusy(true)
    try {
      await api.del(`/api/admin/plans/${encodeURIComponent(deletePlan.id)}`)
      toast.success('Plan dihapus.')
      setDeletePlan(null)
      await load()
    } catch (e) {
      toast.error(errMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const assignPlan = async (userId: number, planId: string | null) => {
    try {
      await api.post(`/api/admin/users/${encodeURIComponent(String(userId))}/plan`, { planId })
      toast.success('Plan pengguna diperbarui.')
      await load()
    } catch (e) {
      toast.error(errMessage(e))
      await load()
    }
  }

  return (
    <div className="space-y-4">
      {!embedded ? (
        <PageHeader
          title="Plan"
          description="Paket token untuk pengguna. Kuota dipakai untuk pemantauan — chat belum dibatasi kuota."
          actions={
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              className={btnPrimary}
            >
              Tambah Plan
            </button>
          }
        />
      ) : null}
      {plans === null ? (
        <Spinner />
      ) : (
        <Table>
            <thead>
              <tr>
                <Th>Nama</Th>
                <Th>Kuota Token</Th>
                <Th>Harga (Rp)</Th>
                <Th>Credit / Bln</Th>
                <Th>Pengguna</Th>
                <Th>Keterangan</Th>
                <Th className="text-right">Aksi</Th>
              </tr>
            </thead>
            <tbody>
              {plans.length ? (
                plans.map((p) => (
                  <tr key={p.id}>
                    <Td>
                      <strong>{p.name}</strong>
                      <br />
                      <span className="font-mono text-xs text-muted">{p.id}</span>
                    </Td>
                    <Td>
                      {p.token_limit > 0 ? (
                        fmtNum(p.token_limit)
                      ) : (
                        <Badge tone="success">Tanpa batas</Badge>
                      )}
                    </Td>
                    <Td>{fmtRp(p.price_idr)}</Td>
                    <Td>{fmtNum(p.monthly_credits)}</Td>
                    <Td>{fmtNum(p.users)}</Td>
                    <Td>{p.description || '–'}</Td>
                    <Td className="text-right whitespace-nowrap">
                      <span className="inline-flex gap-2">
                        <button type="button" className={btnOutlineSm} onClick={() => setEditPlan(p)}>
                          Ubah
                        </button>
                        <button type="button" className={btnOutlineDangerSm} onClick={() => setDeletePlan(p)}>
                          Hapus
                        </button>
                      </span>
                    </Td>
                  </tr>
                ))
              ) : (
                <EmptyRow colSpan={7}>Belum ada plan.</EmptyRow>
              )}
            </tbody>
          </Table>
        )}

      <Card title="Plan per Pengguna">
        {users === null ? (
          <Spinner />
        ) : (
          <Table bare>
            <thead>
              <tr>
                <Th>Pengguna</Th>
                <Th>Plan Saat Ini</Th>
                <Th>Token Dipakai</Th>
                <Th>Kuota</Th>
                <Th>Ubah Plan</Th>
              </tr>
            </thead>
            <tbody>
              {users.length === 0 ? (
                <EmptyRow colSpan={5}>Belum ada pengguna.</EmptyRow>
              ) : (
                users.map((u) => {
                const pct =
                  u.plan_limit > 0 ? Math.min(100, Math.round((u.tokens / u.plan_limit) * 100)) : null
                return (
                  <tr key={u.id}>
                    <Td>
                      {u.name || u.email}
                      <br />
                      <span className="text-xs text-muted">{u.email}</span>
                    </Td>
                    <Td>
                      {u.plan_name ? <Badge tone="info">{u.plan_name}</Badge> : <span className="text-muted">–</span>}
                    </Td>
                    <Td>{fmtNum(u.tokens)}</Td>
                    <Td>
                      {u.plan_limit > 0 && pct !== null ? (
                        <div>
                          <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-muted">
                            <div
                              className={`h-full rounded-full ${
                                pct >= 100 ? 'bg-danger' : pct >= 80 ? 'bg-warning' : 'bg-success'
                              }`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className="text-xs text-muted">
                            {fmtNum(u.tokens)} / {fmtNum(u.plan_limit)} ({pct}%)
                          </span>
                        </div>
                      ) : (
                        <span className="text-xs text-muted">{fmtNum(u.tokens)} dipakai · tanpa batas</span>
                      )}
                    </Td>
                    <Td>
                      <div className="max-w-[200px]">
                        <Select
                          value={u.plan_id ?? ''}
                          onChange={(e) => void assignPlan(u.id, e.target.value || null)}
                        >
                          <option value="">— Tanpa plan —</option>
                          {(plans || []).map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </Select>
                      </div>
                    </Td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </Table>
        )}
      </Card>

      <CFormDialog
        open={addOpen}
        title="Tambah plan"
        fields={[
          { name: 'name', label: 'Nama plan', required: true, help: 'cth. Pro, Starter, Enterprise' },
          { name: 'tokenLimit', label: 'Kuota token (0 = tanpa batas)', type: 'number', min: 0, value: 0, help: 'Jumlah token maksimum per pengguna.' },
          { name: 'priceIdr', label: 'Harga (Rp)', type: 'number', min: 0, value: 0 },
          { name: 'monthlyCredits', label: 'Credit bulanan', type: 'number', min: 0, value: 0, help: 'Jatah credit yang diberikan tiap bulan ke pengguna plan ini.' },
          { name: 'description', label: 'Keterangan', type: 'textarea' },
        ]}
        values={{}}
        onSubmit={(v) => void submitAdd(v)}
        onCancel={() => setAddOpen(false)}
      />
      <CFormDialog
        open={editPlan !== null}
        title="Ubah plan"
        fields={PLAN_FIELDS}
        values={
          editPlan
            ? {
                name: editPlan.name,
                tokenLimit: editPlan.token_limit,
                priceIdr: editPlan.price_idr,
                monthlyCredits: editPlan.monthly_credits,
                description: editPlan.description ?? '',
              }
            : {}
        }
        onSubmit={(v) => void submitEdit(v)}
        onCancel={() => setEditPlan(null)}
      />
      <ConfirmDialog
        open={deletePlan !== null}
        title="Hapus plan"
        message={
          deletePlan
            ? `Hapus plan "${deletePlan.name}"? Pengguna yang memakai plan ini jadi tanpa plan.`
            : ''
        }
        confirmLabel="Ya, hapus"
        loading={busy}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeletePlan(null)}
      />
    </div>
  )
}

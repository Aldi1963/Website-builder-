import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { useToast } from '../lib/toast'
import { PageHeader } from '../components/PageHeader'
import { Card } from '../components/Card'
import { StatCard } from '../components/StatCard'
import { Table, Th, Td, EmptyRow } from '../components/Table'
import { btnOutlineLg, btnOutlineSm, btnPrimary } from '../components/DFormat'
import { Badge } from '../components/Badge'
import { SearchInput } from '../components/SearchInput'
import { Field, inputClass } from '../components/Field'
import { Select } from '../components/Select'
import { Spinner } from '../components/Spinner'
import { errMessage, fmtDate, fmtDateShort, fmtNum, fmtRp } from '../components/BFormat'

interface CreditSettings {
  freeGrant: number
  freeDays: number
  freeDailyCap: number
  minBalance: number
  dailyCapFree: number
  dailyCapPaid: number
  maxCallsPerHour: number
}

interface CreditUserRow {
  id: number
  email: string
  name: string
  created_at: number
  plan_id: string | null
  plan_name: string
  free_balance: number
  purchased_balance: number
  plan_credits: number
  total: number
}

interface CreditDetail {
  user: { id: number; email: string; name: string; created_at: number; disabled: boolean }
  plan: { planId: string | null; planName: string; monthlyCredits: number }
  balance: {
    total: number
    free: number
    purchased: number
    plan: number
    freeExpiresAt: number | null
    purchasedExpiresAt: number | null
    planExpiresAt: number | null
  }
  raw: {
    free_expires_at: number | null
    purchased_expires_at: number | null
    plan_credits_expires_at: number | null
    plan_credits_reset_at: number | null
    updated_at: number | null
  } | null
  usage: { model: string; prompt_tokens: number; completion_tokens: number; cost_usd: number; credit: number; shortfall_credit: number; created_at: number }[]
  orders: { order_id: string; package: string; amount_idr: number; credits: number; status: string; created_at: number; paid_at: number | null }[]
  transactions: { kind: string; bucket: string | null; amount: number; balance_after: number; reason: string; order_id: string | null; created_at: number }[]
}

interface CreditsPageProps {
  /** Disematkan di halaman gabungan: PageHeader induk disembunyikan. */
  embedded?: boolean
}

export default function CreditsPage({ embedded = false }: CreditsPageProps) {
  const toast = useToast()
  const [settingsForm, setSettingsForm] = useState<CreditSettings | null>(null)
  const [query, setQuery] = useState('')
  const [searched, setSearched] = useState(false)
  const [searching, setSearching] = useState(false)
  const [rows, setRows] = useState<CreditUserRow[]>([])
  const [detail, setDetail] = useState<CreditDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [bucket, setBucket] = useState('free')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [adjustBusy, setAdjustBusy] = useState(false)
  const [settingsBusy, setSettingsBusy] = useState(false)
  const detailRef = useRef<HTMLDivElement>(null)

  const loadSettings = useCallback(async () => {
    try {
      const data = await api.get<{ settings: CreditSettings; defaults: CreditSettings }>(
        '/api/admin/credits/settings',
      )
      setSettingsForm(data.settings)
    } catch (e) {
      toast.error(errMessage(e))
    }
  }, [toast])

  useEffect(() => {
    void loadSettings()
  }, [loadSettings])

  const search = async () => {
    setSearching(true)
    try {
      const data = await api.get<{ users: CreditUserRow[] }>(
        `/api/admin/credits/users?q=${encodeURIComponent(query.trim())}`,
      )
      setRows(data.users)
      setSearched(true)
    } catch (e) {
      toast.error(errMessage(e))
    } finally {
      setSearching(false)
    }
  }

  const loadDetail = useCallback(
    async (userId: number) => {
      setDetailLoading(true)
      try {
        const d = await api.get<CreditDetail>(`/api/admin/credits/users/${encodeURIComponent(String(userId))}`)
        setDetail(d)
        requestAnimationFrame(() => {
          detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        })
      } catch (e) {
        toast.error(errMessage(e))
      } finally {
        setDetailLoading(false)
      }
    },
    [toast],
  )

  const submitAdjust = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!detail) return
    const amt = Number(amount)
    const rsn = reason.trim()
    if (!amt || !rsn) {
      toast.error('Isi jumlah dan alasan.')
      return
    }
    setAdjustBusy(true)
    try {
      const res = await api.post<{ ok: boolean; balance: { total: number }; applied: number }>(
        `/api/admin/credits/users/${encodeURIComponent(String(detail.user.id))}/adjust`,
        { bucket, amount: amt, reason: rsn },
      )
      toast.success(`Penyesuaian diterapkan. Saldo sekarang ${fmtNum(res.balance.total)} credit.`)
      setAmount('')
      setReason('')
      await loadDetail(detail.user.id)
    } catch (err) {
      toast.error(errMessage(err))
    } finally {
      setAdjustBusy(false)
    }
  }

  const submitSettings = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!settingsForm) return
    setSettingsBusy(true)
    try {
      await api.put('/api/admin/credits/settings', { ...settingsForm })
      toast.success('Pengaturan credit disimpan.')
      await loadSettings()
    } catch (err) {
      toast.error(errMessage(err))
    } finally {
      setSettingsBusy(false)
    }
  }

  const setNum = (key: keyof CreditSettings) => (value: string) =>
    setSettingsForm((s) => (s ? { ...s, [key]: Number(value) } : s))

  const b = detail?.balance

  return (
    <div className="space-y-4">
      {!embedded ? (
        <PageHeader
          title="Kelola Credit"
          description="Saldo credit, penyesuaian manual, dan pengaturan credit. Credit gratis diberikan saat daftar; top-up kapan saja lewat paket."
        />
      ) : null}
      <Card title="Cari Pengguna">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void search()
          }}
          className="flex gap-2"
        >
          <div className="min-w-0 flex-1">
            <SearchInput value={query} onChange={setQuery} placeholder="Cari email atau nama…" />
          </div>
          <button type="submit" disabled={searching} className={`shrink-0 ${btnOutlineLg}`}>
            Cari
          </button>
        </form>
        <div className="mt-3">
          <Table bare>
            <thead>
              <tr>
                <Th>Pengguna</Th>
                <Th>Plan</Th>
                <Th>Gratis</Th>
                <Th>Dibeli</Th>
                <Th>Plan</Th>
                <Th>Total</Th>
                <Th>{''}</Th>
              </tr>
            </thead>
            <tbody>
              {!searched ? (
                <EmptyRow colSpan={7}>Ketik email/nama lalu tekan Cari.</EmptyRow>
              ) : rows.length ? (
                rows.map((u) => (
                  <tr key={u.id}>
                    <Td>
                      {u.name || u.email}
                      <br />
                      <span className="text-xs text-muted">{u.email}</span>
                    </Td>
                    <Td>{u.plan_name}</Td>
                    <Td>{fmtNum(u.free_balance)}</Td>
                    <Td>{fmtNum(u.purchased_balance)}</Td>
                    <Td>{fmtNum(u.plan_credits)}</Td>
                    <Td>
                      <strong>{fmtNum(u.total)}</strong>
                    </Td>
                    <Td className="text-right">
                      <button type="button" onClick={() => void loadDetail(u.id)} className={btnOutlineSm}>
                        Lihat
                      </button>
                    </Td>
                  </tr>
                ))
              ) : (
                <EmptyRow colSpan={7}>Tidak ada pengguna yang cocok.</EmptyRow>
              )}
            </tbody>
          </Table>
        </div>
      </Card>

      {detailLoading && !detail ? <Spinner /> : null}

      {detail && b ? (
        <div ref={detailRef} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard
                label="Gratis"
                value={fmtNum(b.free)}
                sub={b.freeExpiresAt ? `berlaku s.d. ${fmtDateShort(b.freeExpiresAt)}` : 'tanpa kedaluwarsa'}
              />
              <StatCard
                label="Dibeli"
                value={fmtNum(b.purchased)}
                sub={b.purchasedExpiresAt ? `berlaku s.d. ${fmtDateShort(b.purchasedExpiresAt)}` : 'tanpa kedaluwarsa'}
              />
              <StatCard
                label="Jatah Plan"
                value={fmtNum(b.plan)}
                sub={b.planExpiresAt ? `jatah s.d. ${fmtDateShort(b.planExpiresAt)}` : 'tanpa jatah'}
              />
              <StatCard
                label="Total"
                value={fmtNum(b.total)}
                sub={
                  detail.raw && detail.raw.plan_credits_reset_at
                    ? `reset jatah: ${fmtDateShort(detail.raw.plan_credits_reset_at)}`
                    : '–'
                }
              />
            </div>

          <Card
            title={`${detail.user.name || detail.user.email} (${detail.user.email})`}
            actions={
              <Badge tone="info">
                {detail.plan.planName} · {fmtNum(detail.plan.monthlyCredits)} credit/bln
              </Badge>
            }
          >

            <form onSubmit={submitAdjust} className="grid items-end gap-3 md:grid-cols-[1fr_1fr_1.5fr_auto]">
              <Field label="Bucket" htmlFor="credit-adjust-bucket">
                <Select id="credit-adjust-bucket" value={bucket} onChange={(e) => setBucket(e.target.value)}>
                  <option value="free">Gratis</option>
                  <option value="purchased">Dibeli</option>
                  <option value="plan">Jatah Plan</option>
                </Select>
              </Field>
              <Field label="Jumlah (+ tambah / − kurangi)" htmlFor="credit-adjust-amount">
                <input
                  id="credit-adjust-amount"
                  type="number"
                  step="any"
                  className={inputClass}
                  placeholder="cth. 50 atau -20"
                  required
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </Field>
              <Field label="Alasan" htmlFor="credit-adjust-reason">
                <input
                  id="credit-adjust-reason"
                  type="text"
                  className={inputClass}
                  placeholder="cth. Kompensasi gangguan"
                  maxLength={200}
                  required
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </Field>
              <button type="submit" disabled={adjustBusy} className={btnPrimary}>
                Terapkan
              </button>
            </form>
            <p className="mt-2 text-sm text-muted">
              Penyesuaian tercatat di riwayat transaksi (kind <code>adjust</code>) dan log audit. Saldo tidak
              bisa negatif — pengurangan melebihi sisa bucket ditolak.
            </p>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Riwayat Pemakaian (50 terakhir)">
              <Table bare>
                <thead>
                  <tr>
                    <Th>Waktu</Th>
                    <Th>Model</Th>
                    <Th className="text-right">Credit</Th>
                    <Th className="text-right">Kurang</Th>
                  </tr>
                </thead>
                <tbody>
                  {detail.usage.length ? (
                    detail.usage.map((u, i) => (
                      <tr key={`${u.created_at}-${i}`}>
                        <Td>{fmtDate(u.created_at)}</Td>
                        <Td>{u.model}</Td>
                        <Td className="text-right">{fmtNum(u.credit)}</Td>
                        <Td className="text-right">{u.shortfall_credit ? fmtNum(u.shortfall_credit) : '–'}</Td>
                      </tr>
                    ))
                  ) : (
                    <EmptyRow colSpan={4}>Belum ada pemakaian.</EmptyRow>
                  )}
                </tbody>
              </Table>
            </Card>
            <Card title="Riwayat Top-up">
              <Table bare>
                <thead>
                  <tr>
                    <Th>Order</Th>
                    <Th className="text-right">Rp</Th>
                    <Th className="text-right">Credit</Th>
                    <Th>Status</Th>
                  </tr>
                </thead>
                <tbody>
                  {detail.orders.length ? (
                    detail.orders.map((o) => (
                      <tr key={o.order_id}>
                        <Td className="font-mono">{o.order_id}</Td>
                        <Td className="text-right">{fmtRp(o.amount_idr)}</Td>
                        <Td className="text-right">{fmtNum(o.credits)}</Td>
                        <Td>{o.status}</Td>
                      </tr>
                    ))
                  ) : (
                    <EmptyRow colSpan={4}>Belum ada top-up.</EmptyRow>
                  )}
                </tbody>
              </Table>
            </Card>
          </div>

          <Card title="Riwayat Transaksi (100 terakhir)">
            <Table bare>
              <thead>
                <tr>
                  <Th>Waktu</Th>
                  <Th>Jenis</Th>
                  <Th>Bucket</Th>
                  <Th className="text-right">Jumlah</Th>
                  <Th className="text-right">Saldo Sesudah</Th>
                  <Th>Keterangan</Th>
                </tr>
              </thead>
              <tbody>
                {detail.transactions.length ? (
                  detail.transactions.map((t, i) => (
                    <tr key={`${t.created_at}-${i}`}>
                      <Td>{fmtDate(t.created_at)}</Td>
                      <Td>{t.kind}</Td>
                      <Td>{t.bucket || '–'}</Td>
                      <Td className="text-right">
                        {t.amount > 0 ? '+' : ''}
                        {fmtNum(t.amount)}
                      </Td>
                      <Td className="text-right">{fmtNum(t.balance_after)}</Td>
                      <Td>{t.reason || ''}</Td>
                    </tr>
                  ))
                ) : (
                  <EmptyRow colSpan={6}>Belum ada transaksi.</EmptyRow>
                )}
              </tbody>
            </Table>
          </Card>
        </div>
      ) : null}

      <Card title="Pengaturan Angka Credit">
        <p className="mb-4 text-sm text-muted">
          Berlaku untuk pendaftaran dan gate berikutnya — tanpa ubah kode dan tanpa restart.
        </p>
        {settingsForm ? (
          <form onSubmit={submitSettings} className="space-y-4">
            <div className="grid gap-4 md:grid-cols-3">
              <Field label="Credit gratis pengguna baru" htmlFor="credit-set-grant">
                <input
                  id="credit-set-grant"
                  type="number"
                  min={0}
                  className={inputClass}
                  value={settingsForm.freeGrant}
                  onChange={(e) => setNum('freeGrant')(e.target.value)}
                />
              </Field>
              <Field label="Masa berlaku gratis (hari)" htmlFor="credit-set-days">
                <input
                  id="credit-set-days"
                  type="number"
                  min={1}
                  className={inputClass}
                  value={settingsForm.freeDays}
                  onChange={(e) => setNum('freeDays')(e.target.value)}
                />
              </Field>
              <Field label="Cap harian bucket gratis" htmlFor="credit-set-cap">
                <input
                  id="credit-set-cap"
                  type="number"
                  min={0}
                  className={inputClass}
                  value={settingsForm.freeDailyCap}
                  onChange={(e) => setNum('freeDailyCap')(e.target.value)}
                />
              </Field>
              <Field label="Saldo minimal gate AI" htmlFor="credit-set-min">
                <input
                  id="credit-set-min"
                  type="number"
                  min={0}
                  className={inputClass}
                  value={settingsForm.minBalance}
                  onChange={(e) => setNum('minBalance')(e.target.value)}
                />
              </Field>
              <Field label="Cap harian total — Gratis" htmlFor="credit-set-daily-free">
                <input
                  id="credit-set-daily-free"
                  type="number"
                  min={0}
                  className={inputClass}
                  value={settingsForm.dailyCapFree}
                  onChange={(e) => setNum('dailyCapFree')(e.target.value)}
                />
              </Field>
              <Field label="Cap harian total — Berbayar" htmlFor="credit-set-daily-paid">
                <input
                  id="credit-set-daily-paid"
                  type="number"
                  min={0}
                  className={inputClass}
                  value={settingsForm.dailyCapPaid}
                  onChange={(e) => setNum('dailyCapPaid')(e.target.value)}
                />
              </Field>
              <Field label="Maks. panggilan AI / jam" htmlFor="credit-set-calls-hour">
                <input
                  id="credit-set-calls-hour"
                  type="number"
                  min={0}
                  className={inputClass}
                  value={settingsForm.maxCallsPerHour}
                  onChange={(e) => setNum('maxCallsPerHour')(e.target.value)}
                />
              </Field>
            </div>
            <p className="text-sm text-muted">
              Fase 5 (anti-abuse): cap harian total membatasi credit yang dipotong per pengguna per hari (0 =
              tanpa batas) — terpisah dari &quot;cap harian bucket gratis&quot; di atas yang hanya membatasi
              bucket gratis. Pengguna berbayar = punya plan selain Gratis. Batas panggilan/jam dihitung dari
              pemakaian tercatat.
            </p>
            <button type="submit" disabled={settingsBusy} className={btnPrimary}>
              Simpan Pengaturan
            </button>
          </form>
        ) : (
          <Spinner />
        )}
      </Card>
    </div>
  )
}

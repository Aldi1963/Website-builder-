import { useCallback, useEffect, useState } from 'react'
import { DownloadSimple } from '@phosphor-icons/react'
import { api, ApiError, downloadFile } from '../lib/api'
import { useToast } from '../lib/toast'
import { PageHeader } from '../components/PageHeader'
import { Card } from '../components/Card'
import { StatCard } from '../components/StatCard'
import { Table, Th, Td, EmptyRow } from '../components/Table'
import { btnOutlineDangerSm, btnOutlineLg, btnOutlineSm, btnPrimary } from '../components/DFormat'
import { Spinner } from '../components/Spinner'
import { BLineChart, CHART_COLORS } from '../components/BCharts'
import { Alert } from '../components/Alert'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { Select } from '../components/Select'
import { CFormDialog, type CFormField, type CFormValues } from '../components/CFormDialog'
import { fmtNum, fmtRp } from '../components/BFormat'

interface PriceEntry {
  prompt_per_1k: number
  completion_per_1k: number
  currency: string
}

interface ModelRow {
  model: string | null
  requests: number
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  cost_idr: number | null
  priced: boolean
}

interface UserRow {
  user_id: string
  email: string | null
  name: string | null
  requests: number
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  cost_idr: number | null
  unpriced_tokens: number
}

interface UsageActivity {
  daily: { date: string; messages: number; users: number; projects: number }[]
  byUser: { email: string; name: string; messages: number }[]
}

interface CostData {
  days: number
  prices: Record<string, PriceEntry>
  byModel: ModelRow[]
  byUser: UserRow[]
  totals: { requests: number; total_tokens: number; cost_idr: number | null }
  allTime: { total_tokens: number }
}

type PriceDialog =
  | { mode: 'edit'; model: string }
  | { mode: 'add' }
  | null

interface BiayaPageProps {
  /** Disematkan di halaman gabungan: PageHeader induk disembunyikan. */
  embedded?: boolean
}

export default function BiayaPage({ embedded = false }: BiayaPageProps) {
  const toast = useToast()
  const [days, setDays] = useState(30)
  const [data, setData] = useState<CostData | null>(null)
  const [usage, setUsage] = useState<UsageActivity | null>(null)
  const [prices, setPrices] = useState<Record<string, PriceEntry>>({})
  const [priceDialog, setPriceDialog] = useState<PriceDialog>(null)
  const [deleteModel, setDeleteModel] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(async () => {
    try {
      const [d, u] = await Promise.all([
        api.get<CostData>(`/api/admin/cost?days=${days}`),
        api.get<UsageActivity>('/api/admin/usage'),
      ])
      setData(d)
      setUsage(u)
      setPrices(d.prices || {})
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Gagal memuat biaya.')
    }
  }, [days, toast])

  useEffect(() => {
    void load()
  }, [load])

  const savePrices = async (next: Record<string, PriceEntry>) => {
    setSaving(true)
    try {
      await api.put('/api/admin/cost/prices', { prices: next })
      toast.success('Harga model disimpan.')
      setPriceDialog(null)
      setDeleteModel(null)
      await load()
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Gagal menyimpan harga.')
    } finally {
      setSaving(false)
    }
  }

  const submitPriceDialog = (vals: CFormValues) => {
    if (priceDialog?.mode === 'edit') {
      const model = priceDialog.model
      void savePrices({
        ...prices,
        [model]: {
          prompt_per_1k: Number(vals.prompt) || 0,
          completion_per_1k: Number(vals.completion) || 0,
          currency: 'IDR',
        },
      })
    } else if (priceDialog?.mode === 'add') {
      const model = String(vals.model || '').trim()
      if (!model) return
      void savePrices({
        ...prices,
        [model]: {
          prompt_per_1k: Number(vals.prompt) || 0,
          completion_per_1k: Number(vals.completion) || 0,
          currency: 'IDR',
        },
      })
    }
  }

  const deletePrice = async () => {
    if (!deleteModel) return
    setDeleting(true)
    try {
      const next = { ...prices }
      delete next[deleteModel]
      await savePrices(next)
    } finally {
      setDeleting(false)
    }
  }

  const downloadCsv = async () => {
    const label = days === 0 ? 'semua' : `${days}hari`
    try {
      await downloadFile(`/api/admin/cost.csv?days=${days}`, `biaya-llm-${label}.csv`)
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Unduhan gagal.')
    }
  }

  const rangeLabel = days === 0 ? 'semua riwayat' : `${days} hari terakhir`
  const priceModels = Object.keys(prices).sort()
  const knownModels = (data?.byModel || [])
    .map((m) => m.model)
    .filter((m): m is string => !!m && !priceModels.includes(m))

  const priceFields = (cur?: PriceEntry): CFormField[] => [
    {
      name: 'prompt',
      label: 'Prompt — Rp per 1.000 token',
      type: 'number',
      min: 0,
      help: 'Tarif prompt sesuai tagihan provider.',
      value: cur?.prompt_per_1k ?? 0,
    },
    {
      name: 'completion',
      label: 'Completion — Rp per 1.000 token',
      type: 'number',
      min: 0,
      help: 'Tarif completion sesuai tagihan provider.',
      value: cur?.completion_per_1k ?? 0,
    },
  ]

  return (
    <div className="space-y-4">
      {!embedded ? (
        <PageHeader
          description="Perkiraan biaya dari token tercatat di token_usage, dikali harga per model yang diisi admin."
          actions={
            <>
              <Select
                aria-label="Rentang waktu"
                value={String(days)}
                onChange={(e) => setDays(Number(e.target.value) || 0)}
                className="w-auto"
              >
                <option value="7">7 hari terakhir</option>
                <option value="30">30 hari terakhir</option>
                <option value="0">Semua riwayat</option>
              </Select>
              <button
                type="button"
                onClick={() => void downloadCsv()}
                className={`inline-flex items-center gap-1.5 whitespace-nowrap ${btnOutlineLg}`}
              >
                <DownloadSimple size={16} /> Unduh CSV
              </button>
            </>
          }
        />
      ) : null}
      {data === null ? (
        <Spinner />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Total Token" value={fmtNum(data.totals.total_tokens)} sub={rangeLabel} />
            <StatCard label="Permintaan LLM" value={fmtNum(data.totals.requests)} sub="dalam rentang yang dipilih" />
            <StatCard label="Perkiraan Biaya" value={fmtRp(data.totals.cost_idr)} sub="hanya model yang harganya sudah diisi" />
            <StatCard label="Total Token (Semua)" value={fmtNum(data.allTime.total_tokens)} sub="semua riwayat" />
          </div>

          <Alert tone="info">
            Biaya = token × harga per model (Rp / 1.000 token). Harga diisi admin di bawah —{' '}
            <strong>bukan harga resmi provider</strong>, jadi isi sesuai tarif yang benar-benar ditagihkan ke akun ini.
            Model yang harganya belum diisi tampil “–” dan tidak masuk ke total biaya.
          </Alert>

          <Card title="Biaya per Model">
            <Table bare>
              <thead>
                <tr>
                  <Th>Model</Th>
                  <Th>Permintaan</Th>
                  <Th>Prompt</Th>
                  <Th>Completion</Th>
                  <Th>Total</Th>
                  <Th>Biaya (Rp)</Th>
                </tr>
              </thead>
              <tbody>
                {data.byModel.length === 0 ? (
                  <EmptyRow colSpan={6}>Belum ada token tercatat dalam rentang ini.</EmptyRow>
                ) : (
                  data.byModel.map((m) => (
                    <tr key={m.model ?? '(tanpa model)'}>
                      <Td className="font-mono">{m.model || '(tanpa model)'}</Td>
                      <Td>{fmtNum(m.requests)}</Td>
                      <Td>{fmtNum(m.prompt_tokens)}</Td>
                      <Td>{fmtNum(m.completion_tokens)}</Td>
                      <Td>{fmtNum(m.total_tokens)}</Td>
                      <Td>{m.priced ? fmtRp(m.cost_idr) : <span className="text-muted">–</span>}</Td>
                    </tr>
                  ))
                )}
              </tbody>
            </Table>
          </Card>

          {usage !== null ? (
            <div className="grid gap-4 lg:grid-cols-3">
              <Card title="Aktivitas Harian" className="min-w-0 lg:col-span-2">
                <BLineChart
                  labels={usage.daily.map((d) => d.date.slice(5))}
                  datasets={[
                    { label: 'Pesan', data: usage.daily.map((d) => d.messages), color: CHART_COLORS.blue, fill: true },
                    { label: 'Pengguna baru', data: usage.daily.map((d) => d.users), color: CHART_COLORS.teal },
                    { label: 'Proyek baru', data: usage.daily.map((d) => d.projects), color: CHART_COLORS.green },
                  ]}
                />
              </Card>
              <Card title="Pesan per Pengguna">
                <Table bare>
                  <thead>
                    <tr>
                      <Th>Pengguna</Th>
                      <Th>Pesan</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.byUser.length ? (
                      usage.byUser.map((u) => (
                        <tr key={u.email}>
                          <Td>
                            {u.name || u.email}
                            <br />
                            <span className="text-xs text-muted">{u.email}</span>
                          </Td>
                          <Td>{fmtNum(u.messages)}</Td>
                        </tr>
                      ))
                    ) : (
                      <EmptyRow colSpan={2}>Belum ada data.</EmptyRow>
                    )}
                  </tbody>
                </Table>
              </Card>
            </div>
          ) : null}

          <Card title="Biaya per Pengguna">
            <p className="mb-3 text-sm text-muted">
              Pengguna yang tokennya tercatat dengan ID yang tidak lagi cocok dengan akun mana pun tampil sebagai
              “Pengguna tak dikenal” beserta ID-nya.
            </p>
            <Table bare>
              <thead>
                <tr>
                  <Th>Pengguna</Th>
                  <Th>Permintaan</Th>
                  <Th>Prompt</Th>
                  <Th>Completion</Th>
                  <Th>Total</Th>
                  <Th>Biaya (Rp)</Th>
                </tr>
              </thead>
              <tbody>
                {data.byUser.length === 0 ? (
                  <EmptyRow colSpan={6}>Belum ada token tercatat dalam rentang ini.</EmptyRow>
                ) : (
                  data.byUser.map((u) => (
                    <tr key={u.user_id}>
                      <Td>
                        {u.email ? (
                          <>
                            {u.name || u.email}
                            <br />
                            <span className="text-xs text-muted">{u.email}</span>
                          </>
                        ) : (
                          <>
                            Pengguna tak dikenal
                            <br />
                            <span className="font-mono text-xs text-muted">{u.user_id}</span>
                          </>
                        )}
                      </Td>
                      <Td>{fmtNum(u.requests)}</Td>
                      <Td>{fmtNum(u.prompt_tokens)}</Td>
                      <Td>{fmtNum(u.completion_tokens)}</Td>
                      <Td>{fmtNum(u.total_tokens)}</Td>
                      <Td>
                        {u.cost_idr !== null ? fmtRp(u.cost_idr) : <span className="text-muted">–</span>}
                        {u.unpriced_tokens > 0 ? (
                          <>
                            <br />
                            <span className="text-xs text-muted">{fmtNum(u.unpriced_tokens)} token tanpa harga</span>
                          </>
                        ) : null}
                      </Td>
                    </tr>
                  ))
                )}
              </tbody>
            </Table>
          </Card>

          <Card
            title="Harga per Model (Rp / 1.000 token)"
            actions={
              <button
                type="button"
                onClick={() => setPriceDialog({ mode: 'add' })}
                className={`whitespace-nowrap ${btnPrimary}`}
              >
                Tambah harga
              </button>
            }
          >
            <p className="mb-3 text-sm text-muted">
              Harga disimpan di pengaturan admin (<code>llm_prices</code>) dan langsung dipakai menghitung biaya di
              atas. Kosongkan dengan menghapus baris bila tarif tidak diketahui — biaya model itu kembali tampil “–”.
            </p>
            <Table bare>
              <thead>
                <tr>
                  <Th>Model</Th>
                  <Th>Prompt / 1.000 token</Th>
                  <Th>Completion / 1.000 token</Th>
                  <Th>{'\u00A0'}</Th>
                </tr>
              </thead>
              <tbody>
                {priceModels.length === 0 && knownModels.length === 0 ? (
                  <EmptyRow colSpan={4}>Belum ada harga dan belum ada model tercatat.</EmptyRow>
                ) : (
                  <>
                    {priceModels.map((m) => (
                      <tr key={m}>
                        <Td className="font-mono">{m}</Td>
                        <Td>{fmtRp(prices[m].prompt_per_1k)}</Td>
                        <Td>{fmtRp(prices[m].completion_per_1k)}</Td>
                        <Td className="text-right whitespace-nowrap">
                          <div className="flex justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => setPriceDialog({ mode: 'edit', model: m })}
                              className={btnOutlineSm}
                            >
                              Ubah
                            </button>
                            <button
                              type="button"
                              onClick={() => setDeleteModel(m)}
                              className={btnOutlineDangerSm}
                            >
                              Hapus
                            </button>
                          </div>
                        </Td>
                      </tr>
                    ))}
                    {knownModels.map((m) => (
                      <tr key={`known-${m}`}>
                        <Td className="font-mono">{m}</Td>
                        <td colSpan={2} className="border-b border-border px-4 py-3">
                          <span className="text-muted">Belum ada harga — biaya tampil “–”.</span>
                        </td>
                        <Td className="text-right whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => setPriceDialog({ mode: 'edit', model: m })}
                            className={btnOutlineSm}
                          >
                            Isi harga
                          </button>
                        </Td>
                      </tr>
                    ))}
                  </>
                )}
              </tbody>
            </Table>
          </Card>
        </>
      )}

      <CFormDialog
        open={priceDialog?.mode === 'edit'}
        title={priceDialog?.mode === 'edit' ? `Harga model ${priceDialog.model}` : ''}
        fields={priceDialog?.mode === 'edit' ? priceFields(prices[priceDialog.model]) : []}
        saving={saving}
        onSubmit={submitPriceDialog}
        onCancel={() => setPriceDialog(null)}
      />

      <CFormDialog
        open={priceDialog?.mode === 'add'}
        title="Tambah harga model"
        fields={[
          {
            name: 'model',
            label: 'Nama model',
            required: true,
            help: 'cth. cx/gpt-5.6-luna — harus sama persis dengan nama di tabel per model.',
          },
          { name: 'prompt', label: 'Prompt — Rp per 1.000 token', type: 'number', min: 0, value: 0 },
          { name: 'completion', label: 'Completion — Rp per 1.000 token', type: 'number', min: 0, value: 0 },
        ]}
        saving={saving}
        onSubmit={submitPriceDialog}
        onCancel={() => setPriceDialog(null)}
      />

      <ConfirmDialog
        open={deleteModel !== null}
        title="Hapus harga"
        message={deleteModel ? `Hapus harga model ${deleteModel}? Biayanya kembali tampil “–”.` : ''}
        confirmLabel="Ya, hapus"
        loading={deleting}
        onConfirm={() => void deletePrice()}
        onCancel={() => setDeleteModel(null)}
      />
    </div>
  )
}

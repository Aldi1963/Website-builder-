import { useCallback, useEffect, useState } from 'react'
import { DownloadSimple } from '@phosphor-icons/react'
import { api, ApiError, downloadFile } from '../lib/api'
import { useToast } from '../lib/toast'
import { PageHeader } from '../components/PageHeader'
import { Card } from '../components/Card'
import { StatCard } from '../components/StatCard'
import { Table, Th, Td } from '../components/Table'
import { Spinner } from '../components/Spinner'
import { Alert } from '../components/Alert'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { Select } from '../components/Select'
import { CFormDialog, type CFormField, type CFormValues } from '../components/CFormDialog'
import { fmtNum, fmtRp } from '../components/CFormat'

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

export default function BiayaPage() {
  const toast = useToast()
  const [days, setDays] = useState(30)
  const [data, setData] = useState<CostData | null>(null)
  const [prices, setPrices] = useState<Record<string, PriceEntry>>({})
  const [priceDialog, setPriceDialog] = useState<PriceDialog>(null)
  const [deleteModel, setDeleteModel] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(async () => {
    try {
      const d = await api.get<CostData>(`/api/admin/cost?days=${days}`)
      setData(d)
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
      <PageHeader
        title="Biaya LLM"
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
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-2 text-sm font-medium whitespace-nowrap hover:bg-surface-muted"
            >
              <DownloadSimple size={16} /> Unduh CSV
            </button>
          </>
        }
      />

      {data === null ? (
        <Spinner />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Total Token" value={fmtNum(data.totals.total_tokens)} sub={rangeLabel} />
            <StatCard label="Permintaan LLM" value={fmtNum(data.totals.requests)} sub="dalam rentang yang dipilih" />
            <StatCard label="Perkiraan Biaya" value={fmtRp(data.totals.cost_idr)} sub="hanya model yang harganya sudah diisi" />
            <StatCard label="Total Token (Semua)" value={fmtNum(data.allTime.total_tokens)} sub="sama dengan halaman Penggunaan" />
          </div>

          <Alert tone="info">
            Biaya = token × harga per model (Rp / 1.000 token). Harga diisi admin di bawah —{' '}
            <strong>bukan harga resmi provider</strong>, jadi isi sesuai tarif yang benar-benar ditagihkan ke akun ini.
            Model yang harganya belum diisi tampil “–” dan tidak masuk ke total biaya.
          </Alert>

          <Card title="Biaya per Model">
            <Table>
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
                  <tr>
                    <td colSpan={6} className="border-b border-border px-4 py-3 text-muted">
                      Belum ada token tercatat dalam rentang ini.
                    </td>
                  </tr>
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

          <Card title="Biaya per Pengguna">
            <p className="mb-3 text-sm text-muted">
              Pengguna yang tokennya tercatat dengan ID yang tidak lagi cocok dengan akun mana pun tampil sebagai
              “Pengguna tak dikenal” beserta ID-nya.
            </p>
            <Table>
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
                  <tr>
                    <td colSpan={6} className="border-b border-border px-4 py-3 text-muted">
                      Belum ada token tercatat dalam rentang ini.
                    </td>
                  </tr>
                ) : (
                  data.byUser.map((u) => (
                    <tr key={u.user_id}>
                      <Td>
                        {u.email ? (
                          <>
                            {u.name || u.email}
                            <br />
                            <small className="text-muted">{u.email}</small>
                          </>
                        ) : (
                          <>
                            Pengguna tak dikenal
                            <br />
                            <small className="font-mono text-muted">{u.user_id}</small>
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
                            <small className="text-muted">{fmtNum(u.unpriced_tokens)} token tanpa harga</small>
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
                className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium whitespace-nowrap text-white hover:bg-accent-hover"
              >
                Tambah harga
              </button>
            }
          >
            <p className="mb-3 text-sm text-muted">
              Harga disimpan di pengaturan admin (<code>llm_prices</code>) dan langsung dipakai menghitung biaya di
              atas. Kosongkan dengan menghapus baris bila tarif tidak diketahui — biaya model itu kembali tampil “–”.
            </p>
            <Table>
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
                  <tr>
                    <td colSpan={4} className="border-b border-border px-4 py-3 text-muted">
                      Belum ada harga dan belum ada model tercatat.
                    </td>
                  </tr>
                ) : (
                  <>
                    {priceModels.map((m) => (
                      <tr key={m}>
                        <Td className="font-mono">{m}</Td>
                        <Td>Rp {fmtNum(prices[m].prompt_per_1k)}</Td>
                        <Td>Rp {fmtNum(prices[m].completion_per_1k)}</Td>
                        <Td className="text-right whitespace-nowrap">
                          <div className="flex justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => setPriceDialog({ mode: 'edit', model: m })}
                              className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium hover:bg-surface-muted"
                            >
                              Ubah
                            </button>
                            <button
                              type="button"
                              onClick={() => setDeleteModel(m)}
                              className="rounded-lg border border-danger/40 bg-surface px-3 py-1.5 text-sm font-medium text-danger hover:bg-danger-soft"
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
                            className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium hover:bg-surface-muted"
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

import { useEffect, useState, type ReactNode } from 'react'
import { api, ApiError } from '../lib/api'
import { useToast } from '../lib/toast'
import { Card } from './Card'
import { Badge } from './Badge'
import { Toggle } from './Toggle'
import { Alert } from './Alert'
import { Spinner } from './Spinner'
import { Table, Th, Td, EmptyRow } from './Table'
import { btnOutline, btnOutlineSm, btnPrimary } from './DFormat'
import { SearchInput } from './SearchInput'
import { ConfirmDialog } from './ConfirmDialog'
import { Field, inputClass } from './Field'
import { fmtNum } from './BFormat'

export interface ProviderModel {
  id: string
  name?: string | null
  active: boolean
  rateInUsdPer1M: number | null
  rateOutUsdPer1M: number | null
  endpoint?: string | null
  notes?: string | null
  messagesOnly?: boolean
  toolsConfirmed?: boolean
  contextLength?: number | null
}

export interface Provider {
  id: string
  name: string
  baseUrl: string
  keyEnv?: string | null
  active: boolean
  notes?: string | null
  keyConfigured: boolean
  models: ProviderModel[]
}

/* Catatan per provider — teks hardcoded di admin.js lama (§3 Q6 SPEC:
   pertanyaan terbuka tanpa instruksi, jadi dipertahankan verbatim). */
const PROVIDER_NOTES: Record<string, string> = {
  '9router':
    'Provider default builder. Key juga bisa diatur di Pengaturan AI — nilai <code>llm.key</code> di sana mengalahkan key panel ini. Endpoint chat efektif mengikuti <code>llm.url</code> bila diisi.',
  commandcode:
    'TERBLOKIR — paket Go $1/bln tidak termasuk akses API (chat ditolak 403 upgrade_required). Upgrade yang membuka API: <strong>GOAT $10/bln</strong> (membuka API, credit pool + rolling window) atau <strong>Provider $15/bln</strong> (+$1,01 fee, termasuk $15 credit, PAYG tanpa markup — rute paling bersih). Lihat harga di <a href="https://commandcode.ai/billing" target="_blank" rel="noopener">commandcode.ai/billing</a>. Model gratis (:free) tetap terblokir — blokir di level paket, bukan model.',
  gater:
    '<strong>Tanpa harga = belum bisa dipakai</strong>: isi tarif per model di bawah dulu. Batas per key (konservatif): maks 5 koneksi bersamaan + ~40 RPM. Varian <code>-uncen</code> boleh diaktifkan lewat sakelar model (keputusan user 25 Nov 2026).',
  sumopod:
    'Cara buat key: buat akun di <a href="https://ai.sumopod.com" target="_blank" rel="noopener">ai.sumopod.com</a> → isi AI Balance → menu API Keys → buat key, lalu tempel di bawah ini. Tarif dari katalog 27 Okt 2026 — bisa tertinggal, sinkronkan saat key terpasang.',
}

function fmtRate(v: number | null): string {
  return v === null || v === undefined ? '–' : `$${v}`
}

function parseRateInput(raw: string): number | null | undefined {
  const s = String(raw ?? '').trim()
  if (s === '') return null
  const n = Number(s)
  if (!Number.isFinite(n) || n < 0) return undefined
  return n
}

function providerBadges(p: Provider): ReactNode {
  const badges: ReactNode[] = [
    p.active ? <Badge key="st" tone="success">Aktif</Badge> : <Badge key="st">Nonaktif</Badge>,
  ]
  if (p.id === 'commandcode') {
    badges.push(<Badge key="cc" tone="danger">Terblokir paket Go</Badge>)
  }
  if (!p.keyConfigured) {
    badges.push(<Badge key="key" tone="warning">Key belum terpasang</Badge>)
  }
  const priced = (p.models || []).filter((m) => m.rateInUsdPer1M !== null && m.rateOutUsdPer1M !== null).length
  if (priced === 0) {
    badges.push(<Badge key="price" tone="warning">Tanpa harga</Badge>)
  }
  return badges
}

function modelBadges(m: ProviderModel): ReactNode {
  const badges: ReactNode[] = []
  if (m.messagesOnly) {
    badges.push(<Badge key="mo" tone="danger">/messages-only</Badge>)
  }
  if (m.rateInUsdPer1M === 0 && m.rateOutUsdPer1M === 0) {
    badges.push(<Badge key="free" tone="success">Gratis $0</Badge>)
  }
  if (m.rateInUsdPer1M === null || m.rateOutUsdPer1M === null) {
    badges.push(<Badge key="norate" tone="warning">Tanpa tarif — tidak bisa dipakai</Badge>)
  }
  if (m.toolsConfirmed === true) {
    badges.push(<Badge key="tools-y" tone="info">tools terkonfirmasi</Badge>)
  }
  if (m.toolsConfirmed === false) {
    badges.push(<Badge key="tools-n">tools belum terkonfirmasi</Badge>)
  }
  if (m.contextLength) {
    badges.push(<Badge key="ctx">konteks {fmtNum(m.contextLength)}</Badge>)
  }
  if (m.id.endsWith('-uncen')) {
    badges.push(<Badge key="uncen" tone="info">-uncen</Badge>)
  }
  return badges
}

export function CProviderCard({ provider: p, onReload }: { provider: Provider; onReload: () => void }) {
  const toast = useToast()
  const models = p.models || []

  const [providerActive, setProviderActive] = useState(p.active)
  const [modelActive, setModelActive] = useState<Record<string, boolean>>({})
  const [rates, setRates] = useState<Record<string, { in: string; out: string }>>({})
  const [keyInput, setKeyInput] = useState('')
  const [search, setSearch] = useState('')
  const [result, setResult] = useState<ReactNode>(null)
  const [busy, setBusy] = useState<'test' | 'sync' | null>(null)
  const [savingRate, setSavingRate] = useState<string | null>(null)
  const [savingKey, setSavingKey] = useState(false)
  const [confirmDeleteKey, setConfirmDeleteKey] = useState(false)

  // Sinkronkan state lokal dari data server setiap kali provider dimuat ulang.
  useEffect(() => {
    setProviderActive(p.active)
    const act: Record<string, boolean> = {}
    const r: Record<string, { in: string; out: string }> = {}
    for (const m of p.models || []) {
      act[m.id] = m.active
      r[m.id] = {
        in: m.rateInUsdPer1M === null ? '' : String(m.rateInUsdPer1M),
        out: m.rateOutUsdPer1M === null ? '' : String(m.rateOutUsdPer1M),
      }
    }
    setModelActive(act)
    setRates(r)
    setKeyInput('')
    setSearch('')
    setResult(null)
  }, [p])

  const toggleProvider = async (checked: boolean) => {
    setProviderActive(checked)
    try {
      await api.put(`/api/admin/llm/providers/${encodeURIComponent(p.id)}`, { active: checked })
      toast.success(`Provider ${p.id} ${checked ? 'diaktifkan' : 'dinonaktifkan'}.`)
      onReload()
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Gagal mengubah provider.')
      onReload()
    }
  }

  const toggleModel = async (modelId: string, checked: boolean) => {
    setModelActive((prev) => ({ ...prev, [modelId]: checked }))
    try {
      await api.put(
        `/api/admin/llm/providers/${encodeURIComponent(p.id)}/models/${encodeURIComponent(modelId)}`,
        { active: checked },
      )
      toast.success(`Model ${modelId} ${checked ? 'diaktifkan' : 'dinonaktifkan'}.`)
      // Sukses: TIDAK reload (sakelar dibiarkan) — perilaku lama.
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Gagal mengubah model.')
      onReload()
    }
  }

  const saveRate = async (modelId: string) => {
    const rin = parseRateInput(rates[modelId]?.in ?? '')
    const rout = parseRateInput(rates[modelId]?.out ?? '')
    if (rin === undefined || rout === undefined) {
      toast.error('Tarif harus angka ≥ 0, atau dikosongkan bila belum diketahui.')
      return
    }
    setSavingRate(modelId)
    try {
      await api.put(
        `/api/admin/llm/providers/${encodeURIComponent(p.id)}/models/${encodeURIComponent(modelId)}`,
        { rateInUsdPer1M: rin, rateOutUsdPer1M: rout },
      )
      toast.success(
        `Tarif ${modelId} disimpan (${rin === null ? 'belum diketahui' : fmtRate(rin)} / ${rout === null ? 'belum diketahui' : fmtRate(rout)}).`,
      )
      onReload()
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Gagal menyimpan tarif.')
    } finally {
      setSavingRate(null)
    }
  }

  const saveKey = async () => {
    const key = keyInput.trim()
    if (key === '') {
      if (!p.keyConfigured) {
        toast.success('Tidak ada key tersimpan untuk provider ini.')
        return
      }
      setConfirmDeleteKey(true)
      return
    }
    if (key.length < 8) {
      toast.error('API key terlalu pendek (min 8 karakter).')
      return
    }
    await putKey(key)
  }

  const putKey = async (key: string) => {
    setSavingKey(true)
    try {
      const r = await api.put<{ ok: boolean; keyConfigured: boolean }>(
        `/api/admin/llm/providers/${encodeURIComponent(p.id)}/key`,
        { key },
      )
      toast.success(r.keyConfigured ? `Key ${p.id} disimpan — terpasang.` : `Key ${p.id} dihapus — belum terpasang.`)
      onReload()
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Gagal menyimpan key.')
    } finally {
      setSavingKey(false)
    }
  }

  const testProvider = async () => {
    setBusy('test')
    setResult(
      <p className="mb-0 text-sm text-muted">
        <Spinner label="Menghubungi GET /models provider…" />
      </p>,
    )
    try {
      const r = await api.post<{ ok: boolean; status?: number; models?: number; error?: string }>(
        `/api/admin/llm/providers/${encodeURIComponent(p.id)}/test`,
      )
      setResult(
        r.ok ? (
          <p className="mb-0 text-sm">
            <Badge tone="success">Berhasil</Badge>{' '}
            GET /models balas {r.status ?? 200}
            {r.models !== undefined ? ` — ${fmtNum(r.models)} model upstream` : ''}.
          </p>
        ) : (
          <div className="text-sm">
            <p className="mb-0">
              <Badge tone="danger">Gagal</Badge>
            </p>
            <p className="mb-0 text-danger">{r.error || 'Tes koneksi gagal.'}</p>
          </div>
        ),
      )
    } catch (e) {
      setResult(
        <div className="text-sm">
          <p className="mb-0">
            <Badge tone="danger">Gagal</Badge>
          </p>
          <p className="mb-0 text-danger">{e instanceof ApiError ? e.message : 'Tes koneksi gagal.'}</p>
        </div>,
      )
    } finally {
      setBusy(null)
    }
  }

  const syncProvider = async () => {
    setBusy('sync')
    setResult(
      <p className="mb-0 text-sm text-muted">
        <Spinner label="Mengambil daftar model upstream…" />
      </p>,
    )
    try {
      const r = await api.post<{
        provider: string
        upstream: { id: string }[]
        inRegistry: number
        missing: string[]
      }>(`/api/admin/llm/providers/${encodeURIComponent(p.id)}/sync`)
      const missing = r.missing || []
      setResult(
        <div className="text-sm">
          <p className="mb-1">
            <Badge tone="success">Berhasil</Badge> Upstream: {fmtNum((r.upstream || []).length)} model · sudah di
            registry: {fmtNum(r.inRegistry)} · belum ada: {fmtNum(missing.length)}.
          </p>
          {missing.length > 0 ? (
            <details>
              <summary className="text-muted">
                Model upstream yang belum ada di registry ({fmtNum(missing.length)}) — belum ditambahkan otomatis
              </summary>
              <p className="mt-1 mb-0 font-mono text-xs break-all">{missing.join(', ')}</p>
            </details>
          ) : (
            <p className="mb-0 text-muted">Semua model upstream sudah ada di registry.</p>
          )}
        </div>,
      )
    } catch (e) {
      setResult(
        <div className="text-sm">
          <p className="mb-0">
            <Badge tone="danger">Gagal</Badge>
          </p>
          <p className="mb-0 text-danger">{e instanceof ApiError ? e.message : 'Sinkronisasi gagal.'}</p>
        </div>,
      )
    } finally {
      setBusy(null)
    }
  }

  const q = search.trim().toLowerCase()
  const visibleModels = models.filter((m) => !q || `${m.id || ''} ${m.name || ''}`.toLowerCase().includes(q))
  const activeCount = models.filter((m) => modelActive[m.id] ?? m.active).length

  return (
    <Card
      title={p.name}
      actions={
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {providerBadges(p)}
          <Toggle
            checked={providerActive}
            onChange={(v) => void toggleProvider(v)}
            label={providerActive ? 'Aktif' : 'Nonaktif'}
          />
          <span className="text-sm font-medium">{providerActive ? 'Aktif' : 'Nonaktif'}</span>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-muted">
          Base URL: <code>{p.baseUrl}</code>
          {p.keyEnv ? (
            <>
              {' · '}env key: <code>{p.keyEnv}</code>
            </>
          ) : null}{' '}
          · {fmtNum(models.length)} model · {fmtNum(activeCount)} aktif
        </p>

        {p.notes ? <Alert tone="warning">{p.notes}</Alert> : null}
        {PROVIDER_NOTES[p.id] ? (
          <Alert tone="info">
            <span dangerouslySetInnerHTML={{ __html: PROVIDER_NOTES[p.id] }} />
          </Alert>
        ) : null}

        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[240px] flex-1">
            <Field
              label="API key"
              htmlFor={`prov-key-${p.id}`}
              hint="Nilai key tidak pernah ditampilkan. Kosongkan lalu simpan (dengan konfirmasi) untuk menghapus key panel."
            >
              <div className="flex items-center gap-2">
                <input
                  id={`prov-key-${p.id}`}
                  type="password"
                  className={`${inputClass} font-mono`}
                  autoComplete="new-password"
                  placeholder={
                    p.keyConfigured ? '•••••••• (terpasang — isi untuk mengganti)' : 'Belum ada key — tempel API key'
                  }
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                />
                {p.keyConfigured ? <Badge tone="accent">terpasang</Badge> : <Badge>belum terpasang</Badge>}
              </div>
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void saveKey()}
              disabled={savingKey}
              className={btnPrimary}
            >
              {savingKey ? 'Menyimpan…' : 'Simpan key'}
            </button>
            <button type="button" onClick={() => void testProvider()} disabled={busy !== null} className={btnOutline}>
              Tes koneksi
            </button>
            <button type="button" onClick={() => void syncProvider()} disabled={busy !== null} className={btnOutline}>
              Sinkronkan model
            </button>
          </div>
        </div>

        {result ? <div className="text-sm">{result}</div> : null}

        <div className="flex flex-wrap items-center gap-3">
          <div className="w-full max-w-md">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="Cari model…"
              ariaLabel={`Cari model ${p.name}`}
            />
          </div>
          <span className="text-sm text-muted">
            {q ? `${fmtNum(visibleModels.length)} dari ${fmtNum(models.length)} model` : `${fmtNum(models.length)} model`}
          </span>
        </div>

        <Table bare>
          <thead>
            <tr>
              <Th>Model</Th>
              <Th>In $ / 1 jt token</Th>
              <Th>Out $ / 1 jt token</Th>
              <Th>Aktif</Th>
              <Th>{'\u00A0'}</Th>
            </tr>
          </thead>
          <tbody>
            {models.length === 0 ? (
              <EmptyRow colSpan={5}>Belum ada model di registry provider ini.</EmptyRow>
            ) : (
              visibleModels.map((m) => (
                <tr key={m.id}>
                  <Td>
                    <span className="font-mono">{m.id}</span>
                    {m.name && m.name !== m.id ? (
                      <>
                        <br />
                        <span className="text-xs text-muted">{m.name}</span>
                      </>
                    ) : null}
                    <div className="mt-1 flex flex-wrap gap-1">{modelBadges(m)}</div>
                    {m.notes ? (
                      <>
                        <br />
                        <span className="text-xs text-muted">{m.notes}</span>
                      </>
                    ) : null}
                  </Td>
                  <Td>
                    <input
                      type="number"
                      className={`${inputClass} w-[110px]`}
                      min={0}
                      step="any"
                      value={rates[m.id]?.in ?? ''}
                      placeholder="belum diketahui"
                      aria-label={`Tarif input ${m.id}`}
                      onChange={(e) =>
                        setRates((prev) => ({ ...prev, [m.id]: { ...prev[m.id], in: e.target.value } }))
                      }
                    />
                  </Td>
                  <Td>
                    <input
                      type="number"
                      className={`${inputClass} w-[110px]`}
                      min={0}
                      step="any"
                      value={rates[m.id]?.out ?? ''}
                      placeholder="belum diketahui"
                      aria-label={`Tarif output ${m.id}`}
                      onChange={(e) =>
                        setRates((prev) => ({ ...prev, [m.id]: { ...prev[m.id], out: e.target.value } }))
                      }
                    />
                  </Td>
                  <Td>
                    <Toggle
                      checked={modelActive[m.id] ?? m.active}
                      onChange={(v) => void toggleModel(m.id, v)}
                      label={`Aktif ${m.id}`}
                    />
                  </Td>
                  <Td className="text-right whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => void saveRate(m.id)}
                      disabled={savingRate === m.id}
                      className={btnOutlineSm}
                    >
                      {savingRate === m.id ? 'Menyimpan…' : 'Simpan tarif'}
                    </button>
                  </Td>
                </tr>
              ))
            )}
            {q && visibleModels.length === 0 && models.length > 0 ? (
              <EmptyRow colSpan={5}>Tidak ada model yang cocok dengan pencarian.</EmptyRow>
            ) : null}
          </tbody>
        </Table>

        <p className="text-sm text-muted">
          Tarif kosong = harga belum diketahui → model tidak bisa dipakai. Tarif $0 = gratis, sah dipakai. Tarif yang
          disimpan di sini juga dipakai pemotongan credit; sinkronkan ke halaman Biaya LLM dengan tombol di atas.
        </p>
      </div>

      <ConfirmDialog
        open={confirmDeleteKey}
        title="Hapus key"
        message={`Hapus API key ${p.id} yang tersimpan di panel? Model provider ini kembali memakai key environment (bila ada) atau tidak bisa dipakai.`}
        confirmLabel="Ya, hapus key"
        loading={savingKey}
        onConfirm={() => {
          setConfirmDeleteKey(false)
          void putKey('')
        }}
        onCancel={() => setConfirmDeleteKey(false)}
      />
    </Card>
  )
}

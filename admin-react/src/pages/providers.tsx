import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { useToast } from '../lib/toast'
import { PageHeader } from '../components/PageHeader'
import { Alert } from '../components/Alert'
import { Spinner } from '../components/Spinner'
import { CProviderCard, type Provider } from '../components/CProviderCard'
import { fmtNum } from '../components/BFormat'
import { btnOutlineLg } from '../components/DFormat'

interface ProvidersPageProps {
  /** Disematkan di halaman gabungan: PageHeader induk disembunyikan. */
  embedded?: boolean
}

export default function ProvidersPage({ embedded = false }: ProvidersPageProps) {
  const toast = useToast()
  const [providers, setProviders] = useState<Provider[] | null>(null)
  const [pricesResult, setPricesResult] = useState('')
  const [syncingPrices, setSyncingPrices] = useState(false)

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ providers: Provider[] }>('/api/admin/llm/providers')
      setProviders(data.providers || [])
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Gagal memuat provider.')
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load])

  const syncPrices = async () => {
    setSyncingPrices(true)
    try {
      const r = await api.post<{ ok: boolean; added: number; skipped: number }>('/api/admin/llm/prices/sync')
      const msg = `Harga disinkronkan ke Biaya LLM: ${fmtNum(r.added)} harga baru ditambahkan, ${fmtNum(r.skipped)} sudah ada (tidak ditimpa). Model tanpa tarif tidak diisi.`
      setPricesResult(msg)
      toast.success(msg)
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Gagal menyinkronkan harga.')
    } finally {
      setSyncingPrices(false)
    }
  }

  return (
    <div className="space-y-4">
      {!embedded ? (
        <PageHeader
          description="Provider + model + tarif yang dipakai builder. Hanya model yang aktif, di provider aktif, dan punya tarif yang bisa dipakai — model tanpa tarif tidak bisa dipakai (anti-rugi)."
          actions={
            <>
              <button
                type="button"
                onClick={() => void syncPrices()}
                disabled={syncingPrices}
                className={`whitespace-nowrap ${btnOutlineLg}`}
              >
                {syncingPrices ? 'Menyinkronkan…' : 'Sinkronkan harga ke Biaya'}
              </button>
              <button
                type="button"
                onClick={() => void load()}
                className={`whitespace-nowrap ${btnOutlineLg}`}
              >
                Muat ulang
              </button>
            </>
          }
        />
      ) : null}
      <Alert tone="info">
        Nilai API key <strong>tidak pernah ditampilkan</strong> di halaman ini — hanya status terpasang/belum. Isi
        field key untuk mengganti key; simpan dalam keadaan kosong (dengan konfirmasi) untuk menghapus key yang
        tersimpan di panel. Key dari environment server tetap berlaku bila tidak ada key panel.
        {pricesResult ? <span className="mt-2 block">{pricesResult}</span> : null}
      </Alert>

      {providers === null ? (
        <Spinner label="Memuat provider…" />
      ) : providers.length === 0 ? (
        <p className="text-sm text-muted">Belum ada provider di registry.</p>
      ) : (
        providers.map((p) => <CProviderCard key={p.id} provider={p} onReload={() => void load()} />)
      )}
    </div>
  )
}

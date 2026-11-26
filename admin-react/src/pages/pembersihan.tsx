import { useCallback, useEffect, useState } from 'react'
import { Key, Pulse, Trash } from '@phosphor-icons/react'
import { api, ApiError } from '../lib/api'
import { useToast } from '../lib/toast'
import { PageHeader } from '../components/PageHeader'
import { Card } from '../components/Card'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { Field, inputClass } from '../components/Field'
import { Spinner } from '../components/Spinner'
import { StatCard } from '../components/StatCard'
import { Toggle } from '../components/Toggle'
import { btnPrimary } from '../components/DFormat'
import { fmtDate, fmtNum } from '../components/BFormat'

interface CleanupData {
  settings: {
    retentionDays: number
    auto: boolean
    lastRunAt: number | null
    lastRun: { at: number; builds: number; sessions: number; previews: number } | null
  }
  counts: { builds: number; sessions: number; previewsRunning: number }
  lastRun: { at: number; builds: number; sessions: number; previews: number } | null
}

export default function PembersihanPage() {
  const toast = useToast()
  const [data, setData] = useState<CleanupData | null>(null)
  const [busy, setBusy] = useState(false)
  const [runConfirm, setRunConfirm] = useState(false)
  const [retention, setRetention] = useState('30')
  const [auto, setAuto] = useState(false)

  const load = useCallback(async () => {
    try {
      const d = await api.get<CleanupData>('/api/admin/cleanup')
      setData(d)
      setRetention(String(d.settings.retentionDays))
      setAuto(!!d.settings.auto)
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Gagal memuat pembersihan.')
      setData(null)
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load])

  async function doRun() {
    setBusy(true)
    try {
      const r = await api.post<{
        ok: boolean
        at: number
        retentionDays: number
        deleted: { builds: number; sessions: number; previews: number; previewsRunning: number }
      }>('/api/admin/cleanup/run')
      toast.success(
        `Pembersihan selesai: ${fmtNum(r.deleted.builds)} build, ${fmtNum(r.deleted.sessions)} sesi dihapus.`,
      )
      setRunConfirm(false)
      await load()
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Gagal menjalankan pembersihan.')
    } finally {
      setBusy(false)
    }
  }

  async function saveSettings(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      await api.put('/api/admin/cleanup/settings', {
        retentionDays: Number(retention),
        auto,
      })
      toast.success('Pengaturan pembersihan disimpan.')
      await load()
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Gagal menyimpan pengaturan.')
    } finally {
      setBusy(false)
    }
  }

  const last = data?.lastRun

  return (
    <div className="space-y-4">
      <PageHeader
        title="Pembersihan"
        description="Hapus data lama yang sudah tidak dipakai: build lama dan sesi login kedaluwarsa. Preview yang sedang berjalan tidak pernah dihentikan dari sini."
        actions={
          <button type="button" className={btnPrimary} disabled={busy || data === null} onClick={() => setRunConfirm(true)}>
            <Trash size={16} /> Jalankan pembersihan sekarang
          </button>
        }
      />
      {data === null ? (
        <Spinner />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <StatCard
              label="Build lama"
              value={fmtNum(data.counts.builds)}
              sub={`lebih lama dari ${data.settings.retentionDays} hari`}
              icon={<Trash size={20} />}
            />
            <StatCard
              label="Sesi kedaluwarsa"
              value={fmtNum(data.counts.sessions)}
              sub="sesi login yang sudah lewat masa berlaku"
              icon={<Key size={20} />}
            />
            <StatCard
              label="Preview berjalan"
              value={fmtNum(data.counts.previewsRunning)}
              sub="tidak pernah dihentikan pembersihan"
              icon={<Pulse size={20} />}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-5">
            <div className="min-w-0 lg:col-span-3">
              <Card title="Pengaturan Retensi">
                <form onSubmit={(e) => void saveSettings(e)} className="space-y-4">
                  <Field
                    label="Simpan build selama (hari)"
                    htmlFor="cleanup-retention"
                    hint="Build yang dibuat lebih lama dari ini akan dihapus. Sesi login dihapus begitu kedaluwarsa, tidak peduli retensi."
                  >
                    <input
                      type="number"
                      className={`${inputClass} max-w-[200px]`}
                      id="cleanup-retention"
                      min={1}
                      max={365}
                      step={1}
                      value={retention}
                      onChange={(e) => setRetention(e.target.value)}
                    />
                  </Field>
                  <div className="flex items-center gap-3">
                    <Toggle checked={auto} onChange={setAuto} label="Pembersihan otomatis (sekali sehari)" />
                    <span className="text-sm font-medium">Pembersihan otomatis (sekali sehari)</span>
                  </div>
                  <button type="submit" className={btnPrimary} disabled={busy}>
                    Simpan pengaturan
                  </button>
                </form>
              </Card>
            </div>

            <div className="min-w-0 space-y-4 lg:col-span-2">
              <Card title="Hasil Terakhir">
                {last ? (
                  <dl className="grid grid-cols-[160px_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
                    <dt className="text-muted">Waktu</dt>
                    <dd>{fmtDate(last.at)}</dd>
                    <dt className="text-muted">Build dihapus</dt>
                    <dd>{fmtNum(last.builds)}</dd>
                    <dt className="text-muted">Sesi dihapus</dt>
                    <dd>{fmtNum(last.sessions)}</dd>
                    <dt className="text-muted">Preview dihapus</dt>
                    <dd>
                      {fmtNum(last.previews)} (tidak pernah)
                    </dd>
                  </dl>
                ) : (
                  <p className="text-sm text-muted">Belum pernah ada pembersihan.</p>
                )}
              </Card>
              <Card title="Catatan">
                <p className="text-sm text-muted">
                  Preview adalah proses yang sedang berjalan — pembersihan tidak pernah mematikan
                  preview. Bila ada preview yang macet, hentikan dari halaman proyek atau restart
                  server.
                </p>
              </Card>
            </div>
          </div>
        </>
      )}

      <ConfirmDialog
        open={runConfirm}
        title="Jalankan pembersihan"
        message="Hapus sekarang semua build lama dan sesi kedaluwarsa sesuai retensi yang tersimpan? Preview yang berjalan tidak disentuh."
        confirmLabel="Ya, bersihkan"
        loading={busy}
        onConfirm={() => void doRun()}
        onCancel={() => setRunConfirm(false)}
      />
    </div>
  )
}

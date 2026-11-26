import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { useToast } from '../lib/toast'
import { PageHeader } from '../components/PageHeader'
import { Card } from '../components/Card'
import { Alert } from '../components/Alert'
import { Badge } from '../components/Badge'
import { Field } from '../components/Field'
import { Textarea } from '../components/Textarea'
import { Toggle } from '../components/Toggle'
import { Spinner } from '../components/Spinner'
import { btnPrimary } from '../components/DFormat'
import { fmtDate } from '../components/BFormat'
import { Wrench } from '@phosphor-icons/react'

interface Maintenance {
  enabled: boolean
  message: string
  updated_at: number | null
}

interface PemeliharaanPageProps {
  /** Disematkan di halaman gabungan: PageHeader induk disembunyikan. */
  embedded?: boolean
}

export default function PemeliharaanPage({ embedded = false }: PemeliharaanPageProps) {
  const toast = useToast()
  const [data, setData] = useState<Maintenance | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const s = await api.get<Maintenance>('/api/admin/maintenance')
      setData(s)
      setEnabled(!!s.enabled)
      setMessage(s.message || '')
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.message : 'Gagal memuat pengaturan pemeliharaan.',
      )
    }
  }, [toast])

  useEffect(() => {
    load()
  }, [load])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      await api.put('/api/admin/maintenance', { enabled, message })
      toast.success(
        enabled
          ? 'Mode pemeliharaan diaktifkan (tersimpan; halaman pengunjung menyusul).'
          : 'Mode pemeliharaan dimatikan.',
      )
      load()
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : 'Gagal menyimpan pemeliharaan.',
      )
    } finally {
      setSaving(false)
    }
  }

  const previewText = message.trim() || 'Belum ada pesan.'

  return (
    <div className="space-y-4">
      {!embedded ? (
        <PageHeader
          title="Pemeliharaan"
          description="Mode pemeliharaan untuk pengunjung. Pengaturan tersimpan di database."
        />
      ) : null}
      <Alert tone="warning">
        <strong>Belum berlaku.</strong> Mengaktifkan mode pemeliharaan di sini
        baru menyimpan pengaturannya. Halaman maintenance untuk pengunjung baru
        tampil setelah middleware di <code className="font-mono text-xs">app.ts</code>{' '}
        dipasang (tertunda).
      </Alert>

      <div className="grid gap-4 lg:grid-cols-7">
        <div className="min-w-0 lg:col-span-4">
          <Card title="Pengaturan Mode Pemeliharaan">
            {data === null ? (
              <Spinner label="Memuat…" />
            ) : (
              <form onSubmit={submit} autoComplete="off" className="space-y-4">
                <div className="flex items-center gap-3">
                  <Toggle
                    checked={enabled}
                    onChange={setEnabled}
                    label="Mode pemeliharaan aktif"
                  />
                  <span className="text-sm font-medium">Mode pemeliharaan aktif</span>
                </div>
                <Field
                  label="Pesan maintenance"
                  htmlFor="maintenance-message"
                  hint="Pesan yang dilihat pengunjung di halaman maintenance (maks 2000 karakter)."
                >
                  <Textarea
                    id="maintenance-message"
                    rows={4}
                    placeholder="cth. VibeBuilder sedang dalam pemeliharaan. Kami kembali sebentar lagi."
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                  />
                </Field>
                <div className="flex items-center gap-2">
                  <button type="submit" disabled={saving} className={btnPrimary}>
                    {saving ? 'Menyimpan…' : 'Simpan'}
                  </button>
                  <span className="text-sm text-muted">
                    {data.updated_at
                      ? `Terakhir disimpan ${fmtDate(data.updated_at)}`
                      : ''}
                  </span>
                </div>
              </form>
            )}
          </Card>
        </div>

        <div className="min-w-0 space-y-4 lg:col-span-3">
          <Card title="Pratinjau Pesan">
            <div className="rounded-lg border border-border p-3 text-center">
              <Wrench size={32} className="mx-auto text-muted" weight="regular" />
              <p className="mt-2 mb-0 text-sm">{previewText}</p>
            </div>
            <p className="mt-3 mb-0 text-sm text-muted">
              Pratinjau di atas mengikuti isi kolom pesan. Tampilan halaman
              maintenance sebenarnya ditentukan oleh middleware penyajian (belum
              dipasang).
            </p>
          </Card>

          <Card title="Status Saat Ini">
            {data === null ? (
              <Spinner label="Memuat…" />
            ) : data.enabled ? (
              <>
                <p className="mb-1">
                  <Badge tone="success">Mode pemeliharaan AKTIF</Badge>
                </p>
                <p className="mb-0 text-sm text-muted">
                  Pengaturan tersimpan, tapi halaman maintenance untuk pengunjung
                  belum tampil — middleware penyajian belum dipasang.
                </p>
              </>
            ) : (
              <>
                <p className="mb-1">
                  <Badge tone="success">Mode pemeliharaan nonaktif</Badge>
                </p>
                <p className="mb-0 text-sm text-muted">Situs berjalan normal.</p>
              </>
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}

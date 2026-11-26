import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { useToast } from '../lib/toast'
import { PageHeader } from '../components/PageHeader'
import { Card } from '../components/Card'
import { Spinner } from '../components/Spinner'
import { fmtBytes } from '../components/BFormat'

interface SettingsData {
  model: string
  modelStrong: string
  modelAudit: string
  endpoint: string
  keyConfigured: boolean
  llmHost: string
  publicSuffix: string
  publicOrigin: string
  dbPath: string
  dbSize: number
  signupOpen: boolean
  admin: { email: string; via: 'env' | 'first-account' } | null
}

export default function SettingsPage() {
  const toast = useToast()
  const [data, setData] = useState<SettingsData | null>(null)

  const load = useCallback(async () => {
    try {
      const s = await api.get<SettingsData>('/api/admin/settings')
      setData(s)
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.message : 'Gagal memuat pengaturan.',
      )
    }
  }, [toast])

  useEffect(() => {
    load()
  }, [load])

  const rows: Array<[string, string]> = data
    ? [
        ['Domain publik', `${data.publicSuffix} (${data.publicOrigin})`],
        ['Database', `${data.dbPath} (${fmtBytes(data.dbSize)})`],
        [
          'Pendaftaran',
          data.signupOpen
            ? 'Terbuka (belum ada pengguna)'
            : 'Tertutup (sudah ada pengguna)',
        ],
      ]
    : []

  return (
    <div className="space-y-4">
      <PageHeader
        title="Pengaturan"
        description="Konfigurasi server saat ini (tampilan saja)."
      />

      <div className="grid gap-4 lg:grid-cols-7">
        <div className="min-w-0 lg:col-span-4">
          <Card title="Konfigurasi">
            {data === null ? (
              <Spinner label="Memuat…" />
            ) : (
              <dl className="mb-0">
                {rows.map(([k, v]) => (
                  <div
                    key={k}
                    className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-[160px_minmax(0,1fr)]"
                  >
                    <dt className="text-sm text-muted">{k}</dt>
                    <dd className="font-mono text-sm break-words">{v}</dd>
                  </div>
                ))}
              </dl>
            )}
          </Card>
        </div>

        <div className="min-w-0 space-y-4 lg:col-span-3">
          <Card title="Admin">
            {data === null ? (
              <Spinner label="Memuat…" />
            ) : data.admin ? (
              <>
                <p className="mb-1 text-sm">
                  <strong>{data.admin.email}</strong>
                </p>
                <p className="mb-0 text-sm text-muted">
                  Ditentukan lewat{' '}
                  {data.admin.via === 'env' ? (
                    <>
                      environment{' '}
                      <code className="font-mono text-xs">VB_ADMIN_EMAIL</code>
                    </>
                  ) : (
                    'akun pertama yang dibuat (pemilik instalasi)'
                  )}
                  .
                </p>
              </>
            ) : (
              <p className="mb-0 text-sm text-muted">
                Belum ada pengguna, jadi belum ada admin.
              </p>
            )}
          </Card>

          <Card title="Catatan">
            <p className="mb-0 text-sm text-muted">
              Model dan provider LLM bisa diubah dari halaman{' '}
              <strong>AI</strong> (tab Pengaturan, tersimpan di database, berlaku
              tanpa restart). Akun admin adalah akun pertama yang dibuat,
              kecuali <code className="font-mono text-xs">VB_ADMIN_EMAIL</code>{' '}
              diset.
            </p>
          </Card>
        </div>
      </div>
    </div>
  )
}

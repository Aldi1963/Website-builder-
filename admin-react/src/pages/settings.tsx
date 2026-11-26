import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { useToast } from '../lib/toast'
import { PageHeader } from '../components/PageHeader'
import { Card } from '../components/Card'
import { Spinner } from '../components/Spinner'
import { fmtBytes } from '../components/BFormat'
import { SectionNav, PageSection, type SectionNavItem } from '../components/SectionNav'
import { ApiKeysSection } from '../components/ApiKeysSection'
import { Gear, Key, ShieldCheck } from '@phosphor-icons/react'

interface SettingsData {
  publicSuffix: string
  publicOrigin: string
  dbPath: string
  dbSize: number
  signupOpen: boolean
  admin: { email: string; via: 'env' | 'first-account' } | null
}

interface SettingsPageProps {
  /** Disematkan di halaman gabungan: PageHeader induk disembunyikan. */
  embedded?: boolean
}

const sections: SectionNavItem[] = [
  { id: 'api-keys', label: 'API Key & Secret', description: 'Semua kredensial dalam satu tempat', icon: Key },
  { id: 'konfigurasi', label: 'Konfigurasi', description: 'Domain, database, pendaftaran', icon: Gear },
  { id: 'admin-akses', label: 'Akses Admin', description: 'Akun admin & catatan', icon: ShieldCheck },
]

export default function SettingsPage({ embedded = false }: SettingsPageProps) {
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
    void load()
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
    <div className="space-y-6">
      {!embedded ? (
        <PageHeader
          title="Pengaturan"
          description="Semua API key, secret, dan konfigurasi server dalam satu halaman."
        />
      ) : null}
      <SectionNav items={sections} />

      <PageSection
        id="api-keys"
        index={1}
        title="API Key & Secret"
        description="Satu tempat untuk semua kredensial: LLM, pembayaran, dan provider."
        icon={Key}
      >
        <ApiKeysSection />
      </PageSection>

      <PageSection
        id="konfigurasi"
        index={2}
        title="Konfigurasi"
        description="Informasi server saat ini (tampilan saja)."
        icon={Gear}
      >
        <Card>
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
      </PageSection>

      <PageSection
        id="admin-akses"
        index={3}
        title="Akses Admin"
        description="Akun admin dan catatan konfigurasi."
        icon={ShieldCheck}
      >
        <div className="grid gap-4 lg:grid-cols-2">
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
              Model, endpoint, biaya, dan penggunaan LLM ada di halaman{' '}
              <strong>AI</strong>. Semua kredensial — termasuk kunci LLM,
              pembayaran, dan provider — dikelola di bagian{' '}
              <strong>API Key &amp; Secret</strong> di halaman ini. Nilai key tidak
              pernah ditampilkan, hanya status terpasang/sumbernya.
            </p>
          </Card>
        </div>
      </PageSection>
    </div>
  )
}

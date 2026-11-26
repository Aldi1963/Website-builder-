import { useEffect } from 'react'
import { NAVIGATE_EVENT, navigate, useRoute } from '../lib/router'
import { PageHeader } from '../components/PageHeader'
import { Spinner } from '../components/Spinner'
import HealthPage from './health'
import CadanganPage from './cadangan'
import PembersihanPage from './pembersihan'
import PemeliharaanPage from './pemeliharaan'
import SettingsPage from './settings'
import SessionsPage from './sessions'
import BuildsPage from './builds'

/* Halaman "Sistem": gabungan 7 halaman lama menjadi satu
   halaman bertab. Isi tiap tab adalah komponen halaman asalnya — tidak
   diubah, hanya dipindah ke dalam tab. Tab aktif dibaca dari query
   ?tab= (default: health). URL lama tetap jalan lewat komponen
   redirect di bawah (replaceState ke URL bersih). */

export type SistemTabId = 'health' | 'cadangan' | 'pembersihan' | 'pemeliharaan' | 'settings' | 'sessions' | 'builds'

const TABS: Array<{ id: SistemTabId; label: string; Page: () => React.JSX.Element }> = [
  { id: 'health', label: 'Kesehatan', Page: HealthPage },
  { id: 'cadangan', label: 'Cadangan', Page: CadanganPage },
  { id: 'pembersihan', label: 'Pembersihan', Page: PembersihanPage },
  { id: 'pemeliharaan', label: 'Pemeliharaan', Page: PemeliharaanPage },
  { id: 'settings', label: 'Pengaturan', Page: SettingsPage },
  { id: 'sessions', label: 'Sesi', Page: SessionsPage },
  { id: 'builds', label: 'Build', Page: BuildsPage },
]

function readTab(): SistemTabId {
  const tab = new URLSearchParams(window.location.search).get('tab')
  if (tab === 'health' || tab === 'cadangan' || tab === 'pembersihan' || tab === 'pemeliharaan' || tab === 'settings' || tab === 'sessions' || tab === 'builds') return tab as SistemTabId
  return 'health'
}

export default function SistemPage() {
  /* RouterProvider me-render ulang tiap navigate/popstate, sehingga
     perubahan ?tab= langsung tercermin di sini. */
  useRoute()
  const active = readTab()
  const ActivePage = TABS.find((t) => t.id === active)?.Page ?? TABS[0].Page

  return (
    <div className="space-y-4">
      <PageHeader title="Sistem" description="Kesehatan, cadangan, pembersihan, pemeliharaan, pengaturan, sesi, dan build dalam satu halaman." />
      <div className="flex gap-1 overflow-x-auto border-b border-border" role="tablist" aria-label="Sistem">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active === t.id}
            onClick={() => navigate(`/admin/sistem?tab=${t.id}`)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap ${
              active === t.id
                ? 'border-accent text-accent'
                : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <ActivePage />
    </div>
  )
}

/* Redirect URL lama ke tab yang benar. replaceState mencegah tombol
   kembali berputar di URL lama. */
function TabRedirect({ tab }: { tab: SistemTabId }) {
  useEffect(() => {
    window.history.replaceState(null, '', `/admin/sistem?tab=${tab}`)
    window.dispatchEvent(new Event(NAVIGATE_EVENT))
  }, [tab])
  return (
    <div className="flex justify-center py-16">
      <Spinner label="Memuat halaman…" />
    </div>
  )
}

export const HealthRedirect = () => <TabRedirect tab="health" />
export const CadanganRedirect = () => <TabRedirect tab="cadangan" />
export const PembersihanRedirect = () => <TabRedirect tab="pembersihan" />
export const PemeliharaanRedirect = () => <TabRedirect tab="pemeliharaan" />
export const SettingsRedirect = () => <TabRedirect tab="settings" />
export const SessionsRedirect = () => <TabRedirect tab="sessions" />
export const BuildsRedirect = () => <TabRedirect tab="builds" />

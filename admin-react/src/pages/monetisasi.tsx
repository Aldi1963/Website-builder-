import { useEffect } from 'react'
import { NAVIGATE_EVENT, navigate, useRoute } from '../lib/router'
import { PageHeader } from '../components/PageHeader'
import { Spinner } from '../components/Spinner'
import PlansPage from './plans'
import CreditsPage from './credits'
import BillingPage from './billing'

/* Halaman "Monetisasi": gabungan 3 halaman lama menjadi satu
   halaman bertab. Isi tiap tab adalah komponen halaman asalnya — tidak
   diubah, hanya dipindah ke dalam tab. Tab aktif dibaca dari query
   ?tab= (default: plans). URL lama tetap jalan lewat komponen
   redirect di bawah (replaceState ke URL bersih). */

export type MonetisasiTabId = 'plans' | 'credits' | 'billing'

const TABS: Array<{ id: MonetisasiTabId; label: string; Page: () => React.JSX.Element }> = [
  { id: 'plans', label: 'Plan', Page: PlansPage },
  { id: 'credits', label: 'Credit', Page: CreditsPage },
  { id: 'billing', label: 'Pembayaran', Page: BillingPage },
]

function readTab(): MonetisasiTabId {
  const tab = new URLSearchParams(window.location.search).get('tab')
  if (tab === 'plans' || tab === 'credits' || tab === 'billing') return tab as MonetisasiTabId
  return 'plans'
}

export default function MonetisasiPage() {
  /* RouterProvider me-render ulang tiap navigate/popstate, sehingga
     perubahan ?tab= langsung tercermin di sini. */
  useRoute()
  const active = readTab()
  const ActivePage = TABS.find((t) => t.id === active)?.Page ?? TABS[0].Page

  return (
    <div className="space-y-4">
      <PageHeader title="Monetisasi" description="Plan, credit, dan pembayaran dalam satu halaman." />
      <div className="flex gap-1 overflow-x-auto border-b border-border" role="tablist" aria-label="Monetisasi">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active === t.id}
            onClick={() => navigate(`/admin/monetisasi?tab=${t.id}`)}
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
function TabRedirect({ tab }: { tab: MonetisasiTabId }) {
  useEffect(() => {
    window.history.replaceState(null, '', `/admin/monetisasi?tab=${tab}`)
    window.dispatchEvent(new Event(NAVIGATE_EVENT))
  }, [tab])
  return (
    <div className="flex justify-center py-16">
      <Spinner label="Memuat halaman…" />
    </div>
  )
}

export const PlansRedirect = () => <TabRedirect tab="plans" />
export const CreditsRedirect = () => <TabRedirect tab="credits" />
export const BillingRedirect = () => <TabRedirect tab="billing" />

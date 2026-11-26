import { useEffect } from 'react'
import { NAVIGATE_EVENT, navigate, useRoute } from '../lib/router'
import { PageHeader } from '../components/PageHeader'
import { Spinner } from '../components/Spinner'
import MessagesPage from './messages'
import PengumumanPage from './pengumuman'
import AuditPage from './audit'

/* Halaman "Komunikasi": gabungan 3 halaman lama menjadi satu
   halaman bertab. Isi tiap tab adalah komponen halaman asalnya — tidak
   diubah, hanya dipindah ke dalam tab. Tab aktif dibaca dari query
   ?tab= (default: messages). URL lama tetap jalan lewat komponen
   redirect di bawah (replaceState ke URL bersih). */

export type KomunikasiTabId = 'messages' | 'pengumuman' | 'audit'

const TABS: Array<{ id: KomunikasiTabId; label: string; Page: () => React.JSX.Element }> = [
  { id: 'messages', label: 'Pesan', Page: MessagesPage },
  { id: 'pengumuman', label: 'Pengumuman', Page: PengumumanPage },
  { id: 'audit', label: 'Log Audit', Page: AuditPage },
]

function readTab(): KomunikasiTabId {
  const tab = new URLSearchParams(window.location.search).get('tab')
  if (tab === 'messages' || tab === 'pengumuman' || tab === 'audit') return tab as KomunikasiTabId
  return 'messages'
}

export default function KomunikasiPage() {
  /* RouterProvider me-render ulang tiap navigate/popstate, sehingga
     perubahan ?tab= langsung tercermin di sini. */
  useRoute()
  const active = readTab()
  const ActivePage = TABS.find((t) => t.id === active)?.Page ?? TABS[0].Page

  return (
    <div className="space-y-4">
      <PageHeader title="Komunikasi" description="Pesan, pengumuman, dan log audit dalam satu halaman." />
      <div className="flex gap-1 overflow-x-auto border-b border-border" role="tablist" aria-label="Komunikasi">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active === t.id}
            onClick={() => navigate(`/admin/komunikasi?tab=${t.id}`)}
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
function TabRedirect({ tab }: { tab: KomunikasiTabId }) {
  useEffect(() => {
    window.history.replaceState(null, '', `/admin/komunikasi?tab=${tab}`)
    window.dispatchEvent(new Event(NAVIGATE_EVENT))
  }, [tab])
  return (
    <div className="flex justify-center py-16">
      <Spinner label="Memuat halaman…" />
    </div>
  )
}

export const MessagesRedirect = () => <TabRedirect tab="messages" />
export const PengumumanRedirect = () => <TabRedirect tab="pengumuman" />
export const AuditRedirect = () => <TabRedirect tab="audit" />

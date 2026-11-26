import { useEffect } from 'react'
import { NAVIGATE_EVENT, navigate, useRoute } from '../lib/router'
import { PageHeader } from '../components/PageHeader'
import { Spinner } from '../components/Spinner'
import ProjectsPage from './projects'
import ModerasiPage from './moderasi'
import DomainPage from './domain'

/* Halaman "Konten": gabungan 3 halaman lama menjadi satu
   halaman bertab. Isi tiap tab adalah komponen halaman asalnya — tidak
   diubah, hanya dipindah ke dalam tab. Tab aktif dibaca dari query
   ?tab= (default: projects). URL lama tetap jalan lewat komponen
   redirect di bawah (replaceState ke URL bersih). */

export type KontenTabId = 'projects' | 'moderasi' | 'domain'

const TABS: Array<{ id: KontenTabId; label: string; Page: () => React.JSX.Element }> = [
  { id: 'projects', label: 'Proyek', Page: ProjectsPage },
  { id: 'moderasi', label: 'Moderasi', Page: ModerasiPage },
  { id: 'domain', label: 'Domain', Page: DomainPage },
]

function readTab(): KontenTabId {
  const tab = new URLSearchParams(window.location.search).get('tab')
  if (tab === 'projects' || tab === 'moderasi' || tab === 'domain') return tab as KontenTabId
  return 'projects'
}

export default function KontenPage() {
  /* RouterProvider me-render ulang tiap navigate/popstate, sehingga
     perubahan ?tab= langsung tercermin di sini. */
  useRoute()
  const active = readTab()
  const ActivePage = TABS.find((t) => t.id === active)?.Page ?? TABS[0].Page

  return (
    <div className="space-y-4">
      <PageHeader title="Konten" description="Proyek, moderasi, dan domain dalam satu halaman." />
      <div className="flex gap-1 overflow-x-auto border-b border-border" role="tablist" aria-label="Konten">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active === t.id}
            onClick={() => navigate(`/admin/konten?tab=${t.id}`)}
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
function TabRedirect({ tab }: { tab: KontenTabId }) {
  useEffect(() => {
    window.history.replaceState(null, '', `/admin/konten?tab=${tab}`)
    window.dispatchEvent(new Event(NAVIGATE_EVENT))
  }, [tab])
  return (
    <div className="flex justify-center py-16">
      <Spinner label="Memuat halaman…" />
    </div>
  )
}

export const ProjectsRedirect = () => <TabRedirect tab="projects" />
export const ModerasiRedirect = () => <TabRedirect tab="moderasi" />
export const DomainRedirect = () => <TabRedirect tab="domain" />

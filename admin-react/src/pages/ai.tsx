import { useEffect } from 'react'
import { NAVIGATE_EVENT, navigate, useRoute } from '../lib/router'
import { PageHeader } from '../components/PageHeader'
import { Spinner } from '../components/Spinner'
import AiSettingsPage from './ai-settings'
import BiayaPage from './biaya'
import ProvidersPage from './providers'
import UsagePage from './usage'

/* Halaman "AI": gabungan 4 halaman lama (Provider LLM, Pengaturan AI,
   Biaya LLM, Penggunaan) menjadi satu halaman bertab. Isi tiap tab
   adalah komponen halaman asalnya — tidak diubah, hanya dipindah ke
   dalam tab. Tab aktif dibaca dari query ?tab= (default: providers).
   URL lama (/admin/providers, /admin/ai-settings, /admin/biaya,
   /admin/usage) tetap jalan lewat komponen redirect di bawah. */

export type AiTabId = 'providers' | 'settings' | 'biaya' | 'usage'

const TABS: Array<{ id: AiTabId; label: string; Page: () => React.JSX.Element }> = [
  { id: 'providers', label: 'Provider & Model', Page: ProvidersPage },
  { id: 'settings', label: 'Pengaturan', Page: AiSettingsPage },
  { id: 'biaya', label: 'Biaya', Page: BiayaPage },
  { id: 'usage', label: 'Penggunaan', Page: UsagePage },
]

function readTab(): AiTabId {
  const tab = new URLSearchParams(window.location.search).get('tab')
  if (tab === 'settings' || tab === 'biaya' || tab === 'usage' || tab === 'providers') return tab
  return 'providers'
}

export default function AiPage() {
  /* Langganan perubahan route supaya ganti ?tab me-render ulang
     (RouterProvider me-render ulang tiap navigate/popstate). */
  useRoute()
  const active = readTab()
  const ActivePage = TABS.find((t) => t.id === active)?.Page ?? ProvidersPage

  return (
    <div className="space-y-4">
      <PageHeader
        title="AI"
        description="Provider, model, pengaturan, biaya, dan penggunaan LLM."
      />
      <div className="flex gap-1 overflow-x-auto border-b border-border" role="tablist" aria-label="AI">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active === t.id}
            onClick={() => navigate(`/admin/ai?tab=${t.id}`)}
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

/* Redirect URL lama ke tab yang benar (URL bersih /admin/ai?tab=...).
   Memakai replaceState supaya tombol kembali tidak berputar di URL lama. */
function AiTabRedirect({ tab }: { tab: AiTabId }) {
  useEffect(() => {
    window.history.replaceState(null, '', `/admin/ai?tab=${tab}`)
    window.dispatchEvent(new Event(NAVIGATE_EVENT))
  }, [tab])
  return (
    <div className="flex justify-center py-16">
      <Spinner label="Memuat halaman…" />
    </div>
  )
}

export const ProvidersRedirect = () => <AiTabRedirect tab="providers" />
export const AiSettingsRedirect = () => <AiTabRedirect tab="settings" />
export const BiayaRedirect = () => <AiTabRedirect tab="biaya" />
export const UsageRedirect = () => <AiTabRedirect tab="usage" />

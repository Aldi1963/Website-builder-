import { useEffect } from 'react'
import {
  CurrencyDollar,
  Gear,
  Plug,
  Robot,
} from '@phosphor-icons/react'
import { NAVIGATE_EVENT } from '../lib/router'
import { PageHeader } from '../components/PageHeader'
import { Spinner } from '../components/Spinner'
import { SectionNav, PageSection, type SectionNavItem } from '../components/SectionNav'
import ProvidersPage from './providers'
import AiSettingsPage from './ai-settings'
import BiayaPage from './biaya'

/* Halaman "AI": tiga fitur asli (Provider, Pengaturan AI, Biaya &
   Penggunaan) disusun bertumpuk dalam SATU halaman, tanpa tab / query
   parameter tab. Usage digabung ke Biaya 28 Nov 2026 (tumpang tindih).
   Peta halaman menggantikan tumpukan heading polos; tiap bagian punya anchor
   sendiri. URL lama tetap jalan lewat komponen redirect di bawah (kompatibilitas). */

const sections: SectionNavItem[] = [
  { id: 'providers', label: 'Provider', description: 'Kelola provider & tarif model', icon: Plug },
  { id: 'ai-settings', label: 'Pengaturan AI', description: 'Model default, endpoint, koneksi', icon: Gear },
  { id: 'biaya', label: 'Biaya & Penggunaan', description: 'Perkiraan biaya, harga per model & aktivitas penggunaan', icon: CurrencyDollar },
]

export default function AiPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="AI"
        description="Provider, model, pengaturan, serta biaya & penggunaan LLM."
        actions={
          <a
            href="#providers"
            className="whitespace-nowrap rounded-lg border border-border px-3 py-2 text-sm hover:bg-surface-muted"
          >
            Lihat provider
          </a>
        }
      />
      <SectionNav items={sections} />
      <PageSection
        id="providers"
        index={1}
        title="Provider"
        description="Kelola provider & tarif model."
        icon={Robot}
      >
        <ProvidersPage embedded />
      </PageSection>
      <PageSection
        id="ai-settings"
        index={2}
        title="Pengaturan AI"
        description="Model default, endpoint, dan koneksi."
        icon={Gear}
      >
        <AiSettingsPage embedded />
      </PageSection>
      <PageSection
        id="biaya"
        index={3}
        title="Biaya & Penggunaan"
        description="Perkiraan biaya, harga per model & aktivitas penggunaan."
        icon={CurrencyDollar}
      >
        <BiayaPage embedded />
      </PageSection>
    </div>
  )
}

function PageRedirect() {
  useEffect(() => {
    window.history.replaceState(null, '', '/admin/ai')
    window.dispatchEvent(new Event(NAVIGATE_EVENT))
  }, [])
  return (
    <div className="flex justify-center py-16">
      <Spinner label="Memuat halaman…" />
    </div>
  )
}

export const ProvidersRedirect = PageRedirect
export const AiSettingsRedirect = PageRedirect
export const BiayaRedirect = PageRedirect

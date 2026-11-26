import { useEffect } from 'react'
import { NAVIGATE_EVENT } from '../lib/router'
import { PageHeader } from '../components/PageHeader'
import { Spinner } from '../components/Spinner'
import ProvidersPage from './providers'
import AiSettingsPage from './ai-settings'
import BiayaPage from './biaya'
import UsagePage from './usage'

/* Halaman "AI": empat fitur asli (Provider, Pengaturan AI, Biaya, Usage)
   disusun bertumpuk dalam SATU halaman, tanpa tab / query parameter tab. URL lama
   (/admin/providers, /admin/ai-settings, /admin/biaya, /admin/usage)
   tetap jalan lewat komponen redirect di bawah, mengarah ke /admin/ai. */

export default function AiPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="AI" description="Provider, model, pengaturan, biaya, dan penggunaan LLM." />
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">{'Provider'}</h2>
        <ProvidersPage embedded />
      </section>
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">{'Pengaturan AI'}</h2>
        <AiSettingsPage embedded />
      </section>
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">{'Biaya'}</h2>
        <BiayaPage embedded />
      </section>
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">{'Usage'}</h2>
        <UsagePage embedded />
      </section>
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
export const UsageRedirect = PageRedirect

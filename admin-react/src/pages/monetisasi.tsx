import { useEffect } from 'react'
import { Coins, CreditCard, Medal } from '@phosphor-icons/react'
import { NAVIGATE_EVENT } from '../lib/router'
import { PageHeader } from '../components/PageHeader'
import { Spinner } from '../components/Spinner'
import { SectionNav, PageSection, type SectionNavItem } from '../components/SectionNav'
import PlansPage from './plans'
import CreditsPage from './credits'
import BillingPage from './billing'

/* Halaman "Monetisasi": tiga fitur asli disusun bertumpuk dalam SATU halaman,
   tanpa tab / query parameter tab. */

const sections: SectionNavItem[] = [
  { id: 'plans', label: 'Plan', description: 'Paket langganan & batasnya', icon: Medal },
  { id: 'credits', label: 'Credit', description: 'Saldo & kelola kredit pengguna', icon: Coins },
  { id: 'billing', label: 'Pembayaran', description: 'Transaksi & riwayat tagihan', icon: CreditCard },
]

export default function MonetisasiPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Monetisasi" description="Plan, credit, dan pembayaran dalam satu halaman." />
      <SectionNav items={sections} />
      <PageSection id="plans" index={1} title="Plan" description="Paket langganan & batasnya." icon={Medal}>
        <PlansPage embedded />
      </PageSection>
      <PageSection id="credits" index={2} title="Credit" description="Saldo & kelola kredit pengguna." icon={Coins}>
        <CreditsPage embedded />
      </PageSection>
      <PageSection id="billing" index={3} title="Pembayaran" description="Transaksi & riwayat tagihan." icon={CreditCard}>
        <BillingPage embedded />
      </PageSection>
    </div>
  )
}

function PageRedirect() {
  useEffect(() => {
    window.history.replaceState(null, '', '/admin/monetisasi')
    window.dispatchEvent(new Event(NAVIGATE_EVENT))
  }, [])
  return (
    <div className="flex justify-center py-16">
      <Spinner label="Memuat halaman…" />
    </div>
  )
}

export const PlansRedirect = PageRedirect
export const CreditsRedirect = PageRedirect
export const BillingRedirect = PageRedirect

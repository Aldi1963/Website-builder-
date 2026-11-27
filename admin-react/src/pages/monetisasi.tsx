import { useEffect } from 'react'
import { Coins, CreditCard, Ticket } from '@phosphor-icons/react'
import { NAVIGATE_EVENT } from '../lib/router'
import { PageHeader } from '../components/PageHeader'
import { Spinner } from '../components/Spinner'
import { SectionNav, PageSection, type SectionNavItem } from '../components/SectionNav'
import CreditsPage from './credits'
import BillingPage from './billing'
import RedeemPage from './redeem'

/* Halaman "Monetisasi": saldo credit dan top-up paket credit dalam SATU
   halaman, tanpa tab / query parameter tab / model paket bulanan. */

const sections: SectionNavItem[] = [
  { id: 'credits', label: 'Kelola Credit', description: 'Saldo & kelola kredit pengguna', icon: Coins },
  { id: 'billing', label: 'Paket Credit', description: 'Top-up paket credit lewat QRIS', icon: CreditCard },
  { id: 'redeem', label: 'Kode Redeem', description: 'Kode penukaran credit untuk pengguna', icon: Ticket },
]

export default function MonetisasiPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Monetisasi" description="Isi credit, lihat saldo, dan top-up paket — tanpa langganan bulanan." />
      <SectionNav items={sections} />
      <PageSection id="credits" index={1} title="Kelola Credit" description="Saldo & kelola kredit pengguna." icon={Coins}>
        <CreditsPage embedded />
      </PageSection>
      <PageSection id="billing" index={2} title="Paket Credit" description="Top-up paket credit lewat QRIS." icon={CreditCard}>
        <BillingPage embedded />
      </PageSection>
      <PageSection id="redeem" index={3} title="Kode Redeem" description="Kode penukaran credit untuk pengguna." icon={Ticket}>
        <RedeemPage embedded />
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

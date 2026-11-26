import { useEffect } from 'react'
import { NAVIGATE_EVENT } from '../lib/router'
import { PageHeader } from '../components/PageHeader'
import { Spinner } from '../components/Spinner'
import PlansPage from './plans'
import CreditsPage from './credits'
import BillingPage from './billing'

/* Halaman "Monetisasi": tiga fitur asli disusun bertumpuk dalam SATU
   halaman, tanpa tab / query parameter tab. URL lama tetap jalan lewat komponen
   redirect di bawah (replaceState ke URL bersih). */

export default function MonetisasiPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Monetisasi" description="Plan, credit, dan pembayaran dalam satu halaman." />
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">{'Plan'}</h2>
        <PlansPage embedded />
      </section>
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">{'Credit'}</h2>
        <CreditsPage embedded />
      </section>
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">{'Pembayaran'}</h2>
        <BillingPage embedded />
      </section>
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

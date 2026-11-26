import { useEffect } from 'react'
import { NAVIGATE_EVENT } from '../lib/router'
import { PageHeader } from '../components/PageHeader'
import { Spinner } from '../components/Spinner'
import MessagesPage from './messages'
import PengumumanPage from './pengumuman'
import AuditPage from './audit'

/* Halaman "Komunikasi": tiga fitur asli disusun bertumpuk dalam SATU
   halaman, tanpa tab / query parameter tab. URL lama tetap jalan lewat komponen
   redirect di bawah (replaceState ke URL bersih). */

export default function KomunikasiPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Komunikasi" description="Pesan, pengumuman, dan log audit dalam satu halaman." />
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">{'Pesan'}</h2>
        <MessagesPage embedded />
      </section>
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">{'Pengumuman'}</h2>
        <PengumumanPage embedded />
      </section>
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">{'Log Audit'}</h2>
        <AuditPage embedded />
      </section>
    </div>
  )
}

function PageRedirect() {
  useEffect(() => {
    window.history.replaceState(null, '', '/admin/komunikasi')
    window.dispatchEvent(new Event(NAVIGATE_EVENT))
  }, [])
  return (
    <div className="flex justify-center py-16">
      <Spinner label="Memuat halaman…" />
    </div>
  )
}

export const MessagesRedirect = PageRedirect
export const PengumumanRedirect = PageRedirect
export const AuditRedirect = PageRedirect

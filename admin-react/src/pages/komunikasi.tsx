import { useEffect } from 'react'
import { ClockCounterClockwise } from '@phosphor-icons/react'
import { NAVIGATE_EVENT } from '../lib/router'
import { PageHeader } from '../components/PageHeader'
import { Spinner } from '../components/Spinner'
import { SectionNav, PageSection, type SectionNavItem } from '../components/SectionNav'
import AuditPage from './audit'

/* Halaman "Komunikasi": kini hanya Log Audit (Pesan & Pengumuman dihapus
   28 Nov 2026 — jarang kepakai, lihat audit panel admin). */

const sections: SectionNavItem[] = [
  { id: 'audit', label: 'Log Audit', description: 'Jejak aktivitas admin', icon: ClockCounterClockwise },
]

export default function KomunikasiPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Komunikasi" description="Log audit dalam satu halaman." />
      <SectionNav items={sections} />
      <PageSection id="audit" index={1} title="Log Audit" description="Jejak aktivitas admin." icon={ClockCounterClockwise}>
        <AuditPage embedded />
      </PageSection>
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

export const AuditRedirect = PageRedirect

import { useEffect } from 'react'
import { ChatText, ClockCounterClockwise, Megaphone } from '@phosphor-icons/react'
import { NAVIGATE_EVENT } from '../lib/router'
import { PageHeader } from '../components/PageHeader'
import { Spinner } from '../components/Spinner'
import { SectionNav, PageSection, type SectionNavItem } from '../components/SectionNav'
import MessagesPage from './messages'
import PengumumanPage from './pengumuman'
import AuditPage from './audit'

/* Halaman "Komunikasi": tiga fitur asli disusun bertumpuk dalam SATU halaman,
   tanpa tab / query parameter tab. */

const sections: SectionNavItem[] = [
  { id: 'messages', label: 'Pesan', description: 'Pesan masuk & balasan pengguna', icon: ChatText },
  { id: 'pengumuman', label: 'Pengumuman', description: 'Broadcast & pengumuman panel', icon: Megaphone },
  { id: 'audit', label: 'Log Audit', description: 'Jejak aktivitas admin', icon: ClockCounterClockwise },
]

export default function KomunikasiPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Komunikasi" description="Pesan, pengumuman, dan log audit dalam satu halaman." />
      <SectionNav items={sections} />
      <PageSection id="messages" index={1} title="Pesan" description="Pesan masuk & balasan pengguna." icon={ChatText}>
        <MessagesPage embedded />
      </PageSection>
      <PageSection id="pengumuman" index={2} title="Pengumuman" description="Broadcast & pengumuman panel." icon={Megaphone}>
        <PengumumanPage embedded />
      </PageSection>
      <PageSection id="audit" index={3} title="Log Audit" description="Jejak aktivitas admin." icon={ClockCounterClockwise}>
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

export const MessagesRedirect = PageRedirect
export const PengumumanRedirect = PageRedirect
export const AuditRedirect = PageRedirect

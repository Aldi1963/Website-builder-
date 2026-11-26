import { useEffect } from 'react'
import { Cube, Flag, Link as LinkIcon } from '@phosphor-icons/react'
import { NAVIGATE_EVENT } from '../lib/router'
import { PageHeader } from '../components/PageHeader'
import { Spinner } from '../components/Spinner'
import { SectionNav, PageSection, type SectionNavItem } from '../components/SectionNav'
import ProjectsPage from './projects'
import ModerasiPage from './moderasi'
import DomainPage from './domain'

/* Halaman "Konten": tiga fitur asli disusun bertumpuk dalam SATU halaman.
   Tanpa tab / query parameter tab. Peta halaman + section ber-anchor. */

const sections: SectionNavItem[] = [
  { id: 'projects', label: 'Daftar Proyek', description: 'Proyek builder & statusnya', icon: Cube },
  { id: 'moderasi', label: 'Moderasi', description: 'Laporan & tindakan moderasi', icon: Flag },
  { id: 'domain', label: 'Domain', description: 'Domain kustom & verifikasi', icon: LinkIcon },
]

export default function KontenPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Konten" description="Proyek, moderasi, dan domain dalam satu halaman." />
      <SectionNav items={sections} />
      <PageSection id="projects" index={1} title="Daftar Proyek" description="Proyek builder & statusnya." icon={Cube}>
        <ProjectsPage embedded />
      </PageSection>
      <PageSection id="moderasi" index={2} title="Moderasi" description="Laporan & tindakan moderasi." icon={Flag}>
        <ModerasiPage embedded />
      </PageSection>
      <PageSection id="domain" index={3} title="Domain" description="Domain kustom & verifikasi." icon={LinkIcon}>
        <DomainPage embedded />
      </PageSection>
    </div>
  )
}

/* Redirect URL lama ke halaman induk (kompatibilitas). */
function PageRedirect() {
  useEffect(() => {
    window.history.replaceState(null, '', '/admin/konten')
    window.dispatchEvent(new Event(NAVIGATE_EVENT))
  }, [])
  return (
    <div className="flex justify-center py-16">
      <Spinner label="Memuat halaman…" />
    </div>
  )
}

export const ProjectsRedirect = PageRedirect
export const ModerasiRedirect = PageRedirect
export const DomainRedirect = PageRedirect

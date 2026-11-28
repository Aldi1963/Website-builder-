import { useEffect } from 'react'
import {
  Archive,
  Gear,
  Hammer,
  Heartbeat,
  Key,
} from '@phosphor-icons/react'
import { NAVIGATE_EVENT } from '../lib/router'
import { PageHeader } from '../components/PageHeader'
import { Spinner } from '../components/Spinner'
import { SectionNav, PageSection, type SectionNavItem } from '../components/SectionNav'
import HealthPage from './health'
import CadanganPage from './cadangan'
import SettingsPage from './settings'
import SessionsPage from './sessions'
import BuildsPage from './builds'

/* Halaman "Sistem": lima fitur asli disusun bertumpuk dalam SATU halaman,
   tanpa tab / query parameter tab. Pembersihan & Pemeliharaan dihapus
   28 Nov 2026 (jarang kepakai, lihat audit panel admin). */

const sections: SectionNavItem[] = [
  { id: 'health', label: 'Kesehatan', description: 'Status layanan & koneksi LLM', icon: Heartbeat },
  { id: 'cadangan', label: 'Cadangan', description: 'Backup & restore data', icon: Archive },
  { id: 'settings', label: 'Pengaturan', description: 'Konfigurasi panel admin', icon: Gear },
  { id: 'sessions', label: 'Sesi', description: 'Sesi aktif & pencabutan', icon: Key },
  { id: 'builds', label: 'Build', description: 'Riwayat & status build', icon: Hammer },
]

export default function SistemPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Sistem"
        description="Kesehatan, cadangan, pengaturan, sesi, dan build dalam satu halaman."
      />
      <SectionNav items={sections} />
      <PageSection id="health" index={1} title="Kesehatan" description="Status layanan & koneksi LLM." icon={Heartbeat}>
        <HealthPage embedded />
      </PageSection>
      <PageSection id="cadangan" index={2} title="Cadangan" description="Backup & restore data." icon={Archive}>
        <CadanganPage embedded />
      </PageSection>
      <PageSection id="settings" index={3} title="Pengaturan" description="Konfigurasi panel admin." icon={Gear}>
        <SettingsPage embedded />
      </PageSection>
      <PageSection id="sessions" index={4} title="Sesi" description="Sesi aktif & pencabutan." icon={Key}>
        <SessionsPage embedded />
      </PageSection>
      <PageSection id="builds" index={5} title="Build" description="Riwayat & status build." icon={Hammer}>
        <BuildsPage embedded />
      </PageSection>
    </div>
  )
}

function PageRedirect() {
  useEffect(() => {
    window.history.replaceState(null, '', '/admin/sistem')
    window.dispatchEvent(new Event(NAVIGATE_EVENT))
  }, [])
  return (
    <div className="flex justify-center py-16">
      <Spinner label="Memuat halaman…" />
    </div>
  )
}

export const HealthRedirect = PageRedirect
export const CadanganRedirect = PageRedirect
export const SettingsRedirect = PageRedirect
export const SessionsRedirect = PageRedirect
export const BuildsRedirect = PageRedirect

import { useEffect } from 'react'
import { NAVIGATE_EVENT } from '../lib/router'
import { PageHeader } from '../components/PageHeader'
import { Spinner } from '../components/Spinner'
import ProjectsPage from './projects'
import ModerasiPage from './moderasi'
import DomainPage from './domain'

/* Halaman "Konten": tiga fitur asli disusun bertumpuk dalam SATU halaman.
   Tanpa tab / query parameter tab. Tiap fitur memakai komponen halaman aslinya
   dengan prop embedded agar PageHeader-nya tidak bertumpuk. URL lama
   tetap jalan lewat komponen redirect di bawah (replaceState ke URL bersih). */

export default function KontenPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Konten" description="Proyek, moderasi, dan domain dalam satu halaman." />
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">{'Daftar Proyek'}</h2>
        <ProjectsPage embedded />
      </section>
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">{'Moderasi'}</h2>
        <ModerasiPage embedded />
      </section>
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">{'Domain'}</h2>
        <DomainPage embedded />
      </section>
    </div>
  )
}

/* Redirect URL lama ke halaman induk. replaceState mencegah tombol
   kembali berputar di URL lama. */
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

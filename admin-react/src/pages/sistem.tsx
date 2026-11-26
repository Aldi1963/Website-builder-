import { useEffect } from 'react'
import { NAVIGATE_EVENT } from '../lib/router'
import { PageHeader } from '../components/PageHeader'
import { Spinner } from '../components/Spinner'
import HealthPage from './health'
import CadanganPage from './cadangan'
import PembersihanPage from './pembersihan'
import PemeliharaanPage from './pemeliharaan'
import SettingsPage from './settings'
import SessionsPage from './sessions'
import BuildsPage from './builds'

/* Halaman "Sistem": tujuh fitur asli disusun bertumpuk dalam SATU
   halaman, tanpa tab / query parameter tab. Satu PageHeader induk, tiap fitur
   punya heading <h2> agar tetap terbaca. URL lama tetap jalan lewat
   komponen redirect di bawah (replaceState ke URL bersih). */

export default function SistemPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Sistem" description="Kesehatan, cadangan, pembersihan, pemeliharaan, pengaturan, sesi, dan build dalam satu halaman." />
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">{'Kesehatan'}</h2>
        <HealthPage embedded />
      </section>
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">{'Cadangan'}</h2>
        <CadanganPage embedded />
      </section>
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">{'Pembersihan'}</h2>
        <PembersihanPage embedded />
      </section>
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">{'Pemeliharaan'}</h2>
        <PemeliharaanPage embedded />
      </section>
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">{'Pengaturan'}</h2>
        <SettingsPage embedded />
      </section>
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">{'Sesi'}</h2>
        <SessionsPage embedded />
      </section>
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">{'Build'}</h2>
        <BuildsPage embedded />
      </section>
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
export const PembersihanRedirect = PageRedirect
export const PemeliharaanRedirect = PageRedirect
export const SettingsRedirect = PageRedirect
export const SessionsRedirect = PageRedirect
export const BuildsRedirect = PageRedirect

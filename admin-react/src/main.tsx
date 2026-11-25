import { StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { ShieldCheck } from '@phosphor-icons/react'
import { AuthProvider, LOGIN_URL, useAuth } from './lib/auth'
import { ToastProvider } from './lib/toast'
import { RouterProvider, navigate, useRoute } from './lib/router'
import { AdminLayout } from './layout'
import { Spinner } from './components/Spinner'
import { Card } from './components/Card'
import { PageHeader } from './components/PageHeader'
import './index.css'

function LockedScreen({
  title,
  text,
  actionLabel,
  actionHref,
}: {
  title: string
  text: string
  actionLabel: string
  actionHref: string
}) {
  return (
    <div className="flex min-h-full items-center justify-center px-4 py-16">
      <Card className="w-full max-w-md text-center">
        <ShieldCheck size={48} className="mx-auto text-muted" />
        <h1 className="mt-3 text-xl font-bold">{title}</h1>
        <p className="mt-2 text-sm text-muted">{text}</p>
        <a
          href={actionHref}
          className="mt-5 inline-block rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-white hover:bg-accent-hover"
        >
          {actionLabel}
        </a>
      </Card>
    </div>
  )
}

function NotFound() {
  return (
    <div className="space-y-4">
      <PageHeader title="Tidak ditemukan" description="Halaman yang kamu cari tidak ada di panel admin." />
      <Card>
        <p className="text-sm text-muted">
          Periksa kembali alamatnya, atau kembali ke{' '}
          <a
            href="/admin"
            onClick={(e) => {
              e.preventDefault()
              navigate('/admin')
            }}
            className="font-medium"
          >
            Dashboard
          </a>
          .
        </p>
      </Card>
    </div>
  )
}

function App() {
  const { status } = useAuth()
  const { route } = useRoute()

  if (status === 'loading') {
    return (
      <div className="flex min-h-full items-center justify-center">
        <Spinner label="Memuat panel admin…" />
      </div>
    )
  }
  if (status === 'unauthenticated') {
    return (
      <LockedScreen
        title="Masuk dulu"
        text="Masuk dulu untuk membuka panel admin."
        actionLabel="Buka Builder & Masuk"
        actionHref={LOGIN_URL}
      />
    )
  }
  if (status === 'non-admin') {
    return (
      <LockedScreen
        title="Bukan admin"
        text="Akun ini masuk, tetapi bukan admin. Hanya admin yang boleh membuka panel ini."
        actionLabel="Kembali ke Builder"
        actionHref="/"
      />
    )
  }

  const Page = route?.component
  return (
    <AdminLayout>
      <Suspense
        fallback={
          <div className="flex justify-center py-16">
            <Spinner label="Memuat halaman…" />
          </div>
        }
      >
        {Page ? <Page /> : <NotFound />}
      </Suspense>
    </AdminLayout>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <ToastProvider>
        <RouterProvider>
          <App />
        </RouterProvider>
      </ToastProvider>
    </AuthProvider>
  </StrictMode>,
)

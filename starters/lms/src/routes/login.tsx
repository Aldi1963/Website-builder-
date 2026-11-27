import { useState, type FormEvent } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { getCookie, setCookie } from '@tanstack/react-start/server'
import { register, login, logout, getCurrentUser, ensureTables, AUTH_COOKIE_NAME, AUTH_COOKIE_MAX_AGE } from '~/lib/auth'


const cookieOpts = {
  httpOnly: true as const,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
  maxAge: AUTH_COOKIE_MAX_AGE,
}

const getSessionUser = createServerFn({ method: 'GET' }).handler(async () => {
  await ensureTables()
  const token = getCookie(AUTH_COOKIE_NAME)
  return getCurrentUser(token)
})

const doRegister = createServerFn({ method: 'POST' })
  .validator((input: { email: string; password: string; name?: string }) => input)
  .handler(async ({ data }) => {
    // Public signup never participates in administrator bootstrap.
    const created = await register(data.email, data.password, data.name, 'siswa')
    const { token } = await login(data.email, data.password)
    setCookie(AUTH_COOKIE_NAME, token, cookieOpts)
    return { ok: true, user: created }
  })

const doLogin = createServerFn({ method: 'POST' })
  .validator((input: { email: string; password: string }) => input)
  .handler(async ({ data }) => {
    const { user, token } = await login(data.email, data.password)
    setCookie(AUTH_COOKIE_NAME, token, cookieOpts)
    return { ok: true, user }
  })

const doLogout = createServerFn({ method: 'POST' }).handler(async () => {
  const token = getCookie(AUTH_COOKIE_NAME)
  await logout(token ?? '')
  setCookie(AUTH_COOKIE_NAME, '', { path: '/', maxAge: 0 })
  return { ok: true }
})

export const Route = createFileRoute('/login')({
  loader: () => getSessionUser(),
  component: LoginPage,
})

function LoginPage() {
  const nav = useNavigate()
  const current = Route.useLoaderData()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [error, setError] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      if (mode === 'login') await doLogin({ data: { email, password } })
      else await doRegister({ data: { email, password, name } })
      await nav({ to: '/dashboard' })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function keluar() {
    await doLogout()
    await nav({ to: '/login' })
  }

  return (
    <main className="min-h-dvh">
      <header className="border-b border-edge bg-surface/90 backdrop-blur">
        <div className="container-page flex items-center justify-between py-4">
          <Link to="/" className="font-bold text-ink">← Akademi</Link>
        </div>
      </header>
      <div className="container-page py-16">
        <div className="card mx-auto max-w-md p-6">
          <h1 className="text-2xl font-bold text-ink">{mode === 'login' ? 'Masuk' : 'Daftar Akun'}</h1>
          {current ? (
            <div className="mt-4 space-y-4">
              <p className="text-sm text-muted">
                Sudah masuk sebagai <span className="font-medium text-ink">{current.email}</span> ({current.role || 'user'}).
              </p>
              <div className="flex gap-3">
                <Link to="/dashboard" className="btn-primary">Buka Dashboard</Link>
                <button className="btn-ghost" type="button" onClick={keluar}>Keluar</button>
              </div>
            </div>
          ) : (
            <>
              <form className="mt-6 space-y-4" onSubmit={submit}>
                {mode === 'register' && (
                  <>
                    <div>
                      <label className="label">Nama</label>
                      <input
                        className="input"
                        placeholder="Nama lengkap"
                        value={name}
                        onInput={(e) => setName((e.target as HTMLInputElement).value)}
                      />
                    </div>
                  </>
                )}
                <div>
                  <label className="label">Email</label>
                  <input
                    className="input"
                    type="email"
                    placeholder="nama@contoh.com"
                    value={email}
                    onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
                  />
                </div>
                <div>
                  <label className="label">Password</label>
                  <input
                    className="input"
                    type="password"
                    placeholder="Minimal 6 karakter"
                    value={password}
                    onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
                  />
                </div>
                {error && <p className="text-sm text-danger">{error}</p>}
                <button className="btn-primary w-full" type="submit" disabled={busy}>
                  {busy ? 'Memproses…' : mode === 'login' ? 'Masuk' : 'Daftar'}
                </button>
              </form>
              <button
                className="mt-4 text-sm text-muted underline hover:text-ink"
                type="button"
                onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
              >
                {mode === 'login' ? 'Belum punya akun? Daftar' : 'Sudah punya akun? Masuk'}
              </button>
            </>
          )}
        </div>
      </div>
    </main>
  )
}

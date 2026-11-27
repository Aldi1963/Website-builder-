import { useState, type FormEvent } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { getCookie, setCookie } from '@tanstack/react-start/server'
import { AUTH_COOKIE_NAME, AUTH_COOKIE_MAX_AGE, getCurrentUser, login, logout, register, ensureTables } from '~/lib/auth'

const cookieOpts = {
  httpOnly: true as const,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
  maxAge: AUTH_COOKIE_MAX_AGE,
}

const sessionUser = createServerFn({ method: 'GET' }).handler(async () => {
  await ensureTables()
  return getCurrentUser(getCookie(AUTH_COOKIE_NAME))
})

const doRegister = createServerFn({ method: 'POST' })
  .validator((input: { email: string; password: string; name?: string }) => input)
  .handler(async ({ data }) => {
    // Pendaftaran publik selalu role 'user'; organizer/admin lewat jalur internal.
    const created = await register(data.email, data.password, data.name, 'user')
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
  await logout(getCookie(AUTH_COOKIE_NAME) ?? '')
  setCookie(AUTH_COOKIE_NAME, '', { path: '/', maxAge: 0 })
  return { ok: true }
})

export const Route = createFileRoute('/masuk')({
  loader: () => sessionUser(),
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
    setBusy(true); setError('')
    try {
      if (mode === 'login') await doLogin({ data: { email, password } })
      else await doRegister({ data: { email, password, name } })
      await nav({ to: '/dashboard' })
    } catch (err) {
      setError((err as Error).message)
    } finally { setBusy(false) }
  }

  return (
    <main className="container-page py-16">
      <div className="mx-auto max-w-md">
        <Link to="/" className="text-sm text-slate-400 hover:text-white">← Katalog</Link>
        <div className="card mt-6 p-6">
          <h1 className="text-2xl font-bold text-white">{mode === 'login' ? 'Masuk' : 'Daftar'}</h1>
          <p className="mt-1 text-sm text-slate-400">
            {mode === 'login' ? 'Masuk untuk memesan dan melihat tiket.' : 'Akun baru mendapat role pengguna.'}
          </p>
          {current && <p className="mt-3 rounded-lg bg-emerald-400/10 p-3 text-sm text-emerald-300">Sedang masuk sebagai {current.email}.</p>}
          <form onSubmit={submit} className="mt-6 space-y-4">
            {mode === 'register' && (
              <label className="block"><span className="label">Nama</span>
                <input className="input mt-1 w-full" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nama lengkap" />
              </label>
            )}
            <label className="block"><span className="label">Email</span>
              <input type="email" className="input mt-1 w-full" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </label>
            <label className="block"><span className="label">Password</span>
              <input type="password" className="input mt-1 w-full" value={password} onChange={(e) => setPassword(e.target.value)} minLength={6} required />
            </label>
            {error && <p className="rounded-lg bg-red-500/10 p-3 text-sm text-red-300">{error}</p>}
            <button className="btn-primary w-full" disabled={busy}>{busy ? 'Tunggu…' : mode === 'login' ? 'Masuk' : 'Daftar'}</button>
          </form>
          <button className="btn-ghost mt-4 w-full" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError('') }}>
            {mode === 'login' ? 'Belum punya akun? Daftar' : 'Sudah punya akun? Masuk'}
          </button>
          {current && <button className="btn-ghost mt-2 w-full" onClick={async () => { await doLogout(); await nav({ to: '/' }) }}>Keluar</button>}
        </div>
      </div>
    </main>
  )
}

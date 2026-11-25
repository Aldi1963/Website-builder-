import { useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { getCookie, setCookie } from '@tanstack/react-start/server'
import { register, login, logout, getCurrentUser, AUTH_COOKIE_NAME, AUTH_COOKIE_MAX_AGE } from '~/lib/auth'

/**
 * Contoh halaman autentikasi bawaan (login + register + logout).
 * Salin pola ini saat aplikasi butuh login. Semua logika sensitif di server function.
 */

const cookieOpts = {
  httpOnly: true as const,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
  maxAge: AUTH_COOKIE_MAX_AGE,
}

const getSessionUser = createServerFn({ method: 'GET' }).handler(async () => {
  const token = getCookie(AUTH_COOKIE_NAME)
  return getCurrentUser(token)
})

const doRegister = createServerFn({ method: 'POST' })
  .validator((input: { email: string; password: string; name?: string }) => input)
  .handler(async ({ data }) => {
    const user = await register(data.email, data.password, data.name)
    const { token } = await login(data.email, data.password)
    setCookie(AUTH_COOKIE_NAME, token, cookieOpts)
    return { ok: true, user }
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

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      if (mode === 'login') await doLogin({ data: { email, password } })
      else await doRegister({ data: { email, password, name } })
      await nav({ to: '/' })
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
    <main className="mx-auto max-w-md px-6 py-24">
      <h1 className="text-3xl font-bold tracking-tight">{mode === 'login' ? 'Masuk' : 'Daftar'}</h1>
      {current ? (
        <div className="mt-4 space-y-4">
          <p className="text-stone-600">Sudah masuk sebagai {current.email}.</p>
          <button className="text-sm underline" type="button" onClick={keluar}>
            Keluar
          </button>
        </div>
      ) : (
        <>
          <form className="mt-6 space-y-4" onSubmit={submit}>
            {mode === 'register' && (
              <input
                className="w-full rounded border border-stone-300 px-3 py-2"
                placeholder="Nama"
                value={name}
                onInput={(e) => setName((e.target as HTMLInputElement).value)}
              />
            )}
            <input
              className="w-full rounded border border-stone-300 px-3 py-2"
              type="email"
              placeholder="Email"
              value={email}
              onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
            />
            <input
              className="w-full rounded border border-stone-300 px-3 py-2"
              type="password"
              placeholder="Password"
              value={password}
              onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
            />
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button className="w-full rounded bg-stone-900 px-4 py-2 text-white" type="submit" disabled={busy}>
              {busy ? 'Memproses…' : mode === 'login' ? 'Masuk' : 'Daftar'}
            </button>
          </form>
          <button className="mt-4 text-sm underline" type="button" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
            {mode === 'login' ? 'Belum punya akun? Daftar' : 'Sudah punya akun? Masuk'}
          </button>
        </>
      )}
    </main>
  )
}

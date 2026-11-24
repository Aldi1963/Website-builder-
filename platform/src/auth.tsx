import { useState } from 'react'
import { auth, type User } from './api'
import { Icon, Spinner, Wordmark } from './ui'

/* Signing in is the first thing that happens, so this screen carries the whole
   visual identity: the seam rule, the serif display face, one accent. */
export function AuthGate({ onUser }: { onUser: (u: User) => void }) {
  const [mode, setMode] = useState<'login' | 'signup'>(() =>
    new URLSearchParams(location.search).has('daftar') ? 'signup' : 'login',
  )
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const r =
        mode === 'signup' ? await auth.signup(email, name, password) : await auth.login(email, password)
      onUser(r.user)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-ink px-4 py-10">
      <div className="w-full max-w-[380px]">
        <div className="mb-8 flex items-center gap-2">
          <Wordmark size={18} />
        </div>

        <div className="border-t border-edge pt-5">
          <h1 className="font-display text-[26px] leading-tight text-body">
            {mode === 'signup' ? 'Buat akun' : 'Masuk'}
          </h1>
          <p className="mt-1.5 text-[13px] leading-relaxed text-quiet">
            {mode === 'signup'
              ? 'Proyek yang kamu bangun di sini hanya terlihat oleh akun ini.'
              : 'Lanjutkan proyek yang sudah kamu mulai.'}
          </p>
        </div>

        <form onSubmit={submit} className="mt-6 space-y-4">
          <Field
            label="Email"
            type="email"
            value={email}
            onChange={setEmail}
            autoComplete="email"
            required
          />
          {mode === 'signup' && (
            <Field
              label="Nama"
              value={name}
              onChange={setName}
              autoComplete="name"
              hint="Dipakai di sidebar. Boleh dikosongkan."
            />
          )}
          <Field
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            hint={mode === 'signup' ? 'Minimal 8 karakter.' : undefined}
            required
          />

          {error && (
            <p role="alert" className="border-l-2 border-accent pl-2.5 text-[12.5px] leading-relaxed text-accent">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="flex h-9 w-full items-center justify-center gap-2 bg-accent text-[13px] font-medium text-ink transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy && <Spinner />}
            {mode === 'signup' ? 'Buat akun' : 'Masuk'}
          </button>
        </form>

        <p className="mt-5 text-[12.5px] text-quiet">
          {mode === 'signup' ? 'Sudah punya akun? ' : 'Belum punya akun? '}
          <button
            type="button"
            onClick={() => {
              setMode(mode === 'signup' ? 'login' : 'signup')
              setError('')
            }}
            className="text-body underline decoration-edge decoration-1 underline-offset-2 transition-colors hover:decoration-accent"
          >
            {mode === 'signup' ? 'Masuk' : 'Buat akun'}
          </button>
        </p>
      </div>
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  hint,
  ...rest
}: {
  label: string
  value: string
  onChange: (v: string) => void
  hint?: string
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] text-quiet">{label}</span>
      <input
        {...rest}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full border border-edge bg-surface px-2.5 text-[13px] text-body outline-none transition-colors placeholder:text-quiet focus:border-accent"
      />
      {hint && <span className="mt-1 block text-[11.5px] text-quiet">{hint}</span>}
    </label>
  )
}

/* Sidebar footer: who is signed in, and the way out. */
export function UserBar({ user, onLogout }: { user: User; onLogout: () => void }) {
  return (
    <div className="flex items-center gap-2 border-t border-edge px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12.5px] text-body">{user.name || user.email}</p>
        <p className="truncate text-[11px] text-quiet">{user.email}</p>
      </div>
      <button
        onClick={onLogout}
        aria-label="Keluar dari akun"
        title="Keluar"
        className="flex h-7 w-7 shrink-0 items-center justify-center text-quiet transition-colors hover:text-body"
      >
        <Icon name="logout" size={13} />
      </button>
    </div>
  )
}

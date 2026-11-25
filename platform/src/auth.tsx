import { useEffect, useRef, useState } from 'react'
import { auth, type User } from './api'
import { Icon, Spinner, Wordmark } from './ui'

/* Auth screen — "Clean & Minimal" reference: one white card on a calm
   background, social buttons, remember-me, forgot password, reset flow. */

type Mode = 'login' | 'signup' | 'forgot' | 'reset'

function initialMode(): Mode {
  const params = new URLSearchParams(location.search)
  if (params.has('daftar')) return 'signup'
  if (params.has('lupa')) return 'forgot'
  if (params.get('reset')) return 'reset'
  return 'login'
}

export function AuthGate({ onUser }: { onUser: (u: User) => void }) {
  const [mode, setMode] = useState<Mode>(initialMode)
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [remember, setRemember] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [resetToken, setResetToken] = useState(() => new URLSearchParams(location.search).get('reset') ?? '')
  const noticeTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (mode === 'reset' && !resetToken) setMode('forgot')
  }, [mode, resetToken])

  const flash = (text: string) => {
    setNotice(text)
    window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(''), 6000)
  }

  const goto = (next: Mode) => {
    setMode(next)
    setError('')
    setPassword('')
    setConfirm('')
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      if (mode === 'signup') {
        const r = await auth.signup(email, name, password)
        onUser(r.user)
      } else if (mode === 'login') {
        const r = await auth.login(email, password, remember)
        onUser(r.user)
      } else if (mode === 'forgot') {
        const r = await auth.forgotPassword(email)
        flash(r.message)
      } else {
        if (password !== confirm) throw new Error('Konfirmasi password tidak sama.')
        const r = await auth.resetPassword(resetToken, password)
        flash(r.message)
        goto('login')
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const isReset = mode === 'reset'
  const isForgot = mode === 'forgot'
  const title = mode === 'signup' ? 'Buat akun' : isForgot ? 'Lupa password' : isReset ? 'Atur ulang password' : 'Welcome Back'
  const subtitle =
    mode === 'signup'
      ? 'Proyek yang kamu bangun di sini hanya terlihat oleh akun ini.'
      : isForgot
        ? 'Masukkan email kamu. Jika terdaftar, tautan atur ulang akan dikirim.'
        : isReset
          ? 'Password baru minimal 8 karakter.'
          : 'Lanjutkan proyek yang sudah kamu mulai.'

  return (
    <div className="flex min-h-dvh items-center justify-center bg-ink px-4 py-10">
      <div className="w-full max-w-[400px]">
        <div className="mb-8 flex items-center gap-2">
          <Wordmark size={18} />
        </div>

        <div className="border border-edge bg-surface p-6 vb-seam">
          <h1 className="font-display text-[26px] leading-tight text-body">{title}</h1>
          <p className="mt-1.5 text-[13px] leading-relaxed text-quiet">{subtitle}</p>

          {!isForgot && !isReset && (
            <div className="mt-5 grid grid-cols-3 gap-2">
              <SocialButton label="Google" onClick={() => flash('Login sosial belum tersedia di deploy ini.')} />
              <SocialButton label="GitHub" onClick={() => flash('Login sosial belum tersedia di deploy ini.')} />
              <SocialButton label="Facebook" onClick={() => flash('Login sosial belum tersedia di deploy ini.')} />
            </div>
          )}
          {!isForgot && !isReset && (
            <div className="my-5 flex items-center gap-3 text-[11px] uppercase tracking-wide text-quiet">
              <span className="h-px flex-1 bg-edge" />
              atau email
              <span className="h-px flex-1 bg-edge" />
            </div>
          )}

          <form onSubmit={submit} className={isForgot || isReset ? 'mt-5 space-y-4' : 'space-y-4'}>
            {!isReset && (
              <Field label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" required />
            )}
            {mode === 'signup' && (
              <Field
                label="Nama"
                value={name}
                onChange={setName}
                autoComplete="name"
                hint="Dipakai di sidebar. Boleh dikosongkan."
              />
            )}
            {(mode === 'login' || mode === 'signup' || isReset) && (
              <Field
                label={isReset ? 'Password baru' : 'Password'}
                type="password"
                value={password}
                onChange={setPassword}
                autoComplete={mode === 'signup' || isReset ? 'new-password' : 'current-password'}
                hint={mode === 'signup' || isReset ? 'Minimal 8 karakter.' : undefined}
                required
              />
            )}
            {isReset && (
              <Field
                label="Ulangi password baru"
                type="password"
                value={confirm}
                onChange={setConfirm}
                autoComplete="new-password"
                required
              />
            )}

            {mode === 'login' && (
              <div className="flex items-center justify-between text-[12px]">
                <label className="flex items-center gap-2 text-quiet">
                  <input
                    type="checkbox"
                    checked={remember}
                    onChange={(e) => setRemember(e.target.checked)}
                    className="h-3.5 w-3.5 accent-[var(--vb-accent)]"
                  />
                  Ingat saya
                </label>
                <button
                  type="button"
                  onClick={() => goto('forgot')}
                  className="text-quiet underline decoration-edge decoration-1 underline-offset-2 transition-colors hover:text-accent"
                >
                  Lupa password?
                </button>
              </div>
            )}

            {error && (
              <p role="alert" className="border-l-2 border-accent pl-2.5 text-[12.5px] leading-relaxed text-accent">
                {error}
              </p>
            )}
            {notice && (
              <p role="status" className="border-l-2 border-edge pl-2.5 text-[12.5px] leading-relaxed text-body">
                {notice}
              </p>
            )}

            <button
              type="submit"
              disabled={busy}
              className="flex h-9 w-full items-center justify-center gap-2 bg-accent text-[13px] font-medium text-surface transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy && <Spinner />}
              {mode === 'signup' ? 'Buat akun' : isForgot ? 'Kirim tautan' : isReset ? 'Simpan password' : 'Masuk'}
            </button>
          </form>

          <p className="mt-5 text-[12.5px] text-quiet">
            {mode === 'signup' ? 'Sudah punya akun? ' : isForgot || isReset ? 'Ingat password? ' : 'Belum punya akun? '}
            <button
              type="button"
              onClick={() => goto(mode === 'signup' || isForgot || isReset ? 'login' : 'signup')}
              className="text-body underline decoration-edge decoration-1 underline-offset-2 transition-colors hover:decoration-accent"
            >
              {mode === 'signup' || isForgot || isReset ? 'Masuk' : 'Buat akun'}
            </button>
          </p>
        </div>
      </div>
    </div>
  )
}

function SocialButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-9 items-center justify-center gap-1.5 border border-edge bg-ink text-[12px] text-body transition-colors hover:border-accent"
    >
      <SocialGlyph name={label} />
      {label}
    </button>
  )
}

function SocialGlyph({ name }: { name: string }) {
  const path =
    name === 'Google'
      ? 'M12 11v2.9h4.1c-.2 1-1.2 2.9-4.1 2.9-2.5 0-4.5-2-4.5-4.5S9.5 7.8 12 7.8c1.4 0 2.4.6 2.9 1.1l2-1.9C15.6 5.7 13.9 5 12 5c-3.9 0-7 3.1-7 7s3.1 7 7 7c4 0 6.7-2.8 6.7-6.8 0-.5 0-.8-.1-1.2H12z'
      : name === 'GitHub'
        ? 'M12 5c-3.9 0-7 3.1-7 7 0 3.1 2 5.7 4.8 6.6.4.1.5-.2.5-.4v-1.4c-2 .4-2.4-.9-2.4-.9-.3-.8-.8-1-.8-1-.6-.4 0-.4 0-.4.7 0 1.1.7 1.1.7.6 1.1 1.7.8 2.1.6 0-.5.2-.8.4-1-1.6-.2-3.2-.8-3.2-3.5 0-.8.3-1.4.7-1.9 0-.2-.3-.9.1-1.9 0 0 .6-.2 2 .7.6-.2 1.2-.2 1.8-.2s1.2 0 1.8.2c1.4-1 2-.7 2-.7.4 1 .1 1.7.1 1.9.5.5.7 1.1.7 1.9 0 2.7-1.7 3.3-3.2 3.5.3.2.5.6.5 1.3v2c0 .2.1.5.5.4 2.8-.9 4.8-3.5 4.8-6.6 0-3.9-3.1-7-7-7z'
        : 'M13.5 21v-7h2.4l.4-2.8h-2.8V9.4c0-.8.2-1.4 1.4-1.4h1.5V5.5c-.3 0-1.2-.1-2.2-.1-2.2 0-3.7 1.3-3.7 3.8v2H8v2.8h2.5v7h3z'
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d={path} />
    </svg>
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
        className="h-9 w-full border border-edge bg-ink px-2.5 text-[13px] text-body outline-none transition-colors placeholder:text-quiet focus:border-accent"
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

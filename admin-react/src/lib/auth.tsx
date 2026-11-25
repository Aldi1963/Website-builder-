import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { api, ApiError } from './api'

/* URL login: form masuk tinggal di SPA builder di `/` (sama seperti layar
   terkunci shell.html lama: "Buka Builder & Masuk"). */
export const LOGIN_URL = '/'

export interface AuthUser {
  id: number
  email: string
  name: string
  created_at: number
  disabled?: number
}

export type AuthStatus = 'loading' | 'unauthenticated' | 'non-admin' | 'admin'

interface AuthValue {
  status: AuthStatus
  user: AuthUser | null
  refresh: () => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading')
  const [user, setUser] = useState<AuthUser | null>(null)

  const check = useCallback(async () => {
    setStatus('loading')
    try {
      const me = await api.get<{ user: AuthUser | null; signupOpen: boolean }>('/api/auth/me')
      if (!me.user) {
        setUser(null)
        setStatus('unauthenticated')
        return
      }
      setUser(me.user)
      /* Deteksi admin: skema users TIDAK punya kolom role. Admin ditentukan
         server (admin.ts): email cocok VB_ADMIN_EMAIL, atau akun pertama.
         /api/auth/me tidak memberi flag admin, jadi satu-satunya cara yang
         benar dari sisi klien adalah memanggil endpoint admin dan melihat
         401/403 dari requireAdmin. */
      try {
        await api.get('/api/admin/overview')
        setStatus('admin')
      } catch (err) {
        if (err instanceof ApiError && err.status === 403) setStatus('non-admin')
        else if (err instanceof ApiError && err.status === 401) setStatus('unauthenticated')
        else throw err
      }
    } catch {
      setUser(null)
      setStatus('unauthenticated')
    }
  }, [])

  useEffect(() => {
    void check()
  }, [check])

  const logout = useCallback(async () => {
    try {
      await api.post('/api/auth/logout')
    } catch {
      /* abaikan — sesi sudah mati di server atau cookie sudah hilang */
    }
    window.location.href = '/'
  }, [])

  return (
    <AuthContext.Provider value={{ status, user, refresh: check, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth harus dipakai di dalam <AuthProvider>')
  return ctx
}

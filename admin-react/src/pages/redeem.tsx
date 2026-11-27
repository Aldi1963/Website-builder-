import { useCallback, useEffect, useState } from 'react'
import { Copy } from '@phosphor-icons/react'
import { api } from '../lib/api'
import { useToast } from '../lib/toast'
import { PageHeader } from '../components/PageHeader'
import { Card } from '../components/Card'
import { Table, Th, Td, EmptyRow } from '../components/Table'
import { btnOutlineSm, btnPrimary } from '../components/DFormat'
import { Badge } from '../components/Badge'
import { Field, inputClass } from '../components/Field'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { Spinner } from '../components/Spinner'
import { errMessage, fmtDate, fmtNum } from '../components/BFormat'

/* Seksi "Kode Redeem" di Monetisasi → Kelola Credit (28 Nov 2026).
   Admin membuat kode (auto-generate atau ketik manual), melihat daftar +
   penukaran, dan menonaktifkan kode. Kode tampil plaintext (keputusan
   user). Form dibuat ringkas: satu kartu buat + satu tabel daftar. */

interface RedeemCode {
  id: string
  code: string
  credits: number
  maxUses: number
  uses: number
  redeemed: number
  perUserLimit: number
  expiresAt: number | null
  active: boolean
  allowedUserIds: string[]
  allowedUsers: { id: string; email: string }[]
  createdBy: string
  note: string
  createdAt: number
}

interface Redemption {
  id: number
  codeId: string
  code: string
  userId: string
  email: string | null
  credits: number
  createdAt: number
}

const CROCKFORD = '23456789ABCDEFGHJKMNPQRSTVWXYZ'

function generateCodePreview(): string {
  let raw = ''
  for (let i = 0; i < 12; i++) raw += CROCKFORD[Math.floor(Math.random() * CROCKFORD.length)]
  return `CLIDI-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`
}

const toEpoch = (local: string): number | null => {
  if (!local) return null
  const t = new Date(local).getTime()
  return Number.isFinite(t) ? t : null
}

export default function RedeemPage({ embedded = false }: { embedded?: boolean }) {
  const toast = useToast()
  const [codes, setCodes] = useState<RedeemCode[]>([])
  const [redemptions, setRedemptions] = useState<Redemption[]>([])
  const [loading, setLoading] = useState(true)
  const [code, setCode] = useState('')
  const [credits, setCredits] = useState('')
  const [maxUses, setMaxUses] = useState('1')
  const [perUserLimit, setPerUserLimit] = useState('1')
  const [expiresAt, setExpiresAt] = useState('')
  const [note, setNote] = useState('')
  const [allowedEmail, setAllowedEmail] = useState('')
  const [allowedUsers, setAllowedUsers] = useState<{ id: string; email: string }[]>([])
  const [addingUser, setAddingUser] = useState(false)
  const [creating, setCreating] = useState(false)
  const [deactivating, setDeactivating] = useState<RedeemCode | null>(null)
  const [deactivateBusy, setDeactivateBusy] = useState(false)
  const [copied, setCopied] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [c, r] = await Promise.all([
        api.get<{ codes: RedeemCode[] }>('/api/admin/redeem/codes'),
        api.get<{ redemptions: Redemption[] }>('/api/admin/redeem/redemptions?limit=50'),
      ])
      setCodes(c.codes)
      setRedemptions(r.redemptions)
    } catch (e) {
      toast.error(errMessage(e))
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load])

  const addAllowedUser = async () => {
    const email = allowedEmail.trim().toLowerCase()
    if (!email) return
    if (allowedUsers.some((u) => u.email.toLowerCase() === email)) {
      toast.error('Pengguna itu sudah ditambahkan.')
      return
    }
    setAddingUser(true)
    try {
      const data = await api.get<{ users: { id: string; email: string }[] }>(
        `/api/admin/credits/users?q=${encodeURIComponent(email)}`,
      )
      const found = data.users.find((u) => u.email.toLowerCase() === email)
      if (!found) {
        toast.error('Pengguna tidak ditemukan.')
        return
      }
      setAllowedUsers((list) => [...list, { id: found.id, email: found.email }])
      setAllowedEmail('')
    } catch (e) {
      toast.error(errMessage(e))
    } finally {
      setAddingUser(false)
    }
  }

  const submitCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    const amount = Number(credits)
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error('Isi jumlah credit (lebih dari 0).')
      return
    }
    setCreating(true)
    try {
      const res = await api.post<{ ok: boolean; code: RedeemCode }>('/api/admin/redeem/codes', {
        code: code.trim() || undefined,
        credits: amount,
        maxUses: Number(maxUses) || 1,
        perUserLimit: Number(perUserLimit) || 1,
        expiresAt: toEpoch(expiresAt),
        allowedUserIds: allowedUsers.map((u) => u.id),
        note: note.trim() || undefined,
      })
      toast.success(`Kode ${res.code.code} dibuat (+${fmtNum(res.code.credits)} credit).`)
      setCode('')
      setCredits('')
      setMaxUses('1')
      setPerUserLimit('1')
      setExpiresAt('')
      setNote('')
      setAllowedUsers([])
      await load()
    } catch (err) {
      toast.error(errMessage(err))
    } finally {
      setCreating(false)
    }
  }

  const doDeactivate = async () => {
    if (!deactivating) return
    setDeactivateBusy(true)
    try {
      await api.post(`/api/admin/redeem/codes/${encodeURIComponent(deactivating.id)}/deactivate`)
      toast.success(`Kode ${deactivating.code} dinonaktifkan.`)
      setDeactivating(null)
      await load()
    } catch (err) {
      toast.error(errMessage(err))
    } finally {
      setDeactivateBusy(false)
    }
  }

  const copyCode = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(value)
      window.setTimeout(() => setCopied((c) => (c === value ? '' : c)), 1500)
    } catch {
      toast.error('Gagal menyalin kode.')
    }
  }

  return (
    <div className="space-y-4">
      {!embedded ? (
        <PageHeader title="Kode Redeem" description="Buat kode penukaran credit untuk pengguna." />
      ) : null}

      <Card title="Buat Kode Baru" description="Kosongkan kolom kode untuk auto-generate (CLIDI-XXXX-XXXX-XXXX).">
        <form onSubmit={submitCreate} className="space-y-3">
          <div className="grid items-end gap-3 md:grid-cols-[1.6fr_1fr_auto]">
            <Field label="Kode (opsional — kosong = generate)" htmlFor="redeem-code">
              <input
                id="redeem-code"
                type="text"
                className={`${inputClass} font-mono`}
                placeholder="CLIDI-XXXX-XXXX-XXXX"
                value={code}
                maxLength={40}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
              />
            </Field>
            <Field label="Jumlah credit" htmlFor="redeem-credits">
              <input
                id="redeem-credits"
                type="number"
                step="any"
                min={0}
                className={inputClass}
                placeholder="cth. 500"
                required
                value={credits}
                onChange={(e) => setCredits(e.target.value)}
              />
            </Field>
            <button
              type="button"
              onClick={() => setCode(generateCodePreview())}
              className={btnOutlineSm}
              title="Isi kode acak"
            >
              Generate
            </button>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Maks. pemakaian" htmlFor="redeem-max-uses">
              <input
                id="redeem-max-uses"
                type="number"
                min={1}
                className={inputClass}
                value={maxUses}
                onChange={(e) => setMaxUses(e.target.value)}
              />
            </Field>
            <Field label="Batas per user" htmlFor="redeem-per-user">
              <input
                id="redeem-per-user"
                type="number"
                min={1}
                className={inputClass}
                value={perUserLimit}
                onChange={(e) => setPerUserLimit(e.target.value)}
              />
            </Field>
            <Field label="Kedaluarsa (opsional)" htmlFor="redeem-expires">
              <input
                id="redeem-expires"
                type="datetime-local"
                className={inputClass}
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
              />
            </Field>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Batasi untuk user tertentu (opsional)" htmlFor="redeem-allowed-email">
              <div className="flex gap-2">
                <input
                  id="redeem-allowed-email"
                  type="email"
                  className={`${inputClass} min-w-0 flex-1`}
                  placeholder="email pengguna…"
                  value={allowedEmail}
                  onChange={(e) => setAllowedEmail(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void addAllowedUser()
                    }
                  }}
                />
                <button type="button" onClick={() => void addAllowedUser()} disabled={addingUser} className={btnOutlineSm}>
                  Tambah
                </button>
              </div>
              {allowedUsers.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {allowedUsers.map((u) => (
                    <span
                      key={u.id}
                      className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent"
                    >
                      {u.email}
                      <button
                        type="button"
                        aria-label={`Hapus ${u.email}`}
                        onClick={() => setAllowedUsers((list) => list.filter((x) => x.id !== u.id))}
                        className="cursor-pointer font-bold hover:opacity-70"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <p className="mt-1 text-xs text-muted">Kosong = siapa saja yang pegang kode bisa menukar.</p>
            </Field>
            <Field label="Catatan (opsional)" htmlFor="redeem-note">
              <input
                id="redeem-note"
                type="text"
                className={inputClass}
                placeholder="cth. Hadiah event"
                maxLength={200}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </Field>
          </div>
          <button type="submit" disabled={creating} className={btnPrimary}>
            {creating ? 'Membuat…' : 'Buat Kode'}
          </button>
        </form>
      </Card>

      <Card title="Daftar Kode">
        {loading ? (
          <Spinner />
        ) : (
          <Table bare>
            <thead>
              <tr>
                <Th>Kode</Th>
                <Th className="text-right">Credit</Th>
                <Th className="text-right">Terpakai</Th>
                <Th>Kedaluarsa</Th>
                <Th>Status</Th>
                <Th>{''}</Th>
              </tr>
            </thead>
            <tbody>
              {codes.length ? (
                codes.map((c) => (
                  <tr key={c.id}>
                    <Td>
                      <span className="font-mono text-[13px]">{c.code}</span>{' '}
                      <button
                        type="button"
                        onClick={() => void copyCode(c.code)}
                        className="cursor-pointer text-muted hover:text-body"
                        title="Salin kode"
                        aria-label={`Salin ${c.code}`}
                      >
                        <Copy size={13} className="inline" />
                      </button>
                      {copied === c.code && <span className="ml-1 text-xs text-success">disalin</span>}
                      {c.note ? <span className="block text-xs text-muted">{c.note}</span> : null}
                      {c.allowedUsers.length > 0 && (
                        <span className="block text-xs text-muted">
                          khusus: {c.allowedUsers.map((u) => u.email).join(', ')}
                        </span>
                      )}
                    </Td>
                    <Td className="text-right">+{fmtNum(c.credits)}</Td>
                    <Td className="text-right">
                      {c.redeemed}/{c.maxUses}
                      {c.perUserLimit > 1 ? ` · maks ${c.perUserLimit}/user` : ''}
                    </Td>
                    <Td>{c.expiresAt ? fmtDate(c.expiresAt) : '–'}</Td>
                    <Td>
                      {c.active ? (
                        <Badge tone="success">Aktif</Badge>
                      ) : (
                        <Badge tone="default">Nonaktif</Badge>
                      )}
                    </Td>
                    <Td className="text-right">
                      {c.active ? (
                        <button type="button" onClick={() => setDeactivating(c)} className={btnOutlineSm}>
                          Nonaktifkan
                        </button>
                      ) : null}
                    </Td>
                  </tr>
                ))
              ) : (
                <EmptyRow colSpan={6}>Belum ada kode redeem.</EmptyRow>
              )}
            </tbody>
          </Table>
        )}
      </Card>

      <Card title="Penukaran Terakhir" description="50 penukaran terbaru di semua kode.">
        {loading ? (
          <Spinner />
        ) : (
          <Table bare>
            <thead>
              <tr>
                <Th>Waktu</Th>
                <Th>Pengguna</Th>
                <Th>Kode</Th>
                <Th className="text-right">Credit</Th>
              </tr>
            </thead>
            <tbody>
              {redemptions.length ? (
                redemptions.map((r) => (
                  <tr key={r.id}>
                    <Td>{fmtDate(r.createdAt)}</Td>
                    <Td>{r.email ?? r.userId}</Td>
                    <Td className="font-mono text-[13px]">{r.code}</Td>
                    <Td className="text-right">+{fmtNum(r.credits)}</Td>
                  </tr>
                ))
              ) : (
                <EmptyRow colSpan={4}>Belum ada penukaran.</EmptyRow>
              )}
            </tbody>
          </Table>
        )}
      </Card>

      <ConfirmDialog
        open={deactivating !== null}
        title="Nonaktifkan kode?"
        message={
          deactivating
            ? `Kode ${deactivating.code} tidak bisa lagi ditukar sesudah dinonaktifkan. Penukaran yang sudah terjadi tetap berlaku.`
            : ''
        }
        confirmLabel="Nonaktifkan"
        onConfirm={() => void doDeactivate()}
        onCancel={() => setDeactivating(null)}
        loading={deactivateBusy}
      />
    </div>
  )
}

import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { useToast } from '../lib/toast'
import { PageHeader } from '../components/PageHeader'
import { Card } from '../components/Card'
import { Table, Th, Td, EmptyRow } from '../components/Table'
import { Badge } from '../components/Badge'
import { Alert } from '../components/Alert'
import { Modal } from '../components/Modal'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { Field, inputClass } from '../components/Field'
import { Textarea } from '../components/Textarea'
import { Spinner } from '../components/Spinner'
import { btnOutline, btnOutlineDangerSm, btnOutlineSm, btnOutlineSuccessSm, btnOutlineWarningSm, btnPrimary } from '../components/DFormat'
import { errMessage, fmtDate } from '../components/BFormat'

interface Announcement {
  id: number
  title: string
  body: string
  active: number | boolean
  created_at: number
  updated_at: number
}

type FormState =
  | { mode: 'create' }
  | { mode: 'edit'; id: number; title: string; body: string }

export default function PengumumanPage() {
  const toast = useToast()
  const [rows, setRows] = useState<Announcement[] | null>(null)
  const [form, setForm] = useState<FormState | null>(null)
  const [formTitle, setFormTitle] = useState('')
  const [formBody, setFormBody] = useState('')
  const [saving, setSaving] = useState(false)
  const [confirm, setConfirm] = useState<
    { kind: 'activate' | 'delete'; item: Announcement } | null
  >(null)
  const [busyId, setBusyId] = useState<number | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ announcements: Announcement[] }>(
        '/api/admin/announcements',
      )
      setRows(data.announcements || [])
    } catch (e) {
      toast.error(errMessage(e))
    }
  }, [toast])

  useEffect(() => {
    load()
  }, [load])

  function openCreate() {
    setFormTitle('')
    setFormBody('')
    setForm({ mode: 'create' })
  }

  function openEdit(a: Announcement) {
    setFormTitle(a.title)
    setFormBody(a.body || '')
    setForm({ mode: 'edit', id: a.id, title: a.title, body: a.body || '' })
  }

  async function submitForm(e: React.FormEvent) {
    e.preventDefault()
    if (!form || !formTitle.trim()) return
    setSaving(true)
    try {
      if (form.mode === 'create') {
        await api.post('/api/admin/announcements', {
          title: formTitle,
          body: formBody,
        })
        toast.success('Pengumuman dibuat (belum aktif).')
      } else {
        await api.put(`/api/admin/announcements/${encodeURIComponent(form.id)}`, {
          title: formTitle,
          body: formBody,
        })
        toast.success('Pengumuman diperbarui.')
      }
      setForm(null)
      load()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Gagal menyimpan pengumuman.')
    } finally {
      setSaving(false)
    }
  }

  async function runConfirm() {
    if (!confirm) return
    const { kind, item } = confirm
    setBusyId(item.id)
    try {
      if (kind === 'activate') {
        await api.post(
          `/api/admin/announcements/${encodeURIComponent(item.id)}/activate`,
        )
        toast.success('Pengumuman diaktifkan.')
      } else {
        await api.del(`/api/admin/announcements/${encodeURIComponent(item.id)}`)
        toast.success('Pengumuman dihapus.')
      }
      setConfirm(null)
      load()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Gagal memproses pengumuman.')
    } finally {
      setBusyId(null)
    }
  }

  async function deactivate(item: Announcement) {
    setBusyId(item.id)
    try {
      await api.post(
        `/api/admin/announcements/${encodeURIComponent(item.id)}/activate`,
        { active: false },
      )
      toast.success('Pengumuman dinonaktifkan.')
      load()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Gagal menonaktifkan pengumuman.')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Pengumuman"
        description="Pengumuman untuk semua pengguna. Hanya satu pengumuman yang aktif dalam satu waktu."
        actions={
          <button
            type="button"
            onClick={openCreate}
            className={btnPrimary}
          >
            Buat Pengumuman
          </button>
        }
      />

      <Alert tone="info">
        Pengumuman aktif akan ditampilkan sebagai banner di builder setelah
        perubahan penyajian dipasang (belum tersedia — lihat catatan di bawah).
      </Alert>

      {rows === null ? (
        <Spinner label="Memuat pengumuman…" />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Judul</Th>
              <Th>Isi</Th>
              <Th>Status</Th>
              <Th>Dibuat</Th>
              <Th className="text-right">Aksi</Th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="border-b border-border px-4 py-3 text-muted">
                  Belum ada pengumuman.
                </td>
              </tr>
            ) : (
              rows.map((a) => {
                const body = a.body || ''
                const excerpt =
                  body.length > 120 ? `${body.slice(0, 120)}…` : body
                const isActive = !!a.active
                return (
                  <tr key={a.id}>
                    <Td>
                      <strong>{a.title}</strong>
                    </Td>
                    <Td className="min-w-[240px] break-words">
                      {excerpt || '–'}
                    </Td>
                    <Td>
                      {isActive ? (
                        <Badge tone="success">Aktif</Badge>
                      ) : (
                        <Badge tone="default">Nonaktif</Badge>
                      )}
                    </Td>
                    <Td className="whitespace-nowrap">{fmtDate(a.created_at)}</Td>
                    <Td className="text-right whitespace-nowrap">
                      <span className="inline-flex gap-2">
                        {isActive ? (
                          <button
                            type="button"
                            className={btnOutlineWarningSm}
                            disabled={busyId === a.id}
                            onClick={() => deactivate(a)}
                          >
                            Nonaktifkan
                          </button>
                        ) : (
                          <button
                            type="button"
                            className={btnOutlineSuccessSm}
                            disabled={busyId === a.id}
                            onClick={() => setConfirm({ kind: 'activate', item: a })}
                          >
                            Aktifkan
                          </button>
                        )}
                        <button
                          type="button"
                          className={btnPrimary}
                          onClick={() => openEdit(a)}
                        >
                          Ubah
                        </button>
                        <button
                          type="button"
                          className={btnOutlineDangerSm}
                          disabled={busyId === a.id}
                          onClick={() => setConfirm({ kind: 'delete', item: a })}
                        >
                          Hapus
                        </button>
                      </span>
                    </Td>
                  </tr>
                )
              })
            )}
          </tbody>
        </Table>
      )}

      <Card title="Catatan">
        <p className="text-sm text-muted">
          Menampilkan banner di builder semua pengguna masih tertunda: butuh
          endpoint publik (mis.{' '}
          <code className="font-mono text-xs">GET /api/announcements/active</code>{' '}
          di <code className="font-mono text-xs">app.ts</code> + komponen banner
          di <code className="font-mono text-xs">platform/*</code>. Pengumuman
          yang dibuat di sini tersimpan di database dan siap ditampilkan begitu
          penyajian dipasang.
        </p>
      </Card>

      <Modal
        open={form !== null}
        onClose={() => (saving ? null : setForm(null))}
        title={form?.mode === 'edit' ? 'Ubah pengumuman' : 'Buat pengumuman'}
      >
        <form onSubmit={submitForm} className="space-y-4">
          <Field label="Judul" htmlFor="announcement-title" required>
            <input
              id="announcement-title"
              type="text"
              required
              value={formTitle}
              onChange={(e) => setFormTitle(e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field
            label="Isi"
            htmlFor="announcement-body"
            hint={
              form?.mode === 'create'
                ? 'Isi pengumuman yang ditampilkan di banner builder.'
                : undefined
            }
          >
            <Textarea
              id="announcement-body"
              rows={4}
              value={formBody}
              onChange={(e) => setFormBody(e.target.value)}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setForm(null)}
              disabled={saving}
              className={btnOutline}
            >
              Batal
            </button>
            <button
              type="submit"
              disabled={saving}
              className={btnPrimary}
            >
              {saving ? 'Menyimpan…' : 'Simpan'}
            </button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={confirm !== null}
        title={
          confirm?.kind === 'activate' ? 'Aktifkan pengumuman' : 'Hapus pengumuman'
        }
        message={
          confirm?.kind === 'activate'
            ? 'Aktifkan pengumuman ini? Pengumuman aktif lainnya akan dinonaktifkan.'
            : `Hapus pengumuman "${confirm?.item.title}"? Tindakan ini tidak bisa dibatalkan.`
        }
        confirmLabel={confirm?.kind === 'activate' ? 'Ya, aktifkan' : 'Ya, hapus'}
        loading={busyId !== null}
        onConfirm={runConfirm}
        onCancel={() => setConfirm(null)}
      />
    </div>
  )
}

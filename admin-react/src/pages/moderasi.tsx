import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { useToast } from '../lib/toast'
import { PageHeader } from '../components/PageHeader'
import { Alert } from '../components/Alert'
import { Badge } from '../components/Badge'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { Field } from '../components/Field'
import { Modal } from '../components/Modal'
import { Spinner } from '../components/Spinner'
import { Table, Th, Td, EmptyRow } from '../components/Table'
import { Textarea } from '../components/Textarea'
import {
  btnOutlineDangerSm,
  btnOutlineSuccessSm,
  btnOutlineWarningSm,
  btnOutlineSm,
} from '../components/DFormat'
import { fmtDateShort, fmtNum, projectStatusTone } from '../components/BFormat'
import { btnOutline, btnPrimary } from '../components/DFormat'

interface ModerationProject {
  id: string
  name: string
  status: string
  slug: string | null
  created_at: number
  updated_at: number
  owner_id: number | null
  owner_email: string | null
  owner_name: string | null
  suspended: boolean
  flag_reason: string | null
  flag_by: string | null
  flagged_at: number | null
  flagged: boolean
}

type ConfirmKind = 'unflag' | 'suspend'

/* Tone badge status proyek — lihat projectStatusTone di BFormat. */

interface ModerasiPageProps {
  /** Disematkan di halaman gabungan: PageHeader induk disembunyikan. */
  embedded?: boolean
}

export default function ModerasiPage({ embedded = false }: ModerasiPageProps) {
  const toast = useToast()
  const [projects, setProjects] = useState<ModerationProject[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [flagTarget, setFlagTarget] = useState<ModerationProject | null>(null)
  const [flagReason, setFlagReason] = useState('')
  const [confirm, setConfirm] = useState<{ kind: ConfirmKind; project: ModerationProject } | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ projects: ModerationProject[] }>('/api/admin/moderation')
      setProjects(data.projects)
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Gagal memuat moderasi.')
      setProjects([])
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load])

  const flagged = projects?.filter((p) => p.flagged).length ?? 0
  const suspended = projects?.filter((p) => p.suspended).length ?? 0

  async function doFlag() {
    if (!flagTarget) return
    const reason = flagReason.trim()
    if (!reason) return // batal diam-diam bila kosong (seperti admin.js)
    setBusy(true)
    try {
      await api.post(`/api/admin/projects/${encodeURIComponent(flagTarget.id)}/flag`, { reason })
      toast.success(`Proyek "${flagTarget.name}" ditandai.`)
      setFlagTarget(null)
      setFlagReason('')
      await load()
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Gagal menandai proyek.')
    } finally {
      setBusy(false)
    }
  }

  async function doConfirm() {
    if (!confirm) return
    const { kind, project } = confirm
    setBusy(true)
    try {
      if (kind === 'unflag') {
        await api.del(`/api/admin/projects/${encodeURIComponent(project.id)}/flag`)
        toast.success('Tanda dihapus.')
      } else {
        await api.post(`/api/admin/projects/${encodeURIComponent(project.id)}/suspend`)
        toast.success(`Proyek "${project.name}" ditangguhkan.`)
      }
      setConfirm(null)
      await load()
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Gagal memproses.')
    } finally {
      setBusy(false)
    }
  }

  async function doUnsuspend(project: ModerationProject) {
    setBusy(true)
    try {
      await api.post(`/api/admin/projects/${encodeURIComponent(project.id)}/unsuspend`)
      toast.success(`Penangguhan proyek "${project.name}" dibuka.`)
      await load()
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Gagal membuka penangguhan.')
    } finally {
      setBusy(false)
    }
  }

  const confirmText =
    confirm?.kind === 'unflag'
      ? `Hapus tanda pada proyek "${confirm.project.name}"?`
      : `Tangguhkan proyek "${confirm?.project.name}"? Preview yang sedang berjalan dihentikan. Catatan: preview/publish di jalur publik belum diblokir otomatis sampai penegakan dibangun.`

  return (
    <div className="space-y-4">
      {!embedded ? (
        <PageHeader
          title="Moderasi"
          description={
            projects === null
              ? 'Moderasi proyek.'
              : `Moderasi proyek — ${fmtNum(projects.length)} proyek · ${fmtNum(flagged)} ditandai · ${fmtNum(suspended)} ditangguhkan`
          }
        />
      ) : null}
      <Alert tone="warning">
        Penangguhan di sini hanya menandai proyek di panel admin dan menghentikan preview yang sedang
        berjalan. Preview/publish di jalur publik <strong>belum diblokir otomatis</strong> — penegakan
        itu masih tertunda (butuh perubahan jalur penyajian). Penangguhan tidak terkait kuota.
      </Alert>
      {projects === null ? (
        <Spinner />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Proyek</Th>
              <Th>Pemilik</Th>
              <Th>Status</Th>
              <Th>Ditandai</Th>
              <Th>Ditangguhkan</Th>
              <Th>Tautan</Th>
              <Th className="text-right">Aksi</Th>
            </tr>
          </thead>
          <tbody>
            {projects.length === 0 ? (
              <EmptyRow colSpan={7}>Belum ada proyek.</EmptyRow>
            ) : (
              projects.map((p) => (
                <tr key={p.id}>
                  <Td>
                    <strong>{p.name}</strong>
                    <br />
                    <span className="font-mono text-xs text-muted">{p.id}</span>
                  </Td>
                  <Td>{p.owner_email || 'tanpa pemilik'}</Td>
                  <Td>
                    <Badge tone={projectStatusTone(p.status)}>{p.status}</Badge>
                  </Td>
                  <Td>
                    {p.flagged ? (
                      <>
                        <Badge tone="warning">Ditandai</Badge>
                        <br />
                        <span className="text-xs text-muted">{p.flag_reason}</span>
                        <br />
                        <span className="text-xs text-muted">
                          oleh {p.flag_by || '–'} · {fmtDateShort(p.flagged_at)}
                        </span>
                      </>
                    ) : (
                      <span className="text-muted">–</span>
                    )}
                  </Td>
                  <Td>
                    {p.suspended ? (
                      <Badge tone="danger">Ditangguhkan</Badge>
                    ) : (
                      <Badge tone="success">Aktif</Badge>
                    )}
                  </Td>
                  <Td className="whitespace-nowrap">
                    <a href={`/proyek/${p.id}`} className="text-accent hover:underline">
                      Buka
                    </a>
                    {p.slug ? (
                      <>
                        {' · '}
                        <a
                          href={`/p/${p.slug}`}
                          target="_blank"
                          rel="noopener"
                          className="text-accent hover:underline"
                        >
                          Terbit
                        </a>
                      </>
                    ) : null}
                  </Td>
                  <Td className="text-right whitespace-nowrap">
                    <span className="inline-flex gap-1.5">
                      {p.flagged ? (
                        <button
                          type="button"
                          className={btnOutlineSm}
                          disabled={busy}
                          onClick={() => setConfirm({ kind: 'unflag', project: p })}
                        >
                          Hapus tanda
                        </button>
                      ) : (
                        <button
                          type="button"
                          className={btnOutlineWarningSm}
                          disabled={busy}
                          onClick={() => {
                            setFlagTarget(p)
                            setFlagReason('')
                          }}
                        >
                          Tandai
                        </button>
                      )}
                      {p.suspended ? (
                        <button
                          type="button"
                          className={btnOutlineSuccessSm}
                          disabled={busy}
                          onClick={() => void doUnsuspend(p)}
                        >
                          Buka penangguhan
                        </button>
                      ) : (
                        <button
                          type="button"
                          className={btnOutlineDangerSm}
                          disabled={busy}
                          onClick={() => setConfirm({ kind: 'suspend', project: p })}
                        >
                          Tangguhkan
                        </button>
                      )}
                    </span>
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </Table>
      )}

      {/* Dialog tandai proyek (pengganti formDialog) */}
      <Modal
        open={flagTarget !== null}
        onClose={() => setFlagTarget(null)}
        title="Tandai proyek"
        footer={
          <>
            <button
              type="button"
              onClick={() => setFlagTarget(null)}
              disabled={busy}
              className={btnOutline}
            >
              Batal
            </button>
            <button
              type="button"
              onClick={() => void doFlag()}
              disabled={busy || !flagReason.trim()}
              className={btnPrimary}
            >
              Simpan
            </button>
          </>
        }
      >
        <Field
          label="Alasan penandaan"
          htmlFor="flag-reason"
          required
          hint="Alasan ini terlihat oleh admin lain di tabel moderasi."
        >
          <Textarea
            id="flag-reason"
            rows={3}
            value={flagReason}
            onChange={(e) => setFlagReason(e.target.value)}
          />
        </Field>
        <p className="mt-3 text-sm text-muted">Menandai proyek “{flagTarget?.name}”.</p>
      </Modal>

      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.kind === 'unflag' ? 'Hapus tanda' : 'Tangguhkan proyek'}
        message={confirmText}
        confirmLabel={confirm?.kind === 'unflag' ? 'Ya, hapus tanda' : 'Ya, tangguhkan'}
        loading={busy}
        onConfirm={() => void doConfirm()}
        onCancel={() => setConfirm(null)}
      />
    </div>
  )
}

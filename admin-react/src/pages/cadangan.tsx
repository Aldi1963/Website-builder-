import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Archive, ChatDots, Database, Download, Upload, Users } from '@phosphor-icons/react'
import { api, ApiError } from '../lib/api'
import { useToast } from '../lib/toast'
import { PageHeader } from '../components/PageHeader'
import { Badge } from '../components/Badge'
import { Card } from '../components/Card'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { Field, inputClass } from '../components/Field'
import { Spinner } from '../components/Spinner'
import { StatCard } from '../components/StatCard'
import { Table, Th, Td, EmptyRow } from '../components/Table'
import { btnOutlineWarningSm, btnPrimary, btnWarningSolid } from '../components/DFormat'
import { fmtBytes, fmtDate, fmtNum } from '../components/BFormat'

interface BackupFile {
  name: string
  size: number
  mtime: number
  isAutoBackup: boolean
}

interface BackupList {
  dbSize: number
  counts: { users: number; projects: number; messages: number; builds: number }
  files: BackupFile[]
}

interface RestoreResponse {
  ok: boolean
  restarting: boolean
  autoBackup: string
}

interface CadanganPageProps {
  /** Disematkan di halaman gabungan: PageHeader induk disembunyikan. */
  embedded?: boolean
}

export default function CadanganPage({ embedded = false }: CadanganPageProps) {
  const toast = useToast()
  const [data, setData] = useState<BackupList | null>(null)
  const [busy, setBusy] = useState(false)
  const [restoreTarget, setRestoreTarget] = useState<string | null>(null)
  const [uploadConfirm, setUploadConfirm] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [restoreResult, setRestoreResult] = useState<ReactNode>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    try {
      const d = await api.get<BackupList>('/api/admin/backup/list')
      setData(d)
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Gagal memuat cadangan.')
      setData({ dbSize: 0, counts: { users: 0, projects: 0, messages: 0, builds: 0 }, files: [] })
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load])

  async function doRestoreAuto(name: string) {
    setBusy(true)
    try {
      await api.post<RestoreResponse>('/api/admin/restore', { backup: name })
      setRestoreResult(
        <p className="mb-0 text-sm">
          <Badge tone="success">Berhasil</Badge> Server sedang restart dengan database yang dipulihkan.
          Tunggu beberapa detik lalu muat ulang halaman ini.
        </p>,
      )
      toast.success('Pemulihan diterima — server sedang restart.')
      setRestoreTarget(null)
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Gagal memulihkan.')
    } finally {
      setBusy(false)
    }
  }

  function submitRestoreForm(e: React.FormEvent) {
    e.preventDefault()
    const file = fileRef.current?.files?.[0]
    if (!file) {
      toast.error('Pilih dulu file cadangan (.db).')
      return
    }
    setUploadConfirm(true)
  }

  async function doRestoreUpload() {
    const file = fileRef.current?.files?.[0]
    if (!file) return
    setUploadConfirm(false)
    setRestoring(true)
    setRestoreResult(
      <p className="mb-0 text-sm text-muted">
        <Spinner label="Memvalidasi dan memulihkan…" />
      </p>,
    )
    try {
      const form = new FormData()
      form.append('file', file)
      const r = await api.post<RestoreResponse>('/api/admin/restore', form)
      setRestoreResult(
        <p className="mb-0 text-sm">
          <Badge tone="success">Berhasil</Badge> Server sedang restart dengan database yang dipulihkan.
          Cadangan otomatis: <code>{r.autoBackup || ''}</code>. Tunggu beberapa detik lalu muat ulang
          halaman ini.
        </p>,
      )
      toast.success('Pemulihan diterima — server sedang restart.')
    } catch (e) {
      // Gagal unggahan: tampilkan pesan error di area hasil (bukan toast).
      setRestoreResult(
        <p className="mb-0 text-sm text-danger">
          {e instanceof ApiError ? e.message : 'Pemulihan gagal.'}
        </p>,
      )
    } finally {
      setRestoring(false)
    }
  }

  return (
    <div className="space-y-4">
      {!embedded ? (
        <PageHeader
          title="Cadangan & Pulihkan"
          description="Unduh salinan database, atau pulihkan dari file cadangan. Setiap pemulihan otomatis menyimpan cadangan database aktif terlebih dahulu."
          actions={
            <a href="/api/admin/backup" className={btnPrimary}>
              <Download size={16} /> Unduh cadangan
            </a>
          }
        />
      ) : null}
      {data === null ? (
        <Spinner />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Ukuran database"
              value={fmtBytes(data.dbSize)}
              sub="file vibebuilder.db aktif"
              icon={<Database size={20} />}
            />
            <StatCard
              label="Pengguna"
              value={fmtNum(data.counts.users)}
              sub={`${fmtNum(data.counts.projects)} proyek`}
              icon={<Users size={20} />}
            />
            <StatCard
              label="Pesan"
              value={fmtNum(data.counts.messages)}
              sub={`${fmtNum(data.counts.builds)} build tercatat`}
              icon={<ChatDots size={20} />}
            />
            <StatCard
              label="File cadangan"
              value={fmtNum(data.files.length)}
              sub="di direktori data server"
              icon={<Archive size={20} />}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-5">
            <div className="min-w-0 lg:col-span-3">
              <Card title="File Cadangan di Server">
                <Table bare>
                  <thead>
                    <tr>
                      <Th>Nama file</Th>
                      <Th>Ukuran</Th>
                      <Th>Dibuat</Th>
                      <Th className="text-right">Aksi</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.files.length === 0 ? (
                      <EmptyRow colSpan={4}>
                        Belum ada file cadangan. Unduh cadangan dulu, atau pulihkan sekali — cadangan
                        otomatis akan muncul di sini.
                      </EmptyRow>
                    ) : (
                      data.files.map((f) => (
                        <tr key={f.name}>
                          <Td className="font-mono break-all">
                            {f.name}{' '}
                            {f.isAutoBackup ? <Badge tone="default">otomatis</Badge> : null}
                          </Td>
                          <Td>{fmtBytes(f.size)}</Td>
                          <Td className="whitespace-nowrap">{fmtDate(f.mtime)}</Td>
                          <Td className="text-right whitespace-nowrap">
                            {f.isAutoBackup ? (
                              <button
                                type="button"
                                className={btnOutlineWarningSm}
                                disabled={busy}
                                onClick={() => setRestoreTarget(f.name)}
                              >
                                Pulihkan
                              </button>
                            ) : (
                              <span className="text-sm text-muted">–</span>
                            )}
                          </Td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </Table>
                <p className="mt-3 text-sm text-muted">
                  File <code>.bak-&lt;waktu&gt;</code> dibuat otomatis setiap kali pemulihan berhasil —
                  itu cadangan database aktif sebelum diganti. Pulihkan dari file itu memakai jalur
                  validasi yang sama seperti unggahan.
                </p>
              </Card>
            </div>

            <div className="min-w-0 lg:col-span-2">
              <Card title="Pulihkan dari File">
                <p className="text-sm text-muted">
                  Unggah file <code>.db</code> hasil unduhan cadangan. File divalidasi dulu (integritas
                  SQLite + tabel inti); bila tidak valid, database aktif <strong>tidak diubah</strong>.
                  Bila valid, server menyimpan cadangan otomatis lalu restart sendiri dengan database
                  baru.
                </p>
                <form onSubmit={submitRestoreForm} className="mt-4 space-y-4">
                  <Field label="File cadangan (.db)" htmlFor="restore-file">
                    <input
                      ref={fileRef}
                      className={inputClass}
                      type="file"
                      id="restore-file"
                      accept=".db,application/octet-stream"
                      required
                    />
                  </Field>
                  <button type="submit" className={btnWarningSolid} disabled={restoring}>
                    <Upload size={16} /> Pulihkan database
                  </button>
                </form>
                {restoreResult ? <div className="mt-3">{restoreResult}</div> : null}
              </Card>
            </div>
          </div>
        </>
      )}

      <ConfirmDialog
        open={restoreTarget !== null}
        title="Pulihkan dari cadangan otomatis"
        message={`Ganti database aktif dengan ${restoreTarget ?? ''}? Database aktif saat ini disimpan dulu sebagai cadangan otomatis baru, lalu server restart sendiri.`}
        confirmLabel="Ya, pulihkan"
        loading={busy}
        onConfirm={() => (restoreTarget ? void doRestoreAuto(restoreTarget) : undefined)}
        onCancel={() => setRestoreTarget(null)}
      />
      <ConfirmDialog
        open={uploadConfirm}
        title="Pulihkan database"
        message="Ganti database aktif dengan file yang diunggah? Database aktif saat ini disimpan dulu sebagai cadangan otomatis baru, lalu server restart sendiri."
        confirmLabel="Ya, pulihkan"
        loading={restoring}
        onConfirm={() => void doRestoreUpload()}
        onCancel={() => setUploadConfirm(false)}
      />
    </div>
  )
}

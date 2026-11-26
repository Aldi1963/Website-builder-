import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { api, ApiError } from '../lib/api'
import { useToast } from '../lib/toast'
import { PageHeader } from '../components/PageHeader'
import { Card } from '../components/Card'
import { Table, Th, Td, EmptyRow } from '../components/Table'
import { btnOutlineDangerSm, btnOutlineSm, btnPrimary } from '../components/DFormat'
import { Badge } from '../components/Badge'
import { Spinner } from '../components/Spinner'
import { Alert } from '../components/Alert'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { Field, inputClass } from '../components/Field'
import { Select } from '../components/Select'
import { fmtNum, fmtDateShort } from '../components/BFormat'

interface DomainRow {
  id: number | string
  project_id: string
  domain: string
  status: string
  created_at: number
  verified_at: number | null
  project_name: string | null
  project_slug: string | null
}

interface ProjectOption {
  id: string
  name: string
}

interface VerifyResult {
  domain: string
  expectedCname: string
  cnames: string[]
  addresses: string[]
  cnameError: string | null
  aError: string | null
  matched: boolean
  note: string
  ssl: string
}

interface DomainPageProps {
  /** Disematkan di halaman gabungan: PageHeader induk disembunyikan. */
  embedded?: boolean
}

export default function DomainPage({ embedded = false }: DomainPageProps) {
  const toast = useToast()
  const [domains, setDomains] = useState<DomainRow[] | null>(null)
  const [subtitle, setSubtitle] = useState('Domain kustom proyek.')
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectId, setProjectId] = useState('')
  const [domainName, setDomainName] = useState('')
  const [dnsResult, setDnsResult] = useState<ReactNode>(null)
  const [checkingId, setCheckingId] = useState<string | number | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DomainRow | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [adding, setAdding] = useState(false)

  const load = useCallback(async () => {
    try {
      const [data, projectsData] = await Promise.all([
        api.get<{ domains: DomainRow[]; expectedCname: string; ssl: string }>('/api/admin/domains'),
        api.get<{ projects: ProjectOption[] }>('/api/admin/projects'),
      ])
      setDomains(data.domains || [])
      setSubtitle(
        `Domain kustom proyek — ${fmtNum(data.domains.length)} domain terdaftar · target CNAME ${data.expectedCname} · SSL: ${data.ssl}`,
      )
      setProjects(projectsData.projects || [])
      setProjectId((prev) => prev || projectsData.projects?.[0]?.id || '')
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Gagal memuat domain.')
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load])

  const addDomain = async () => {
    const domain = domainName.trim()
    if (!domain) {
      toast.error('Isi dulu nama domainnya.')
      return
    }
    setAdding(true)
    try {
      await api.post('/api/admin/domains', { projectId, domain })
      toast.success(`Domain ${domain} ditambahkan.`)
      setDomainName('')
      await load()
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Gagal menambah domain.')
    } finally {
      setAdding(false)
    }
  }

  const verifyDomain = async (d: DomainRow) => {
    setCheckingId(d.id)
    setDnsResult(
      <Alert tone="info">
        Memeriksa DNS {d.domain}…
      </Alert>,
    )
    try {
      const r = await api.post<VerifyResult>(`/api/admin/domains/${encodeURIComponent(String(d.id))}/verify`)
      setDnsResult(
        <Alert tone={r.matched ? 'success' : 'warning'}>
          <strong>{r.domain}</strong> — {r.matched ? 'CNAME cocok dengan target platform.' : 'Belum cocok.'}
          <br />
          <span className="text-xs">
            CNAME yang ditemukan: {r.cnames.length ? r.cnames.join(', ') : r.cnameError || 'tidak ada'}
            <br />
            A yang ditemukan: {r.addresses.length ? r.addresses.join(', ') : r.aError || 'tidak ada'}
            <br />
            Target yang diharapkan: CNAME ke <code>{r.expectedCname}</code>
            <br />
            {r.note}
            <br />
            SSL: {r.ssl}
          </span>
        </Alert>,
      )
      await load()
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Gagal memeriksa DNS.')
      setDnsResult(null)
    } finally {
      setCheckingId(null)
    }
  }

  const deleteDomain = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await api.del(`/api/admin/domains/${encodeURIComponent(String(deleteTarget.id))}`)
      toast.success(`Domain ${deleteTarget.domain} dihapus.`)
      setDeleteTarget(null)
      await load()
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Gagal menghapus domain.')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="space-y-4">
      {!embedded ? (
        <PageHeader title="Domain" description={subtitle} />
      ) : null}
      <Alert tone="warning">
        Routing dan SSL otomatis <strong>belum dipasang</strong> — halaman ini hanya mencatat domain dan memeriksa
        DNS. Target CNAME yang diharapkan: <code>clidi.net</code>.
      </Alert>

      <Card title="Tambah domain">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[200px] flex-1">
            <Field label="Proyek" htmlFor="domain-project">
              <Select id="domain-project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.id})
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="min-w-[200px] flex-1">
            <Field label="Domain" htmlFor="domain-name">
              <input
                id="domain-name"
                type="text"
                className={inputClass}
                placeholder="contoh: toko.example.com"
                autoComplete="off"
                value={domainName}
                onChange={(e) => setDomainName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void addDomain()
                  }
                }}
              />
            </Field>
          </div>
          <button
            type="button"
            onClick={() => void addDomain()}
            disabled={adding}
            className={btnPrimary}
          >
            {adding ? 'Menambah…' : 'Tambah'}
          </button>
        </div>
      </Card>

      {dnsResult ? <div>{dnsResult}</div> : null}

      {domains === null ? (
        <Spinner />
      ) : (
        <Table>
            <thead>
              <tr>
                <Th>Domain</Th>
                <Th>Proyek</Th>
                <Th>Status</Th>
                <Th>Dibuat</Th>
                <Th>Diverifikasi</Th>
                <Th className="text-right">Aksi</Th>
              </tr>
            </thead>
            <tbody>
              {domains.length === 0 ? (
                <EmptyRow colSpan={6}>Belum ada domain.</EmptyRow>
              ) : (
                domains.map((d) => (
                  <tr key={d.id}>
                    <Td>
                      <strong className="font-mono">{d.domain}</strong>
                    </Td>
                    <Td>
                      {d.project_name || d.project_id}
                      <br />
                      <span className="font-mono text-xs text-muted">{d.project_id}</span>
                    </Td>
                    <Td>
                      {d.status === 'verified' ? (
                        <Badge tone="success">Terverifikasi</Badge>
                      ) : (
                        <Badge tone="warning">Menunggu verifikasi</Badge>
                      )}
                    </Td>
                    <Td>{fmtDateShort(d.created_at)}</Td>
                    <Td>{d.verified_at ? fmtDateShort(d.verified_at) : <span className="text-muted">–</span>}</Td>
                    <Td className="text-right whitespace-nowrap">
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => void verifyDomain(d)}
                          disabled={checkingId === d.id}
                          className={btnOutlineSm}
                        >
                          {checkingId === d.id ? 'Memeriksa…' : 'Periksa DNS'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleteTarget(d)}
                          className={btnOutlineDangerSm}
                        >
                          Hapus
                        </button>
                      </div>
                    </Td>
                  </tr>
                ))
              )}
            </tbody>
          </Table>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Hapus domain"
        message={
          deleteTarget
            ? `Hapus domain ${deleteTarget.domain} dari daftar? Routing (bila sudah dipasang manual) tidak ikut dihapus.`
            : ''
        }
        confirmLabel="Ya, hapus"
        loading={deleting}
        onConfirm={() => void deleteDomain()}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}

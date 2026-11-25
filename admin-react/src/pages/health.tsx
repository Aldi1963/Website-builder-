import { useCallback, useEffect, useState } from 'react'
import { ChatDots, Cpu, Database, Pulse } from '@phosphor-icons/react'
import { api, ApiError } from '../lib/api'
import { useToast } from '../lib/toast'
import { PageHeader } from '../components/PageHeader'
import { Badge } from '../components/Badge'
import { Card } from '../components/Card'
import { Spinner } from '../components/Spinner'
import { StatCard } from '../components/StatCard'
import { Table, Th, Td } from '../components/Table'
import { fmtBytes, fmtNum } from '../components/DFormat'

interface HealthData {
  ok: boolean
  uptimeSec: number
  node: string
  platform: string
  memory: { rss: number; heapUsed: number; heapTotal: number }
  dbSize: number
  model: string
  strongModel: string
  auditModel: string
  llm: {
    host: string
    keyConfigured: boolean
    reachable: boolean
    status?: number
    latencyMs?: number
    error?: string
  }
  previews: { projectId: string; port: number }[]
  counts: { users: number; projects: number; messages: number; builds: number; sessions: number }
}

interface AlertsData {
  alerts: { level: 'warning' | 'critical'; kind: string; message: string; at: number }[]
  thresholds: { buildFailCount: number; buildFailPct: number; diskPct: number }
}

export default function HealthPage() {
  const toast = useToast()
  const [health, setHealth] = useState<HealthData | null>(null)
  const [alertsData, setAlertsData] = useState<AlertsData | null>(null)

  const load = useCallback(async () => {
    try {
      const h = await api.get<HealthData>('/api/admin/health')
      setHealth(h)
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Gagal memuat kesehatan sistem.')
      setHealth(null)
    }
    // Ambang peringatan: gagal dimuat diam-diam, kartu lain tetap tampil.
    try {
      const a = await api.get<AlertsData>('/api/admin/alerts')
      setAlertsData(a)
    } catch {
      /* abaikan */
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load])

  const upH = health ? Math.floor(health.uptimeSec / 3600) : 0
  const upM = health ? Math.floor((health.uptimeSec % 3600) / 60) : 0
  const th = alertsData?.thresholds

  return (
    <div className="space-y-4">
      <PageHeader title="Kesehatan Sistem" description="Status server, LLM, dan preview yang berjalan." />
      {health === null ? (
        <Spinner />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Uptime server"
              value={`${upH} jam ${upM} mnt`}
              sub={`Node ${health.node} · ${health.platform}`}
              icon={<Pulse size={22} />}
            />
            <StatCard
              label="Memori (RSS)"
              value={fmtBytes(health.memory.rss)}
              sub={`Heap ${fmtBytes(health.memory.heapUsed)} / ${fmtBytes(health.memory.heapTotal)}`}
              icon={<Cpu size={22} />}
            />
            <StatCard
              label="Ukuran database"
              value={fmtBytes(health.dbSize)}
              sub={`${fmtNum(health.counts.users)} pengguna · ${fmtNum(health.counts.projects)} proyek`}
              icon={<Database size={22} />}
            />
            <StatCard
              label="Sesi aktif"
              value={fmtNum(health.counts.sessions)}
              sub={`${fmtNum(health.counts.messages)} pesan · ${fmtNum(health.counts.builds)} build`}
              icon={<ChatDots size={22} />}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="LLM Gateway">
              <dl className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-2 text-sm">
                <dt className="text-muted">Endpoint</dt>
                <dd className="font-mono break-all">{health.llm.host}</dd>
                <dt className="text-muted">Model</dt>
                <dd className="font-mono break-all">{health.model}</dd>
                <dt className="text-muted">API key</dt>
                <dd>
                  {health.llm.keyConfigured ? (
                    <Badge tone="success">Terpasang</Badge>
                  ) : (
                    <Badge tone="danger">Tidak ada</Badge>
                  )}
                </dd>
                <dt className="text-muted">Status</dt>
                <dd>
                  {health.llm.reachable ? (
                    <>
                      <Badge tone="success">
                        Terjangkau{health.llm.status ? ` (HTTP ${health.llm.status})` : ''}
                      </Badge>{' '}
                      <small className="text-muted">{health.llm.latencyMs} ms</small>
                    </>
                  ) : (
                    <>
                      <Badge tone="danger">Tidak terjangkau</Badge>
                      <br />
                      <small className="text-danger">{health.llm.error || ''}</small>
                    </>
                  )}
                </dd>
              </dl>
            </Card>

            <Card title="Preview Berjalan">
              {health.previews.length === 0 ? (
                <p className="text-sm text-muted">Tidak ada preview yang berjalan saat ini.</p>
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th>Proyek</Th>
                      <Th>Port</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {health.previews.map((p) => (
                      <tr key={`${p.projectId}:${p.port}`}>
                        <td className="border-b border-border px-4 py-3 font-mono text-sm last:border-b-0">
                          {p.projectId}
                        </td>
                        <td className="border-b border-border px-4 py-3 text-sm last:border-b-0">{p.port}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Ambang Peringatan">
              {alertsData === null ? (
                <p className="text-sm text-muted">Memuat…</p>
              ) : (
                <>
                  <dl className="grid grid-cols-[160px_1fr] gap-x-4 gap-y-2 text-sm">
                    <dt className="text-muted">Build gagal (1 jam)</dt>
                    <dd>
                      {th?.buildFailCount ?? 3} gagal atau &gt;{th?.buildFailPct ?? 50}% gagal
                    </dd>
                    <dt className="text-muted">Disk penuh</dt>
                    <dd>&gt;{th?.diskPct ?? 85}% terpakai</dd>
                    <dt className="text-muted">Peringatan aktif</dt>
                    <dd>
                      {alertsData.alerts.length ? (
                        <span className="inline-flex flex-wrap gap-1">
                          {alertsData.alerts.map((a, i) => (
                            <Badge key={`${a.kind}-${i}`} tone={a.level === 'critical' ? 'danger' : 'warning'}>
                              {a.kind}
                            </Badge>
                          ))}
                        </span>
                      ) : (
                        <Badge tone="success">Tidak ada</Badge>
                      )}
                    </dd>
                  </dl>
                  <p className="mt-2 text-sm text-muted">
                    Ambang tersimpan di pengaturan admin (key alert_thresholds).
                  </p>
                </>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  )
}

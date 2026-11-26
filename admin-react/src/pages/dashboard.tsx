import { useCallback, useEffect, useState } from 'react'
import { ArrowClockwise, ChatDots, Cpu, Cube, Hammer, UserPlus, Users } from '@phosphor-icons/react'
import { api } from '../lib/api'
import { useToast } from '../lib/toast'
import { PageHeader } from '../components/PageHeader'
import { Card } from '../components/Card'
import { StatCard } from '../components/StatCard'
import { Table, Th, Td, EmptyRow } from '../components/Table'
import { Spinner } from '../components/Spinner'
import { BDoughnut, BLineChart, CHART_COLORS } from '../components/BCharts'
import { errMessage, fmtNum, timeAgo } from '../components/BFormat'
import { Avatar } from '../components/Avatar'

interface Overview {
  users: { total: number; new7d: number; disabled: number }
  projects: { total: number; published: number; new7d: number; byStatus: Record<string, number> }
  messages: { total: number; today: number; last7d: number }
  usage: { requests: number; promptTokens: number; completionTokens: number }
  recent: { kind: string; text: string; at: number }[]
  topUsers: { id: number; email: string; name: string; projects: number; messages: number }[]
}

interface Usage {
  daily: { date: string; messages: number; users: number; projects: number }[]
}

function activityIcon(kind: string) {
  if (kind === 'user') return <UserPlus size={18} />
  if (kind === 'project') return <Cube size={18} />
  return <Hammer size={18} />
}

export default function DashboardPage() {
  const toast = useToast()
  const [ov, setOv] = useState<Overview | null>(null)
  const [usage, setUsage] = useState<Usage | null>(null)
  const [loading, setLoading] = useState(true)
  const [subtitle, setSubtitle] = useState('Ringkasan VibeBuilder')

  const load = useCallback(async (): Promise<boolean> => {
    try {
      const [o, u] = await Promise.all([
        api.get<Overview>('/api/admin/overview'),
        api.get<Usage>('/api/admin/usage'),
      ])
      setOv(o)
      setUsage(u)
      setSubtitle(`Diperbarui ${new Date().toLocaleTimeString('id-ID')} · semua angka dari database`)
      return true
    } catch (e) {
      toast.error(errMessage(e))
      return false
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load])

  const refresh = async () => {
    if (await load()) {
      /* Seperti admin.js lama: refresh Dashboard juga me-refresh badge nav +
         notifikasi di layout (layout mendengarkan 'vb-admin:refresh-nav'). */
      window.dispatchEvent(new Event('vb-admin:refresh-nav'))
      toast.success('Data dimuat ulang.')
    }
  }

  const tokens = ov ? ov.usage.promptTokens + ov.usage.completionTokens : 0

  return (
    <div className="space-y-4">
      <PageHeader
        title="Dashboard"
        description={subtitle}
        actions={
          <button
            type="button"
            title="Muat ulang data"
            onClick={() => void refresh()}
            className="rounded-lg border border-border bg-surface p-2 text-muted hover:bg-surface-muted hover:text-ink"
          >
            <ArrowClockwise size={18} />
          </button>
        }
      />

      {loading && !ov ? (
        <Spinner />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Total Pengguna"
              value={fmtNum(ov?.users.total)}
              sub={
                ov
                  ? `+${fmtNum(ov.users.new7d)} dalam 7 hari · ${fmtNum(ov.users.disabled)} nonaktif`
                  : undefined
              }
              icon={<Users size={20} />}
            />
            <StatCard
              label="Total Proyek"
              value={fmtNum(ov?.projects.total)}
              sub={
                ov
                  ? `${fmtNum(ov.projects.published)} diterbitkan · +${fmtNum(ov.projects.new7d)} dalam 7 hari`
                  : undefined
              }
              icon={<Cube size={20} />}
            />
            <StatCard
              label="Total Pesan"
              value={fmtNum(ov?.messages.total)}
              sub={ov ? `${fmtNum(ov.messages.today)} hari ini · ${fmtNum(ov.messages.last7d)} dalam 7 hari` : undefined}
              icon={<ChatDots size={20} />}
            />
            <StatCard
              label="Token LLM"
              value={fmtNum(tokens)}
              sub={ov ? `${fmtNum(ov.usage.requests)} permintaan · sejak server start` : undefined}
              icon={<Cpu size={20} />}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card
              title="Pesan per Hari (14 hari)"
              className="min-w-0 lg:col-span-2"
            >
              {usage ? (
                <BLineChart
                  labels={usage.daily.map((d) => d.date.slice(5))}
                  datasets={[
                    { label: 'Pesan', data: usage.daily.map((d) => d.messages), color: CHART_COLORS.blue, fill: true },
                    { label: 'Proyek baru', data: usage.daily.map((d) => d.projects), color: CHART_COLORS.green },
                  ]}
                />
              ) : (
                <Spinner />
              )}
            </Card>
            <Card title="Aktivitas Terbaru">
              {ov && ov.recent.length ? (
                <ul className="space-y-3">
                  {ov.recent.map((r, i) => (
                    <li key={`${r.at}-${i}`} className="flex items-start gap-3">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
                        {activityIcon(r.kind)}
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm break-words">{r.text}</p>
                        <span className="text-xs text-muted">{timeAgo(r.at)}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted">Belum ada aktivitas.</p>
              )}
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Status Proyek">
              <BDoughnut
                slices={Object.entries(ov?.projects.byStatus || {}).map(([k, v]) => ({ label: k, value: v }))}
              />
            </Card>
            <Card title="Pengguna Teraktif">
              <Table bare>
                <thead>
                  <tr>
                    <Th>Pengguna</Th>
                    <Th>Proyek</Th>
                    <Th>Pesan</Th>
                  </tr>
                </thead>
                <tbody>
                  {ov && ov.topUsers.length ? (
                    ov.topUsers.map((u) => (
                      <tr key={u.id}>
                        <Td>
                          <div className="flex items-center gap-2">
                            <Avatar name={u.name} email={u.email} />
                            <span>
                              {u.name || u.email}
                              <br />
                              <span className="text-xs text-muted">{u.email}</span>
                            </span>
                          </div>
                        </Td>
                        <Td>{fmtNum(u.projects)}</Td>
                        <Td>{fmtNum(u.messages)}</Td>
                      </tr>
                    ))
                  ) : (
                    <EmptyRow colSpan={3}>Belum ada data.</EmptyRow>
                  )}
                </tbody>
              </Table>
            </Card>
          </div>
        </>
      )}
    </div>
  )
}

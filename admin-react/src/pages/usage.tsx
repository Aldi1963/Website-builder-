import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useToast } from '../lib/toast'
import { PageHeader } from '../components/PageHeader'
import { Card } from '../components/Card'
import { StatCard } from '../components/StatCard'
import { Table, Th, Td } from '../components/Table'
import { Spinner } from '../components/Spinner'
import { BLineChart, CHART_COLORS } from '../components/BCharts'
import { errMessage, fmtNum } from '../components/BFormat'

interface UsageData {
  llm: { requests: number; promptTokens: number; completionTokens: number }
  daily: { date: string; messages: number; users: number; projects: number }[]
  byUser: { email: string; name: string; messages: number }[]
  byUserTokens: { email: string; name: string; tokens: number; prompt_tokens: number; completion_tokens: number }[]
  totals: { messages: number; projects: number; builds: number; tokens: number }
}

export default function UsagePage() {
  const toast = useToast()
  const [data, setData] = useState<UsageData | null>(null)

  const load = useCallback(async () => {
    try {
      const d = await api.get<UsageData>('/api/admin/usage')
      setData(d)
    } catch (e) {
      toast.error(errMessage(e))
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="space-y-4">
      <PageHeader
        title="Penggunaan"
        description="Token LLM sejak server start & aktivitas 14 hari terakhir."
      />

      {data === null ? (
        <Spinner />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Permintaan LLM" value={fmtNum(data.llm.requests)} sub="sejak server start" />
            <StatCard label="Token Prompt" value={fmtNum(data.llm.promptTokens)} sub="sejak server start" />
            <StatCard label="Token Completion" value={fmtNum(data.llm.completionTokens)} sub="sejak server start" />
            <StatCard
              label="Total Token"
              value={fmtNum(data.llm.promptTokens + data.llm.completionTokens)}
              sub="prompt + completion"
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="Aktivitas Harian" className="lg:col-span-2">
              <BLineChart
                labels={data.daily.map((d) => d.date.slice(5))}
                datasets={[
                  { label: 'Pesan', data: data.daily.map((d) => d.messages), color: CHART_COLORS.blue, fill: true },
                  { label: 'Pengguna baru', data: data.daily.map((d) => d.users), color: CHART_COLORS.teal },
                  { label: 'Proyek baru', data: data.daily.map((d) => d.projects), color: CHART_COLORS.green },
                ]}
              />
            </Card>
            <Card title="Pesan per Pengguna">
              <Table>
                <thead>
                  <tr>
                    <Th>Pengguna</Th>
                    <Th>Pesan</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.byUser.length ? (
                    data.byUser.map((u) => (
                      <tr key={u.email}>
                        <Td>
                          {u.name || u.email}
                          <br />
                          <small className="text-muted">{u.email}</small>
                        </Td>
                        <Td>{fmtNum(u.messages)}</Td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={2} className="border-b border-border px-4 py-3 align-top text-muted">Belum ada data.</td>
                    </tr>
                  )}
                </tbody>
              </Table>
            </Card>
          </div>

          <Card title="Token per Pengguna">
            <p className="mb-3 text-sm text-muted">
              Token LLM tercatat per pengguna sejak pencatatan aktif (riwayat sebelum itu tidak ada datanya).
              Total token tercatat: <strong>{fmtNum(data.totals.tokens || 0)}</strong>.
            </p>
            <Table>
              <thead>
                <tr>
                  <Th>Pengguna</Th>
                  <Th>Token</Th>
                  <Th>Prompt</Th>
                  <Th>Completion</Th>
                </tr>
              </thead>
              <tbody>
                {(data.byUserTokens || []).length ? (
                  data.byUserTokens.map((u) => (
                    <tr key={u.email}>
                      <Td>
                        {u.name || u.email}
                        <br />
                        <small className="text-muted">{u.email}</small>
                      </Td>
                      <Td>{fmtNum(u.tokens)}</Td>
                      <Td>{fmtNum(u.prompt_tokens)}</Td>
                      <Td>{fmtNum(u.completion_tokens)}</Td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={4} className="border-b border-border px-4 py-3 align-top text-muted">Belum ada token tercatat per pengguna.</td>
                  </tr>
                )}
              </tbody>
            </Table>
          </Card>
        </>
      )}
    </div>
  )
}

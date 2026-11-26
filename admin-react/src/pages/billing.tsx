import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { useToast } from '../lib/toast'
import { PageHeader } from '../components/PageHeader'
import { Card } from '../components/Card'
import { Alert } from '../components/Alert'
import { Table, Th, Td, EmptyRow } from '../components/Table'
import { btnOutlineLg, btnPrimary } from '../components/DFormat'
import { Badge } from '../components/Badge'
import { Spinner } from '../components/Spinner'
import { Field, inputClass } from '../components/Field'
import { fmtNum, fmtDate, fmtRp } from '../components/BFormat'

interface BillingPackage {
  id: string
  amountIdr: number
  credits: number
}

interface WebhookEvent {
  order_id: string
  event: string
  signature_valid: boolean
  result: string | null
  created_at: number
}

interface BillingData {
  configured: boolean
  apiKeyFromEnv: boolean
  hasWebhookSecret: boolean
  webhookUrl: string | null
  packages: BillingPackage[]
  orderCounts: Record<string, number>
  recentWebhookEvents: WebhookEvent[]
}

interface BillingPageProps {
  /** Disematkan di halaman gabungan: PageHeader induk disembunyikan. */
  embedded?: boolean
}

export default function BillingPage({ embedded = false }: BillingPageProps) {
  const toast = useToast()
  const [data, setData] = useState<BillingData | null>(null)

  const load = useCallback(async () => {
    try {
      const d = await api.get<BillingData>('/api/admin/billing')
      setData(d)
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Gagal memuat pembayaran.')
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load])

  const copyWebhook = async () => {
    const url = data?.webhookUrl || ''
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      toast.success('Webhook URL disalin.')
    } catch {
      // Fallback lama: select + execCommand.
      const input = document.getElementById('billing-webhook-url') as HTMLInputElement | null
      if (input) {
        input.select()
        document.execCommand('copy')
      }
      toast.success('Webhook URL disalin.')
    }
  }

  const orderEntries = data ? Object.entries(data.orderCounts || {}) : []

  return (
    <div className="space-y-4">
      {!embedded ? (
        <PageHeader
          title="Pembayaran"
          description="Top-up credit lewat QRIS — pilih paket, bayar sekali, credit langsung masuk. Tanpa langganan bulanan."
        />
      ) : null}
      {data === null ? (
        <Spinner />
      ) : (
        <div className="grid gap-4 lg:grid-cols-7">
          <div className="min-w-0 space-y-4 lg:col-span-4">
            <Card title="Kredensial">
              <Alert tone="info">
                Merchant API key dan webhook secret dikelola di halaman{' '}
                <a href="/admin/settings#api-keys" className="text-accent underline">
                  Pengaturan → API Key &amp; Secret
                </a>
                . Halaman ini hanya menampilkan status &amp; URL webhook untuk paket credit.
              </Alert>
            </Card>

            <Card title="Webhook">
              <Field
                label="Webhook URL — tempel URL ini di panel Clipku Pay"
                htmlFor="billing-webhook-url"
                hint="Gateway memanggil URL ini sesudah pembayaran. Pembayaran hanya dikreditkan sesudah statusnya diverifikasi ulang ke provider."
              >
                <div className="flex gap-2">
                  <input
                    id="billing-webhook-url"
                    type="text"
                    className={`${inputClass} font-mono`}
                    readOnly
                    value={data.webhookUrl || ''}
                  />
                  <button
                    type="button"
                    onClick={() => void copyWebhook()}
                    disabled={!data.webhookUrl}
                    className={`shrink-0 ${btnOutlineLg}`}
                  >
                    Salin
                  </button>
                </div>
              </Field>
            </Card>
          </div>

          <div className="min-w-0 space-y-4 lg:col-span-3">
            <Card title="Status">
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
                <dt className="text-muted">API key</dt>
                <dd className="font-mono">{data.configured ? 'Terpasang' : 'Belum terpasang'}</dd>
                <dt className="text-muted">Sumber key</dt>
                <dd className="font-mono">
                  {data.configured ? (data.apiKeyFromEnv ? 'Environment server' : 'Panel ini') : '–'}
                </dd>
                <dt className="text-muted">Webhook secret</dt>
                <dd className="font-mono">
                  {data.hasWebhookSecret ? 'Terpasang' : 'Belum terpasang (HMAC nonaktif)'}
                </dd>
                <dt className="text-muted">Webhook URL</dt>
                <dd className="font-mono break-all">{data.webhookUrl || '–'}</dd>
              </dl>
            </Card>

            <Card title="Paket Top-up">
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {(data.packages || []).map((p) => (
                  <li key={p.id}>
                    {fmtRp(p.amountIdr)} = {fmtNum(p.credits)} credit
                  </li>
                ))}
              </ul>
            </Card>

            <Card title="Order & Webhook Terakhir">
              <p className="mb-3 flex flex-wrap gap-1">
                {orderEntries.length === 0 ? (
                  <span className="text-sm text-muted">Belum ada order.</span>
                ) : (
                  orderEntries.map(([st, n]) => (
                    <Badge key={st}>
                      {st}: {fmtNum(n)}
                    </Badge>
                  ))
                )}
              </p>
              <Table bare>
                <thead>
                  <tr>
                    <Th>Order</Th>
                    <Th>Event</Th>
                    <Th>Signature</Th>
                    <Th>Hasil</Th>
                    <Th>Waktu</Th>
                  </tr>
                </thead>
                <tbody>
                  {(data.recentWebhookEvents || []).length === 0 ? (
                    <EmptyRow colSpan={5}>Belum ada event webhook.</EmptyRow>
                  ) : (
                    (data.recentWebhookEvents || []).map((ev, i) => (
                      <tr key={`${ev.order_id}-${ev.event}-${i}`}>
                        <Td className="font-mono">{ev.order_id}</Td>
                        <Td>{ev.event}</Td>
                        <Td>{ev.signature_valid ? <Badge tone="success">Valid</Badge> : <Badge>–</Badge>}</Td>
                        <Td>{ev.result || '–'}</Td>
                        <Td className="whitespace-nowrap">{fmtDate(ev.created_at)}</Td>
                      </tr>
                    ))
                  )}
                </tbody>
              </Table>
            </Card>

          </div>
        </div>
      )}
    </div>
  )
}

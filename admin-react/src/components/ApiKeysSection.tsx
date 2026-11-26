import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, ApiError } from '../lib/api'
import { useToast } from '../lib/toast'
import { Badge } from './Badge'
import { Card } from './Card'
import { Alert } from './Alert'
import { Field, inputClass } from './Field'
import { Spinner } from './Spinner'
import { btnOutline, btnPrimary } from './DFormat'

/* Semua kredensial (API key & secret) dikonsentrasi di satu tempat: halaman
   Pengaturan. Halaman AI/Pembayaran tidak lagi menampilkan field sensitif. */

type Source = 'db' | 'env' | 'default'

interface AiSettings {
  keyConfigured: boolean
  sources: { key: Source }
}

interface BillingData {
  configured: boolean
  apiKeyFromEnv: boolean
  hasWebhookSecret: boolean
}

interface Provider {
  id: string
  name: string
  baseUrl: string
  keyEnv?: string | null
  keyConfigured: boolean
}

function SrcBadge({ src, configured }: { src: Source; configured: boolean }) {
  if (!configured) return <Badge>belum</Badge>
  if (src === 'env') return <Badge tone="warning">env</Badge>
  if (src === 'db') return <Badge tone="accent">panel</Badge>
  return <Badge tone="default">default</Badge>
}

export function ApiKeysSection() {
  const toast = useToast()
  const [ai, setAi] = useState<AiSettings | null>(null)
  const [billing, setBilling] = useState<BillingData | null>(null)
  const [providers, setProviders] = useState<Provider[]>([])
  const [llmKey, setLlmKey] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [webhookSecret, setWebhookSecret] = useState('')
  const [providerKeys, setProviderKeys] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [a, b, p] = await Promise.all([
        api.get<AiSettings>('/api/admin/ai-settings'),
        api.get<BillingData>('/api/admin/billing'),
        api.get<{ providers: Provider[] }>('/api/admin/llm/providers'),
      ])
      setAi(a)
      setBilling(b)
      setProviders(p.providers || [])
      setLlmKey('')
      setApiKey('')
      setWebhookSecret('')
      setProviderKeys({})
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Gagal memuat kredensial.')
    }
  }, [toast])

  useEffect(() => { void load() }, [load])

  const saveLlmKey = async (e: FormEvent) => {
    e.preventDefault()
    setBusy('llm')
    try {
      const k = llmKey.trim()
      await api.put('/api/admin/ai-settings', k ? { key: k } : { key: '' })
      toast.success(k ? 'API key LLM disimpan.' : 'API key LLM dihapus — memakai environment/default.')
      setLlmKey('')
      await load()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Gagal menyimpan API key LLM.')
    } finally { setBusy(null) }
  }

  const saveBilling = async (e: FormEvent) => {
    e.preventDefault()
    setBusy('billing')
    try {
      const r = await api.put<{ configured: boolean }>('/api/admin/billing', {
        apiKey: apiKey.trim(), // Kosongkan untuk menghapus nilai panel
        webhookSecret: webhookSecret.trim(),
      })
      toast.success(r.configured ? 'Kredensial pembayaran disimpan.' : 'Kredensial pembayaran dihapus.')
      setApiKey('')
      setWebhookSecret('')
      await load()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Gagal menyimpan kredensial pembayaran.')
    } finally { setBusy(null) }
  }

  const saveProviderKey = async (id: string) => {
    setBusy(id)
    try {
      const key = (providerKeys[id] || '').trim()
      if (key && key.length < 8) {
        toast.error('API key terlalu pendek (min 8 karakter).')
        return
      }
      await api.put(`/api/admin/llm/providers/${encodeURIComponent(id)}/key`, { key })
      toast.success(key ? `Key ${id} disimpan.` : `Key ${id} dihapus — memakai environment.`)
      setProviderKeys((prev) => ({ ...prev, [id]: '' }))
      await load()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Gagal menyimpan key provider.')
    } finally { setBusy(null) }
  }

  return (
    <div className="space-y-4">
      {ai === null || billing === null ? <Spinner label="Memuat kredensial…" /> : (
        <>
          <Alert tone="info">
            Semua API key & secret dikelola di sini. Nilai key <strong>tidak pernah ditampilkan</strong> —
            hanya status terpasang. Kosongkan field lalu simpan untuk menghapus nilai yang tersimpan di panel;
            key dari environment server tetap berlaku bila tidak ada key panel.
          </Alert>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="API Key LLM">
              <form onSubmit={(e) => void saveLlmKey(e)} className="space-y-4">
                <Field
                  label={<>Kunci LLM utama <SrcBadge src={ai.sources.key} configured={ai.keyConfigured} /></>}
                  htmlFor="settings-llm-key"
                  hint="Dipakai untuk chat & agent bila provider tidak punya key sendiri. Isi untuk mengganti, kosongkan untuk memakai environment/default."
                >
                  <input
                    id="settings-llm-key"
                    type="password"
                    autoComplete="new-password"
                    className={`${inputClass} font-mono`}
                    placeholder={ai.keyConfigured ? '•••••••• (terpasang — isi untuk mengganti)' : 'Belum ada key'}
                    value={llmKey}
                    onChange={(e) => setLlmKey(e.target.value)}
                  />
                </Field>
                <button type="submit" className={btnPrimary} disabled={busy !== null}>
                  {busy === 'llm' ? 'Menyimpan…' : 'Simpan key LLM'}
                </button>
              </form>
            </Card>

            <Card title="Kredensial Pembayaran (Clipku Pay)">
              <form onSubmit={(e) => void saveBilling(e)} className="space-y-4">
                <Field
                  label={<>Merchant API key <SrcBadge src={billing.apiKeyFromEnv ? 'env' : 'db'} configured={billing.configured} /></>}
                  htmlFor="settings-clipku-key"
                  hint="Key merchant dari panel Clipku Pay. Kosongkan lalu simpan untuk menghapus nilai panel."
                >
                  <input
                    id="settings-clipku-key"
                    type="password"
                    autoComplete="new-password"
                    className={`${inputClass} font-mono`}
                    placeholder={billing.configured ? '•••••••• (terpasang — isi untuk mengganti)' : 'Belum ada key'}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                  />
                </Field>
                <Field
                  label={<>Webhook secret <SrcBadge src="db" configured={billing.hasWebhookSecret} /></>}
                  htmlFor="settings-clipku-secret"
                  hint="Opsional. Aktifkan HMAC hanya bila gateway terbukti mengirim x-clipkupay-signature."
                >
                  <input
                    id="settings-clipku-secret"
                    type="password"
                    autoComplete="new-password"
                    className={`${inputClass} font-mono`}
                    placeholder={billing.hasWebhookSecret ? '•••••••• (terpasang — isi untuk mengganti)' : 'Belum ada secret'}
                    value={webhookSecret}
                    onChange={(e) => setWebhookSecret(e.target.value)}
                  />
                </Field>
                <button type="submit" className={btnPrimary} disabled={busy !== null}>
                  {busy === 'billing' ? 'Menyimpan…' : 'Simpan kredensial pembayaran'}
                </button>
              </form>
            </Card>
          </div>

          <Card title="API Key per Provider LLM">
            <div className="space-y-4">
              <p className="text-sm text-muted">
                Key provider mengalahkan key LLM utama untuk model dari provider itu. Kosongkan lalu simpan
                untuk kembali ke environment / key utama.
              </p>
              {providers.length === 0 ? (
                <p className="text-sm text-muted">Belum ada provider di registry.</p>
              ) : providers.map((p) => (
                <div key={p.id} className="flex flex-wrap items-end gap-3 border-t border-border pt-4 first:border-0 first:pt-0">
                  <div className="min-w-[260px] flex-1">
                    <Field
                      label={<>{p.name} <SrcBadge src={p.keyEnv ? 'env' : 'db'} configured={p.keyConfigured} /></>}
                      htmlFor={`settings-provider-${p.id}`}
                      hint={`${p.baseUrl}${p.keyEnv ? ` · env: ${p.keyEnv}` : ''}`}
                    >
                      <input
                        id={`settings-provider-${p.id}`}
                        type="password"
                        autoComplete="new-password"
                        className={`${inputClass} font-mono`}
                        placeholder={p.keyConfigured ? '•••••••• (terpasang — isi untuk mengganti)' : 'Belum ada key'}
                        value={providerKeys[p.id] || ''}
                        onChange={(e) => setProviderKeys((prev) => ({ ...prev, [p.id]: e.target.value }))}
                      />
                    </Field>
                  </div>
                  <button
                    type="button"
                    onClick={() => void saveProviderKey(p.id)}
                    disabled={busy !== null}
                    className={btnOutline}
                  >
                    {busy === p.id ? 'Menyimpan…' : p.keyConfigured ? 'Simpan / hapus key' : 'Simpan key'}
                  </button>
                </div>
              ))}
            </div>
          </Card>
        </>
      )}
    </div>
  )
}

export default ApiKeysSection

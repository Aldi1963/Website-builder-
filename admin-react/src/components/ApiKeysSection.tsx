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


interface NeonData {
  configured: boolean
  hasApiKey: boolean
  projectId: string
  hasBranchId: boolean
  fromEnv: { apiKey: boolean; projectId: boolean }
  note: string
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
  const [neon, setNeon] = useState<NeonData | null>(null)
  const [neonKey, setNeonKey] = useState('')
  const [neonProject, setNeonProject] = useState('')
  const [neonBranch, setNeonBranch] = useState('')
  const [llmKey, setLlmKey] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [webhookSecret, setWebhookSecret] = useState('')
  const [providerKeys, setProviderKeys] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [a, b, p, n] = await Promise.all([
        api.get<AiSettings>('/api/admin/ai-settings'),
        api.get<BillingData>('/api/admin/billing'),
        api.get<{ providers: Provider[] }>('/api/admin/llm/providers'),
        api.get<NeonData>('/api/admin/neon'),
      ])
      setAi(a)
      setBilling(b)
      setProviders(p.providers || [])
      setNeon(n)
      setLlmKey('')
      setApiKey('')
      setWebhookSecret('')
      setNeonKey('')
      setNeonProject('')
      setNeonBranch('')
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


  const saveNeon = async (e: FormEvent) => {
    e.preventDefault()
    /* Hanya field yang diisi yang dikirim: field kosong = tidak berubah
       (server tidak lagi mengartikan string kosong sebagai hapus). */
    const payload: { apiKey?: string; projectId?: string; branchId?: string } = {}
    if (neonKey.trim()) payload.apiKey = neonKey.trim()
    if (neonProject.trim()) payload.projectId = neonProject.trim()
    if (neonBranch.trim()) payload.branchId = neonBranch.trim()
    if (Object.keys(payload).length === 0) {
      toast.info('Tidak ada field yang diisi — tidak ada perubahan.')
      return
    }
    setBusy('neon')
    try {
      const r = await api.put<{ configured: boolean }>('/api/admin/neon', payload)
      toast.success(r.configured ? 'Kredensial Neon disimpan.' : 'Kredensial Neon disimpan — memakai Postgres lokal.')
      setNeonKey('')
      setNeonProject('')
      setNeonBranch('')
      await load()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Gagal menyimpan kredensial Neon.')
    } finally { setBusy(null) }
  }

  /* Hapus eksplisit per field — satu-satunya cara menghapus nilai Neon dari
     panel. Mengirim parameter `clear`, bukan string kosong. */
  const clearNeon = async (field: 'apiKey' | 'projectId' | 'branchId', label: string) => {
    setBusy(`neon-clear-${field}`)
    try {
      await api.put('/api/admin/neon', { clear: [field] })
      toast.success(`${label} dihapus.`)
      await load()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : `Gagal menghapus ${label}.`)
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
      {ai === null || billing === null || neon === null ? <Spinner label="Memuat kredensial…" /> : (
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


          <Card title="Database Neon (Serverless Postgres)">
            <form onSubmit={(e) => void saveNeon(e)} className="space-y-4">
              <p className="text-sm text-muted">
                Database terkelola per proyek memakai Neon bila terpasang, Postgres lokal bila tidak.
                {neon.configured
                  ? ' Terpasang — nilai rahasia tidak pernah ditampilkan kembali.'
                  : ' Belum terpasang.'}
                {neon.projectId ? ` Project: ${neon.projectId}` : ''}
                {neon.hasBranchId ? ' · branch terpasang.' : ''}
                {neon.fromEnv.apiKey ? ' (key dari environment)' : ''}
              </p>
              <Field
                label={<>Neon API key <SrcBadge src={neon.fromEnv.apiKey ? 'env' : 'db'} configured={neon.hasApiKey} /></>}
                htmlFor="settings-neon-key"
                hint="API key Neon (console.neon.tech). Field yang dikosongkan tidak berubah — pakai tombol Hapus untuk menghapus."
              >
                <input
                  id="settings-neon-key"
                  type="password"
                  autoComplete="new-password"
                  className={`${inputClass} font-mono`}
                  placeholder={neon.hasApiKey ? '•••••••• (terpasang — isi untuk mengganti)' : 'Belum ada key'}
                  value={neonKey}
                  onChange={(e) => setNeonKey(e.target.value)}
                />
              </Field>
              {neon.hasApiKey && (
                <button type="button" onClick={() => void clearNeon('apiKey', 'Neon API key')} disabled={busy !== null} className={btnOutline}>
                  Hapus API key
                </button>
              )}
              <Field
                label="Neon project ID"
                htmlFor="settings-neon-project"
                hint="ID project Neon. Kosong bila memakai personal API key (project dicari otomatis). Field yang dikosongkan tidak berubah."
              >
                <input
                  id="settings-neon-project"
                  type="text"
                  autoComplete="off"
                  className={`${inputClass} font-mono`}
                  placeholder={neon.projectId ? `${neon.projectId} (terpasang — isi untuk mengganti)` : 'Belum ada project ID'}
                  value={neonProject}
                  onChange={(e) => setNeonProject(e.target.value)}
                />
              </Field>
              {neon.projectId && (
                <button type="button" onClick={() => void clearNeon('projectId', 'Neon project ID')} disabled={busy !== null} className={btnOutline}>
                  Hapus project ID
                </button>
              )}
              <Field
                label="Neon branch ID"
                htmlFor="settings-neon-branch"
                hint="Opsional. Kosongkan untuk memakai branch utama project. Field yang dikosongkan tidak berubah."
              >
                <input
                  id="settings-neon-branch"
                  type="text"
                  autoComplete="off"
                  className={`${inputClass} font-mono`}
                  placeholder={neon.hasBranchId ? '•••••••• (terpasang — isi untuk mengganti)' : 'Belum ada branch ID'}
                  value={neonBranch}
                  onChange={(e) => setNeonBranch(e.target.value)}
                />
              </Field>
              {neon.hasBranchId && (
                <button type="button" onClick={() => void clearNeon('branchId', 'Neon branch ID')} disabled={busy !== null} className={btnOutline}>
                  Hapus branch ID
                </button>
              )}
              <button type="submit" className={btnPrimary} disabled={busy !== null}>
                {busy === 'neon' ? 'Menyimpan…' : 'Simpan kredensial Neon'}
              </button>
            </form>
          </Card>

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

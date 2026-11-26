import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { useToast } from '../lib/toast'
import { PageHeader } from '../components/PageHeader'
import { Badge } from '../components/Badge'
import { Card } from '../components/Card'
import { Field, inputClass } from '../components/Field'
import { Spinner } from '../components/Spinner'
import { btnOutline, btnPrimary } from '../components/DFormat'

type Source = 'db' | 'env' | 'default'

interface AiSettings {
  model: string
  modelStrong: string
  modelAudit: string
  endpoint: string
  keyConfigured: boolean
  sources: { model: Source; modelStrong: Source; modelAudit: Source; endpoint: Source; key: Source }
  defaults: { model: string; modelStrong: string; modelAudit: string }
}

interface TestResult {
  ok: boolean
  model: string
  latencyMs: number
  reply?: string
  error?: string
}

function SrcBadge({ src }: { src: Source }) {
  if (src === 'db') return <Badge tone="accent">panel</Badge>
  if (src === 'env') return <Badge tone="warning">env</Badge>
  return <Badge tone="default">default</Badge>
}

export default function AiSettingsPage() {
  const toast = useToast()
  const [settings, setSettings] = useState<AiSettings | null>(null)
  const [busy, setBusy] = useState(false)
  const [model, setModel] = useState('')
  const [modelStrong, setModelStrong] = useState('')
  const [modelAudit, setModelAudit] = useState('')
  const [endpoint, setEndpoint] = useState('')
  const [key, setKey] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | { ok: false; error: string } | null>(null)

  const load = useCallback(async () => {
    try {
      const s = await api.get<AiSettings>('/api/admin/ai-settings')
      setSettings(s)
      setModel(s.model || '')
      setModelStrong(s.modelStrong || '')
      setModelAudit(s.modelAudit || '')
      setEndpoint(s.endpoint || '')
      setKey('')
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Gagal memuat pengaturan AI.')
      setSettings(null)
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load])

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const payload: Record<string, string> = {
        model: model.trim(),
        modelStrong: modelStrong.trim(),
        modelAudit: modelAudit.trim(),
        endpoint: endpoint.trim(),
      }
      const k = key.trim()
      if (k) payload.key = k
      await api.put('/api/admin/ai-settings', payload)
      toast.success('Pengaturan AI disimpan — berlaku langsung tanpa restart.')
      setKey('')
      await load()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Gagal menyimpan pengaturan AI.')
    } finally {
      setBusy(false)
    }
  }

  async function testConnection() {
    setTesting(true)
    setTestResult(null)
    try {
      const r = await api.post<TestResult>('/api/admin/ai-settings/test')
      // Server selalu HTTP 200: kegagalan LLM ditandai ok:false di body.
      setTestResult(r)
    } catch (e) {
      setTestResult({ ok: false, error: e instanceof ApiError ? e.message : 'Tes koneksi gagal.' })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        description="Model dan provider LLM yang dipakai server. Perubahan berlaku langsung tanpa restart."
      />
      {settings === null ? (
        <Spinner />
      ) : (
        <div className="grid gap-4 lg:grid-cols-5">
          <div className="min-w-0 lg:col-span-3">
            <Card title="Konfigurasi AI">
              <form onSubmit={(e) => void save(e)} autoComplete="off" className="space-y-4">
                <Field
                  label={
                    <>
                      Model utama <SrcBadge src={settings.sources.model} />
                    </>
                  }
                  htmlFor="ai-model"
                  hint="Model default untuk chat dan agent. Kosongkan untuk kembali ke environment/default."
                >
                  <input
                    type="text"
                    className={inputClass}
                    id="ai-model"
                    placeholder={settings.defaults.model}
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                  />
                </Field>
                <Field
                  label={
                    <>
                      Model kuat <SrcBadge src={settings.sources.modelStrong} />
                    </>
                  }
                  htmlFor="ai-model-strong"
                  hint="Model untuk pekerjaan berat bila diminta klien."
                >
                  <input
                    type="text"
                    className={inputClass}
                    id="ai-model-strong"
                    placeholder={settings.defaults.modelStrong}
                    value={modelStrong}
                    onChange={(e) => setModelStrong(e.target.value)}
                  />
                </Field>
                <Field
                  label={
                    <>
                      Model audit <SrcBadge src={settings.sources.modelAudit} />
                    </>
                  }
                  htmlFor="ai-model-audit"
                  hint="Model peninjau keamanan/aksesibilitas sesudah penulisan file."
                >
                  <input
                    type="text"
                    className={inputClass}
                    id="ai-model-audit"
                    placeholder={settings.defaults.modelAudit}
                    value={modelAudit}
                    onChange={(e) => setModelAudit(e.target.value)}
                  />
                </Field>
                <Field
                  label={
                    <>
                      Endpoint LLM <SrcBadge src={settings.sources.endpoint} />
                    </>
                  }
                  htmlFor="ai-endpoint"
                  hint="URL lengkap endpoint OpenAI-compatible (chat/completions)."
                >
                  <input
                    type="url"
                    className={inputClass}
                    id="ai-endpoint"
                    placeholder="http://127.0.0.1:20128/v1/chat/completions"
                    value={endpoint}
                    onChange={(e) => setEndpoint(e.target.value)}
                  />
                </Field>
                <Field
                  label={
                    <>
                      API key <SrcBadge src={settings.sources.key} />
                    </>
                  }
                  htmlFor="ai-key"
                  hint="Isi untuk mengganti key, atau kosongkan untuk memakai yang sudah tersimpan / environment. Nilai key tidak pernah ditampilkan."
                >
                  <input
                    type="password"
                    className={inputClass}
                    id="ai-key"
                    autoComplete="new-password"
                    placeholder={
                      settings.keyConfigured ? '•••••••• (terpasang — isi untuk mengganti)' : 'Belum ada key'
                    }
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                  />
                </Field>
                <div className="flex gap-2">
                  <button type="submit" className={btnPrimary} disabled={busy}>
                    Simpan Pengaturan AI
                  </button>
                  <button type="button" className={btnOutline} disabled={busy || testing} onClick={() => void testConnection()}>
                    Tes Koneksi
                  </button>
                </div>
              </form>
            </Card>
          </div>

          <div className="min-w-0 space-y-4 lg:col-span-2">
            <Card title="Konfigurasi Efektif">
              <dl className="grid grid-cols-[160px_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
                <dt className="text-muted">Model utama</dt>
                <dd className="font-mono break-all">{settings.model}</dd>
                <dt className="text-muted">Model kuat</dt>
                <dd className="font-mono break-all">{settings.modelStrong}</dd>
                <dt className="text-muted">Model audit</dt>
                <dd className="font-mono break-all">{settings.modelAudit}</dd>
                <dt className="text-muted">Endpoint</dt>
                <dd className="font-mono break-all">{settings.endpoint}</dd>
                <dt className="text-muted">API key</dt>
                <dd className="font-mono">{settings.keyConfigured ? 'Terpasang' : 'Tidak ada'}</dd>
              </dl>
            </Card>
            <Card title="Hasil Tes Koneksi">
              {testing ? (
                <Spinner label="Mengirim prompt tes ke LLM…" />
              ) : testResult === null ? (
                <p className="text-sm text-muted">
                  Belum ada tes. Tekan &ldquo;Tes Koneksi&rdquo; untuk mengirim satu prompt kecil ke LLM
                  dengan konfigurasi saat ini.
                </p>
              ) : testResult.ok ? (
                <>
                  <p className="mb-1 text-sm">
                    <Badge tone="success">Berhasil</Badge>{' '}
                    <span className="text-xs text-muted">
                      {testResult.latencyMs} ms · model <code>{testResult.model}</code>
                    </span>
                  </p>
                  <p className="mb-0 text-sm">
                    Balasan: <strong>{testResult.reply}</strong>
                  </p>
                </>
              ) : (
                <>
                  <p className="mb-1 text-sm">
                    <Badge tone="danger">Gagal</Badge>
                  </p>
                  <p className="mb-0 text-sm text-danger">{testResult.error}</p>
                </>
              )}
            </Card>
            <Card title="Sumber Nilai">
              <p className="text-sm text-muted">
                <Badge tone="accent">panel</Badge> diubah dari panel admin ini (tersimpan di database).{' '}
                <Badge tone="warning">env</Badge> berasal dari environment server.{' '}
                <Badge tone="default">default</Badge> nilai bawaan kode. Nilai panel selalu menang atas
                env.
              </p>
            </Card>
          </div>
        </div>
      )}
    </div>
  )
}

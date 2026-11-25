import { useEffect, useRef, useState } from 'react'
import { Tabs } from '@cloudflare/kumo/components/tabs'
import { Button } from '@cloudflare/kumo/components/button'
import { Icon, Spinner, Wordmark } from './ui'
import { api, auth, ChatHandlers, chatStream, Project, type User } from './api'
import { AuthGate, UserBar } from './auth'
import { ChatPanel, CodePane, PreviewPane, SettingsSheet, type ChatAudit, type ChatPlan } from './panels'
import { exportProjectZip } from './api'

/* Theme is a real choice here: the shell is used for long sessions next to an
   arbitrary generated app, so both modes ship and both are verified. */
function useTheme() {
  const [dark, setDark] = useState(() => {
    const saved = localStorage.getItem('vb-theme')
    if (saved) return saved === 'dark'
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  })

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    localStorage.setItem('vb-theme', dark ? 'dark' : 'light')
  }, [dark])

  return { dark, toggle: () => setDark((d) => !d) }
}

const PUBLIC_ORIGIN = import.meta.env.VITE_PUBLIC_ORIGIN ?? 'https://vibe.clipku.com'

function publicUrl(slug: string) {
  const u = new URL(PUBLIC_ORIGIN)
  return `${u.protocol}//${slug}.${u.host}/`
}

function publicLabel(url: string | null, slug: string) {
  if (!url) return `/p/${slug}`
  try {
    return new URL(url).host
  } catch {
    return `/p/${slug}`
  }
}

export default function App() {
  const [user, setUser] = useState<User | null>(null)
  const [sessionChecked, setSessionChecked] = useState(false)
  const [projects, setProjects] = useState<Project[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [navOpen, setNavOpen] = useState(false)
  const { dark, toggle } = useTheme()

  const refresh = async () => {
    try {
      const { projects } = await api.listProjects()
      setProjects(projects)
      setLoadError('')
      if (!activeId && projects[0]) setActiveId(projects[0].id)
    } catch (err) {
      setLoadError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    auth
      .me()
      .then((r) => setUser(r.user))
      .catch(() => setUser(null))
      .finally(() => setSessionChecked(true))
  }, [])

  useEffect(() => {
    if (!user) return
    void refresh()
    const t = setInterval(() => void refresh(), 8000)
    return () => clearInterval(t)
  }, [user])

  const logout = async () => {
    await auth.logout().catch(() => {})
    setUser(null)
    setProjects([])
    setActiveId(null)
  }

  const createProject = async () => {
    const { project } = await api.createProject('Proyek tanpa nama')
    setProjects((p) => [project, ...p])
    setActiveId(project.id)
    setNavOpen(false)
  }

  const removeProject = async (id: string) => {
    await api.deleteProject(id)
    setProjects((p) => p.filter((x) => x.id !== id))
    if (activeId === id) setActiveId(null)
  }

  if (!sessionChecked) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-ink">
        <Spinner />
      </div>
    )
  }

  if (!user) return <AuthGate onUser={setUser} />

  return (
    <div className="flex h-dvh overflow-hidden bg-ink text-body">
      <Sidebar
        user={user}
        onLogout={logout}
        projects={projects}
        activeId={activeId}
        loading={loading}
        loadError={loadError}
        dark={dark}
        onToggleTheme={toggle}
        onSelect={(id) => {
          setActiveId(id)
          setNavOpen(false)
        }}
        onCreate={createProject}
        onDelete={removeProject}
        open={navOpen}
        onClose={() => setNavOpen(false)}
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-edge bg-surface px-3 md:hidden">
          <button
            onClick={() => setNavOpen(true)}
            aria-expanded={navOpen}
            aria-controls="vb-nav"
            className="flex h-11 w-11 items-center justify-center text-body"
          >
            <Icon name="menu" size={16} title="Buka daftar proyek" />
          </button>
          <Wordmark size={14} />
        </header>

        {activeId ? (
          <Workspace
            key={activeId}
            projectId={activeId}
            onTitle={(name) => setProjects((p) => p.map((x) => (x.id === activeId ? { ...x, name } : x)))}
          />
        ) : (
          <EmptyState onCreate={createProject} />
        )}
      </div>
    </div>
  )
}

function Sidebar({
  user,
  onLogout,
  projects,
  activeId,
  loading,
  loadError,
  dark,
  onToggleTheme,
  onSelect,
  onCreate,
  onDelete,
  open,
  onClose,
}: {
  user: User
  onLogout: () => void
  projects: Project[]
  activeId: string | null
  loading: boolean
  loadError: string
  dark: boolean
  onToggleTheme: () => void
  onSelect: (id: string) => void
  onCreate: () => void
  onDelete: (id: string) => void
  open: boolean
  onClose: () => void
}) {
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    closeRef.current?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <>
      {open && (
        <div
          onClick={onClose}
          aria-hidden="true"
          className="fixed inset-0 z-20 bg-black/55 md:hidden"
        />
      )}

      <aside
        id="vb-nav"
        aria-label="Daftar proyek"
        className={`z-30 flex w-[252px] shrink-0 flex-col border-r border-edge bg-surface max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:w-[86vw] max-md:transition-transform ${
          open ? 'max-md:translate-x-0' : 'max-md:-translate-x-full'
        }`}
      >
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-edge px-3">
          <Wordmark />
          <button
            ref={closeRef}
            onClick={onClose}
            className="flex h-11 w-11 items-center justify-center text-quiet md:hidden"
          >
            <Icon name="close" size={15} title="Tutup daftar proyek" />
          </button>
          <button
            onClick={onToggleTheme}
            aria-label={dark ? 'Ganti ke tema terang' : 'Ganti ke tema gelap'}
            className="flex h-8 w-8 items-center justify-center text-quiet transition-colors hover:text-body max-md:hidden"
          >
            <Icon name={dark ? 'sun' : 'moon'} size={13} />
          </button>
        </div>

        <div className="px-3 py-3">
          <button
            onClick={onCreate}
            className="flex h-8 max-md:h-11 w-full items-center justify-center gap-1.5 bg-accent text-[12px] font-medium text-ink transition-opacity hover:opacity-90"
          >
            <Icon name="plus" size={11} />
            Proyek baru
          </button>
        </div>

        <div className="vb-seam flex-1 overflow-y-auto">
          <p className="px-3 pb-1 pt-2.5 text-[11px] text-quiet">
            {projects.length ? `${projects.length} proyek` : 'proyek'}
          </p>

          {loading && (
            <div className="flex items-center gap-2 px-3 py-3 text-[11.5px] text-quiet">
              <Spinner />
              Memuat daftar proyek
            </div>
          )}

          {!loading && loadError && (
            <div className="mx-3 my-2 border-l-2 border-accent py-1 pl-2">
              <p className="text-[11.5px] leading-relaxed text-body">
                Server tidak menjawab. Cek proses di port 3000.
              </p>
              <p className="mt-1 break-words font-mono text-[10.5px] text-quiet">{loadError}</p>
            </div>
          )}

          {!loading && !loadError && !projects.length && (
            <p className="px-3 py-3 text-[11.5px] leading-relaxed text-quiet">
              Belum ada proyek. Tekan Proyek baru untuk memulai yang pertama.
            </p>
          )}

          {projects.map((p) => (
            <div
              key={p.id}
              className={`group flex items-center ${
                activeId === p.id ? 'border-l-2 border-l-accent bg-ink' : 'border-l-2 border-l-transparent'
              }`}
            >
              <button
                onClick={() => onSelect(p.id)}
                aria-current={activeId === p.id ? 'true' : undefined}
                className="flex min-h-[34px] max-md:min-h-[44px] flex-1 items-center gap-2 px-2.5 py-1 text-left"
              >
                <StatusMark status={p.status} />
                <span className="truncate text-[12.5px] text-body">{p.name}</span>
              </button>
              <button
                onClick={() => {
                  if (confirm(`Hapus "${p.name}" beserta seluruh filenya?`)) void onDelete(p.id)
                }}
                aria-label={`Hapus ${p.name}`}
                className="mr-1 flex h-7 w-7 items-center justify-center text-quiet opacity-0 transition-opacity hover:text-body group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100"
              >
                <Icon name="trash" size={11} />
              </button>
            </div>
          ))}
        </div>

        <UserBar user={user} onLogout={onLogout} />

        <div className="border-t border-edge px-3 py-2">
          <p className="text-[10.5px] leading-relaxed text-quiet">
            TanStack Start, React 19, Tailwind v4
          </p>
        </div>
      </aside>
    </>
  )
}

/* Square, not a pill and not a glow: the mark reports the project's real run
   state and nothing else, so shape carries it as much as color. */
function StatusMark({ status }: { status: string }) {
  const color =
    status === 'working'
      ? 'bg-accent'
      : status === 'building'
        ? 'bg-body'
        : status === 'error'
          ? 'bg-accent'
          : 'bg-edge'
  return <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 ${color}`} />
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center px-6">
      <div className="max-w-[44ch]">
        <h1 className="font-display text-[26px] leading-tight text-body">
          Satu ruang kerja untuk menulis dan menjalankan aplikasi
        </h1>
        <p className="mt-3 text-[13px] leading-relaxed text-quiet">
          Setiap proyek punya workspace sendiri: file ditulis agent, di-build dengan Vite,
          lalu disajikan di port lokal supaya bisa dicoba langsung.
        </p>
        <button
          onClick={onCreate}
          className="mt-6 flex h-9 max-md:h-11 items-center gap-2 bg-accent px-3 text-[12.5px] font-medium text-ink transition-opacity hover:opacity-90"
        >
          <Icon name="plus" size={12} />
          Buat proyek pertama
        </button>
      </div>
    </div>
  )
}

type Tab = 'chat' | 'code'

function Workspace({ projectId, onTitle }: { projectId: string; onTitle: (n: string) => void }) {
  const [tab, setTab] = useState<Tab>('chat')
  const [messages, setMessages] = useState<{ role: string; content: string; id?: number }[]>([])
  const [streamText, setStreamText] = useState('')
  const [changedFiles, setChangedFiles] = useState<string[]>([])
  const [files, setFiles] = useState<{ path: string }[]>([])
  const [previewPort, setPreviewPort] = useState<number>(0)
  const [previewOn, setPreviewOn] = useState(false)
  const [booting, setBooting] = useState(false)
  const [status, setStatus] = useState('')
  const [plan, setPlan] = useState<ChatPlan | null>(null)
  const [audit, setAudit] = useState<ChatAudit | null>(null)
  const [buildLog, setBuildLog] = useState<{ ok: boolean; log: string } | null>(null)
  const [openFile, setOpenFile] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [name, setName] = useState('')
  const [sending, setSending] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [slug, setSlug] = useState<string | null>(null)
  const [publishing, setPublishing] = useState(false)
  const [publishMsg, setPublishMsg] = useState('')
  const [pubUrl, setPubUrl] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [model, setModel] = useState(() => localStorage.getItem('vb-model') ?? 'auto')
  const [planMode, setPlanMode] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const load = async () => {
    const d = await api.getProject(projectId)
    setMessages(d.messages.map((m) => ({ role: m.role, content: m.content, id: m.id })))
    setFiles(d.files.map((f) => ({ path: f.path })))
    setName(d.project.name)
    setPreviewPort(d.previewPort)
    setSlug(d.project.slug ?? null)
    setPubUrl(d.project.slug ? publicUrl(d.project.slug) : null)
    const st = await api.previewStatus(projectId)
    setPreviewOn(st.running)
  }

  useEffect(() => {
    void load()
    return () => abortRef.current?.abort()
  }, [projectId])

  const autoPreview = async () => {
    try {
      const p = await api.preview(projectId)
      setPreviewPort(p.port)
      setPreviewOn(true)
      setDirty(false)
    } catch {
      /* preview belum siap, tombol Jalankan tetap tersedia */
    }
  }

  const send = async (text: string) => {
    if (!text.trim() || sending) return
    setSending(true)
    setStatus('menyiapkan')
    setPlan(null)
    setAudit(null)
    setStreamText('')
    setChangedFiles([])
    setMessages((m) => [...m, { role: 'user', content: text }])

    const ctrl = new AbortController()
    abortRef.current = ctrl

    const handlers: ChatHandlers = {
      onStatus: (t) => setStatus(t),
      onPlan: (event) => setPlan(event),
      onAudit: (event) => setAudit(event),
      onFile: async (path) => {
        const { files } = await api.files(projectId)
        setFiles(files.map((f) => ({ path: f.path })))
        if (path) setChangedFiles((prev) => (prev.includes(path) ? prev : [...prev, path]))
        setDirty(true)
        if (previewOn) void reloadPreview()
      },
      onBuild: (ok, log) => {
        setBuildLog({ ok, log })
        if (!ok) setTab('code')
      },
      onAssistantDelta: (d) => {
        setStreamText((prev) => {
          const next = prev + d
          setStatus('')
          return next
        })
      },
      onAssistant: (t) => {
        setStreamText('')
        setMessages((m) => [...m, { role: 'assistant', content: t }])
      },
      onError: (t) => {
        setStreamText('')
        setMessages((m) => [...m, { role: 'error', content: t }])
      },
      onDone: () => {
        setStatus('')
        void api.files(projectId).then(({ files }) => setFiles(files.map((f) => ({ path: f.path }))))
        void autoPreview()
      },
    }

    try {
      await chatStream(projectId, text, handlers, ctrl.signal, { model: model === 'auto' ? undefined : model, planMode })
    } catch (err) {
      setMessages((m) => [...m, { role: 'error', content: (err as Error).message }])
    } finally {
      setSending(false)
      setStatus('')
      abortRef.current = null
    }
  }

  const startPreview = async () => {
    setBooting(true)
    try {
      const b = await api.build(projectId)
      if (!b.ok) {
        setBuildLog({ ok: false, log: b.log })
        setTab('code')
        return
      }
      const p = await api.preview(projectId)
      setPreviewPort(p.port)
      setPreviewOn(true)
      setDirty(false)
    } catch (err) {
      setBuildLog({ ok: false, log: (err as Error).message })
    } finally {
      setBooting(false)
    }
  }

  const publish = async () => {
    setPublishing(true)
    setPublishMsg('')
    try {
      const r = await api.publish(projectId, slug ?? undefined)
      setSlug(r.slug)
      setPubUrl(r.url)
      setPreviewPort(r.port)
      setPreviewOn(true)
      setDirty(false)
    } catch (err) {
      setPublishMsg((err as Error).message)
    } finally {
      setPublishing(false)
    }
  }

  const unpublish = async () => {
    await api.unpublish(projectId)
    setSlug(null)
  }

  const reloadPreview = async () => {
    try {
      const p = await api.preview(projectId)
      setPreviewPort(p.port)
      setPreviewOn(true)
      setDirty(false)
    } catch {
      /* biarkan status lama */
    }
  }

  const openFileAt = async (path: string) => {
    setOpenFile(path)
    try {
      const f = await api.file(projectId, path)
      setFileContent(f.content)
      setSavedContent(f.content)
    } catch {
      setFileContent('')
      setSavedContent('')
      setBuildLog({ ok: false, log: `Gagal membaca ${path}` })
    }
  }

  const saveFile = async () => {
    if (!openFile) return
    await api.saveFile(projectId, openFile, fileContent)
    setSavedContent(fileContent)
    setBuildLog(null)
  }

  const rename = async () => {
    const next = name.trim()
    if (!next) return
    await api.renameProject(projectId, next)
    onTitle(next)
  }

  const unsaved = openFile !== null && fileContent !== savedContent

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-edge bg-surface px-3">
        <label htmlFor="vb-project-name" className="sr-only">
          Nama proyek
        </label>
        <input
          id="vb-project-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={rename}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          className="min-w-0 max-w-[240px] flex-1 border border-transparent bg-transparent px-1.5 py-1 text-[13px] text-body outline-none transition-colors hover:border-edge focus:border-edge"
        />

        <div className="flex items-center border border-edge">
          <Tabs
            variant="segmented"
            size="sm"
            selectedValue={tab}
            onValueChange={(v) => setTab(v as Tab)}
            tabs={[
              { value: 'chat', label: 'Chat' },
              { value: 'code', label: 'Kode' },
            ]}
          />
        </div>

        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setSettingsOpen(true)}
            aria-label="Buka pengaturan sesi"
            className="flex h-7 max-md:h-11 items-center gap-1.5 border border-edge px-2.5 text-[11.5px] text-body transition-colors hover:border-quiet"
          >
            <Icon name="rule" size={10} />
            <span className="max-sm:hidden">{model === 'auto' ? 'Model: Auto' : model.replace(/^[a-z]+\//, '')}</span>
            <span className="sm:hidden">Setelan</span>
          </button>
          {status && (
            <span className="hidden items-center gap-1.5 text-[11.5px] text-quiet lg:flex">
              <Spinner />
              {status}
            </span>
          )}
          <Button
            onClick={startPreview}
            disabled={booting}
            variant="outline"
            size="sm"
            className="h-7 max-md:h-11"
          >
            {booting ? <Spinner /> : <Icon name="run" size={10} />}
            {booting ? 'Build' : previewOn ? 'Build ulang' : 'Jalankan'}
          </Button>
          {slug ? (
            <div className="hidden items-center gap-1.5 md:flex">
              <a
                href={pubUrl ?? `/p/${slug}`}
                target="_blank"
                rel="noreferrer"
                title={pubUrl ?? undefined}
                className="flex h-7 max-w-[240px] items-center gap-1.5 border border-accent px-2.5 text-[11.5px] text-accent transition-opacity hover:opacity-80"
              >
                <Icon name="open" size={10} />
                <span className="truncate">{publicLabel(pubUrl, slug)}</span>
              </a>
              <button
                onClick={unpublish}
                className="h-7 px-1.5 text-[11px] text-quiet transition-colors hover:text-body"
              >
                Tarik
              </button>
            </div>
          ) : (
            <Button
              onClick={publish}
              disabled={publishing || !files.length}
              variant="outline"
              size="sm"
              className="hidden h-7 md:flex"
            >
              {publishing ? <Spinner /> : <Icon name="check" size={10} />}
              {publishing ? 'Menerbitkan' : 'Terbitkan'}
            </Button>
          )}
          {previewOn && (
            <a
              href={`http://127.0.0.1:${previewPort}/`}
              target="_blank"
              rel="noreferrer"
              className="hidden h-7 items-center gap-1.5 border border-edge px-2.5 text-[11.5px] text-body transition-colors hover:border-quiet md:flex"
            >
              <Icon name="open" size={10} />
              Tab baru
            </a>
          )}
          {!!files.length && (
            <button
              onClick={() => void exportProjectZip(projectId).catch(() => {})}
              className="hidden h-7 items-center gap-1.5 border border-edge px-2.5 text-[11.5px] text-body transition-colors hover:border-quiet md:flex"
              title="Unduh seluruh file proyek sebagai ZIP"
            >
              <Icon name="download" size={10} />
              Export
            </button>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <section
          className={`flex min-w-0 flex-col border-r border-edge ${
            tab === 'chat' ? 'w-[46%] max-w-[600px] max-md:w-full max-md:max-w-none' : 'hidden'
          }`}
        >
          <ChatPanel
            messages={messages}
            sending={sending}
            status={status}
            plan={plan}
            audit={audit}
            streamText={streamText}
            onSend={send}
            onCancel={() => abortRef.current?.abort()}
          />
        </section>

        <section className={`flex min-w-0 flex-1 flex-col ${tab === 'chat' ? 'max-md:hidden' : ''}`}>
          {tab === 'chat' ? (
            <PreviewPane
              previewOn={previewOn}
              previewPort={previewPort}
              dirty={dirty}
              buildLog={buildLog}
              onRun={startPreview}
              booting={booting}
              hasFiles={files.length > 0}
            />
          ) : (
            <CodePane
              files={files}
              openFile={openFile}
              content={fileContent}
              buildLog={buildLog}
              changedFiles={changedFiles}
              projectId={projectId}
              onOpen={openFileAt}
              onChange={setFileContent}
              onSave={saveFile}
              onBuild={startPreview}
              onFilesRefresh={() => void api.files(projectId).then(({ files }) => setFiles(files.map((f) => ({ path: f.path }))))}
            />
          )}
        </section>
      </div>

      <SettingsSheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        projectId={projectId}
        projectName={name}
        model={model}
        onModel={(m) => {
          setModel(m)
          localStorage.setItem('vb-model', m)
        }}
        planMode={planMode}
        onPlanMode={setPlanMode}
      />

      {publishMsg && (
        <p className="shrink-0 border-t border-edge bg-surface px-3 py-1.5 text-[11px] text-accent">
          {publishMsg}
        </p>
      )}

      {unsaved && (
        <p className="shrink-0 border-t border-edge bg-surface px-3 py-1.5 text-[11px] text-accent">
          Perubahan pada {openFile} belum disimpan. Tekan Simpan sebelum build.
        </p>
      )}
    </div>
  )
}

function TabBtn({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <Button
      onClick={onClick}
      aria-pressed={active}
      size="sm"
      variant="ghost"
      className={`h-7 max-md:h-11 ${active ? 'bg-accent text-ink' : 'text-quiet'}`}
    >
      {label}
    </Button>
  )
}

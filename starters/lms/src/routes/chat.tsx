import { createFileRoute } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { streamChat, type ChatMessage } from '~/lib/chat'

export const Route = createFileRoute('/chat')({
  component: ChatPage,
})

function ChatPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const abortRef = useRef<AbortController | null>(null)

  const send = async () => {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    setError('')
    setBusy(true)
    const next: ChatMessage[] = [...messages, { role: 'user', content: text }]
    setMessages([...next, { role: 'assistant', content: '' }])
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      await streamChat(next, {
        signal: ctrl.signal,
        onDelta: (delta) => {
          setMessages((prev) => {
            const copy = [...prev]
            const last = copy[copy.length - 1]
            copy[copy.length - 1] = { ...last, content: last.content + delta }
            return copy
          })
        },
      })
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError((err as Error).message)
        setMessages((prev) => prev.slice(0, -1))
      }
    } finally {
      setBusy(false)
      abortRef.current = null
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col px-6 py-10">
      <h1 className="text-3xl font-bold tracking-tight">Chat</h1>
      <p className="mt-2 text-sm text-muted">Tanya apa saja. Jawaban mengalir langsung dari AI.</p>
      <div className="mt-6 flex flex-1 flex-col gap-3">
        {messages.length === 0 && (
          <p className="rounded-lg border border-edge bg-surface p-4 text-sm text-muted">
            Belum ada percakapan. Tulis pesan di bawah untuk memulai.
          </p>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={
              m.role === 'user'
                ? 'self-end rounded-lg bg-accent px-4 py-2 text-sm text-white'
                : 'self-start whitespace-pre-wrap rounded-lg border border-edge bg-surface px-4 py-2 text-sm text-ink'
            }
          >
            {m.content || '…'}
          </div>
        ))}
      </div>
      {error && (
        <p className="mt-4 rounded-lg border border-danger/30 bg-danger/5 p-3 text-sm text-danger">{error}</p>
      )}
      <div className="mt-4 flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
          placeholder="Tulis pesan…"
          disabled={busy}
          className="input min-w-0 flex-1"
        />
        {busy ? (
          <button
            onClick={() => abortRef.current?.abort()}
            className="btn"
          >
            Berhenti
          </button>
        ) : (
          <button
            onClick={() => void send()}
            disabled={!input.trim()}
            className="btn-primary"
          >
            Kirim
          </button>
        )}
      </div>
    </main>
  )
}

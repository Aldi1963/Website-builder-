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
      <p className="mt-2 text-sm text-slate-400">Tanya apa saja. Jawaban mengalir langsung dari AI.</p>
      <div className="mt-6 flex flex-1 flex-col gap-3">
        {messages.length === 0 && (
          <p className="rounded-lg border border-slate-800 bg-slate-900 p-4 text-sm text-slate-400">
            Belum ada percakapan. Tulis pesan di bawah untuk memulai.
          </p>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={
              m.role === 'user'
                ? 'self-end rounded-lg bg-slate-800 px-4 py-2 text-sm'
                : 'self-start whitespace-pre-wrap rounded-lg border border-slate-800 bg-slate-900 px-4 py-2 text-sm'
            }
          >
            {m.content || '…'}
          </div>
        ))}
      </div>
      {error && (
        <p className="mt-4 rounded-lg border border-red-900 bg-red-950 p-3 text-sm text-red-200">{error}</p>
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
          className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm outline-none focus:border-slate-500"
        />
        {busy ? (
          <button
            onClick={() => abortRef.current?.abort()}
            className="rounded-lg border border-slate-700 px-4 py-2 text-sm"
          >
            Berhenti
          </button>
        ) : (
          <button
            onClick={() => void send()}
            disabled={!input.trim()}
            className="rounded-lg bg-slate-100 px-4 py-2 text-sm font-medium text-slate-900 disabled:opacity-40"
          >
            Kirim
          </button>
        )}
      </div>
    </main>
  )
}

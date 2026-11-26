import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { ingestText, searchKnowledge, buildContext } from '~/lib/rag'
import { streamChat } from '~/lib/chat'

/**
 * Contoh halaman tanya-jawab dokumen (RAG) — template, salin pola ini.
 * Tempel teks -> disimpan ke basis pengetahuan (pgvector). Bertanya -> retrieval
 * + jawaban LLM dari pengetahuan.
 */

const ingest = createServerFn({ method: 'POST' })
  .validator((input: { source: string; text: string }) => input)
  .handler(async ({ data }) => ingestText(data.source || 'dokumen', data.text))

const ask = createServerFn({ method: 'POST' })
  .validator((input: { question: string }) => input)
  .handler(async ({ data }) => {
    const hits = await searchKnowledge(data.question)
    const context = buildContext(hits)
    let answer = ''
    await streamChat(
      [{ role: 'user', content: data.question }],
      {
        system: context
          ? `${context}\n\nJawab dalam Bahasa Indonesia berdasarkan potongan di atas, sebutkan sumber [n] bila relevan.`
          : 'Jawab dalam Bahasa Indonesia. Basis pengetahuan kosong.',
        onDelta: (d: string) => (answer += d),
      },
    )
    return { answer, sources: hits.map((h) => h.source) }
  })

export const Route = createFileRoute('/knowledge')({
  component: KnowledgePage,
})

function KnowledgePage() {
  const [source, setSource] = useState('')
  const [text, setText] = useState('')
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)

  async function simpan(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setStatus('')
    try {
      const r = await ingest({ data: { source, text } })
      setStatus(`Tersimpan ${r.chunks} potongan.`)
      setText('')
    } catch (err) {
      setStatus((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function tanya(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setAnswer('')
    try {
      const r = await ask({ data: { question } })
      setAnswer(r.answer || '(tidak ada jawaban)')
    } catch (err) {
      setAnswer(`Error: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-16 space-y-10">
      <h1 className="text-3xl font-bold tracking-tight">Tanya-jawab dokumen</h1>
      <section className="space-y-3">
        <h2 className="text-xl font-semibold">1. Simpan pengetahuan</h2>
        <form className="space-y-3" onSubmit={simpan}>
          <input className="w-full rounded border border-stone-300 px-3 py-2" placeholder="Nama sumber (mis. manual produk)" value={source} onInput={(e) => setSource((e.target as HTMLInputElement).value)} />
          <textarea className="w-full rounded border border-stone-300 px-3 py-2" rows={5} placeholder="Tempel teks dokumen di sini..." value={text} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} />
          <button className="rounded bg-stone-900 px-4 py-2 text-white" type="submit" disabled={busy}>Simpan</button>
        </form>
        {status && <p className="text-sm text-stone-600">{status}</p>}
      </section>
      <section className="space-y-3">
        <h2 className="text-xl font-semibold">2. Bertanya</h2>
        <form className="space-y-3" onSubmit={tanya}>
          <input className="w-full rounded border border-stone-300 px-3 py-2" placeholder="Apa yang ingin kamu tahu?" value={question} onInput={(e) => setQuestion((e.target as HTMLInputElement).value)} />
          <button className="rounded bg-stone-900 px-4 py-2 text-white" type="submit" disabled={busy}>{busy ? 'Memproses…' : 'Tanya'}</button>
        </form>
        {answer && <pre className="whitespace-pre-wrap rounded border border-stone-800 bg-stone-900 p-4 text-sm text-stone-100">{answer}</pre>}
      </section>
    </main>
  )
}

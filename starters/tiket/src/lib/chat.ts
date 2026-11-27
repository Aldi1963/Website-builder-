/* Client untuk proxy LLM aplikasi ini (POST /api/chat di server.mjs).
   Key API TIDAK PERNAH lewat sini — key hanya dibaca server dari environment.
   Jawaban mengalir sebagai SSE: data: {"delta":"..."} diakhiri data: [DONE]. */

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

export async function streamChat(
  messages: ChatMessage[],
  opts: { system?: string; signal?: AbortSignal; onDelta: (delta: string) => void },
): Promise<void> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages, system: opts.system }),
    signal: opts.signal,
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(data?.error ?? `Chat gagal (${res.status})`)
  }
  if (!res.body) throw new Error('Tidak ada jawaban dari server.')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const event = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      for (const line of event.split('\n')) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') return
        let parsed: { delta?: string; error?: string }
        try {
          parsed = JSON.parse(payload)
        } catch {
          continue
        }
        if (parsed.error) throw new Error(parsed.error)
        if (typeof parsed.delta === 'string' && parsed.delta) opts.onDelta(parsed.delta)
      }
    }
  }
}

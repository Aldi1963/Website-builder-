import { complete, FAST_MODEL } from './llm.ts'

type Subtask = { label: string; prompt: string }

/** Run bounded read-only research subtasks in parallel with the cheap model.
    Each subtask gets the same base instruction; results are merged into one
    compact tool result. No file writes, no nested agent loops. */
export async function delegateResearch(projectId: string, args: Record<string, unknown>, baseSystem: string): Promise<{ ok: boolean; detail: string }> {
  const items = Array.isArray(args.subtasks) ? (args.subtasks as any[]).slice(0, 3) : []
  if (!items.length) return { ok: false, detail: 'ERROR: subtasks kosong (maks 3).' }
  const jobs = items.map(async (raw) => {
    const label = String(raw.label ?? raw.task ?? 'subtask').slice(0, 100)
    const prompt = String(raw.prompt ?? raw.task ?? '').slice(0, 700)
    try {
      const r = await complete(
        [
          { role: 'system', content: `${baseSystem}\n\nKamu adalah SUBAGEN riset khusus: ${label}. Jangan menulis file, jangan menjalankan tool. Beri analisis ringkas ≤10 baris.` },
          { role: 'user', content: prompt },
        ],
        { model: FAST_MODEL, maxTokens: 700 },
      )
      const text = typeof r.message.content === 'string' ? r.message.content : JSON.stringify(r.message.content)
      return `### ${label}\n${text.slice(0, 2000)}`
    } catch (e) {
      return `### ${label}\nGAGAL: ${(e as Error).message.slice(0, 160)}`
    }
  })
  const results = await Promise.all(jobs)
  return { ok: true, detail: results.join('\n\n').slice(0, 9000) }
}

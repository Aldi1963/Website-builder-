import { complete, STRONG_MODEL, type ChatMessage, type ToolCall } from './llm.ts'
import { appendFileSync } from 'node:fs'
import { AUDIT_SYSTEM, BASE_SYSTEM, PLAN_SYSTEM, QUICK_EDIT_SYSTEM } from './prompts.ts'
import {
  readProjectFile,
  writeProjectFile,
  deleteProjectFile,
  buildProject,
  installDeps,
  ensureWorkspace,
} from './workspace.ts'
import { putFile, removeFile, listFiles, addMessage, listMessages } from './db.ts'
import { snapshotVersion, restoreVersion, listVersions } from './versions.ts'
import { captureScreenshot } from './screenshots.ts'

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'Daftar file di workspace proyek.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Baca isi satu file dari workspace.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Path relatif, contoh src/routes/index.tsx' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Tulis/perbarui file utuh (bukan patch). Selalu kirim isi lengkap file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string', description: 'Isi lengkap file' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Hapus file dari workspace.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'build',
      description: 'Jalankan build produksi (vite build). Gunakan untuk memverifikasi kode.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'audit',
      description: 'Tinjau keamanan, data, UI, dan aksesibilitas seluruh kode proyek setelah implementasi. Hasil dikirim sebagai temuan terstruktur.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'install',
      description: 'Install dependency npm di workspace proyek.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
]

export type AgentEvent =
  | { type: 'status'; text: string }
  | { type: 'plan'; ringkasan: string; langkah: { judul: string; detail: string }[]; berkas: string[]; asumsi: string[] }
  | { type: 'audit'; nilai: number; temuan: { tingkat: string; kategori: string; berkas: string; baris: number; masalah: string; perbaikan: string }[]; catatan: string }
  | { type: 'file'; path: string; action: 'write' | 'delete' }
  | { type: 'build'; ok: boolean; log: string }
  | { type: 'install'; ok: boolean; log: string }
  | { type: 'assistant_delta'; text: string }
  | { type: 'assistant'; text: string }
  | { type: 'screenshot'; url: string; name: string }
  | { type: 'error'; text: string }

const MAX_STEPS = Number(process.env.VB_MAX_STEPS ?? 30)

export async function runAgent(
  projectId: string,
  userPrompt: string,
  emit: (e: AgentEvent) => void | Promise<void>,
  model?: string,
  forcePlanMode?: boolean,
): Promise<void> {
  ensureWorkspace(projectId)
  addMessage(projectId, 'user', userPrompt)
  const versionLabel = userPrompt

  // Snapshot sebelum run — dipakai untuk version history & rollback UI.
  let snapshotId = 0
  try { snapshotId = snapshotVersion(projectId, `sebelum: ${versionLabel}`) } catch { /* snapshot gagal tidak memblokir run */ }

  const history = listMessages(projectId).slice(-24)
  const messages: ChatMessage[] = [
    { role: 'system', content: `${BASE_SYSTEM}\n\nWorkspace saat ini:\n${fileIndex(projectId)}` },
    ...history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
  ]

  let lastBuildFailed = false
  let buildSucceeded = false
  let touchedUi = false
  let screenshotSent = false

  /* Setelah perubahan UI selesai dan build lolos, ambil screenshot preview dan
     simpan sebagai pesan assistant. Kegagalan screenshot dilaporkan apa adanya. */
  const sendScreenshot = async () => {
    if (screenshotSent || !touchedUi || !buildSucceeded) return
    screenshotSent = true
    try {
      await emit({ type: 'status', text: 'Mengambil screenshot preview…' })
      const shot = await captureScreenshot(projectId)
      addMessage(projectId, 'assistant', `![Screenshot preview](${shot.url})`)
      await emit({ type: 'screenshot', url: shot.url, name: shot.name })
    } catch (err) {
      await emit({ type: 'error', text: `Screenshot preview gagal: ${(err as Error).message}` })
    }
  }

  // Klasifikasi cepat: edit kecil vs pekerjaan penuh. Edit kecil = jalur ringkas tanpa plan/audit.
  let quickEdit = false
  if (!forcePlanMode && history.length > 1 && listFiles(projectId).length > 0) {
    try {
      const cls = await complete([
        { role: 'system', content: 'Klasifikasi permintaan. Balas HANYA JSON: {"kecil": true|false}. Kecil=true bila permintaan hanya mengubah satu bagian kecil yang sudah ada (teks, warna, komponen tunggal, perbaikan kecil). Kecil=false bila menambah fitur, mengubah struktur data, atau membuat halaman/flow baru.' },
        { role: 'user', content: userPrompt },
      ], { model, temperature: 0, maxTokens: 100 })
      const raw = typeof cls.message.content === 'string' ? cls.message.content : ''
      const jsonText = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)
      quickEdit = JSON.parse(jsonText).kecil === true
    } catch { /* default: jalur penuh */ }
  }

  if (quickEdit) {
    messages[0] = { role: 'system', content: `${QUICK_EDIT_SYSTEM}\n\nWorkspace saat ini:\n${fileIndex(projectId)}` }
    await emit({ type: 'plan', ringkasan: 'Edit cepat: perubahan kecil langsung diterapkan', langkah: [{ judul: 'Terapkan perubahan', detail: 'Menulis file minimum yang disebut permintaan.' }, { judul: 'Verifikasi build', detail: 'Build produksi untuk memastikan tidak merusak aplikasi.' }], berkas: [], asumsi: [] })
  } else {
  // Generate and stream a concrete plan before the implementation agent acts.
  await emit({ type: 'status', text: 'Menyusun rencana…' })
  try {
    const planResp = await complete([
      { role: 'system', content: PLAN_SYSTEM },
      { role: 'user', content: `Permintaan: ${userPrompt}\n\nBerkas yang ada:\n${fileIndex(projectId)}` },
    ], { model, temperature: 0.15, maxTokens: 1800 })
    const raw = typeof planResp.message.content === 'string' ? planResp.message.content : ''
    const jsonText = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)
    const plan = JSON.parse(jsonText)
    const langkah = Array.isArray(plan.langkah) ? plan.langkah.slice(0, 6) : []
    await emit({ type: 'plan', ringkasan: String(plan.ringkasan ?? 'Membangun perubahan yang diminta'), langkah, berkas: Array.isArray(plan.berkas) ? plan.berkas.slice(0, 10) : [], asumsi: Array.isArray(plan.asumsi) ? plan.asumsi.slice(0, 3) : [] })
    if (langkah.length) messages.push({ role: 'assistant', content: `Rencana kerja: ${langkah.map((x: {judul:string;detail:string}, i:number) => `${i + 1}. ${x.judul}: ${x.detail}`).join('\n')}` })
  } catch {
    await emit({ type: 'plan', ringkasan: 'Membangun dan memverifikasi perubahan yang diminta', langkah: [{judul:'Memahami proyek',detail:'Membaca struktur dan pola kode yang sudah ada.'},{judul:'Menerapkan perubahan',detail:'Menulis komponen dan logika yang diperlukan.'},{judul:'Menguji hasil',detail:'Menjalankan build dan memperbaiki error.'}], berkas: [], asumsi: [] })
  }
  } // end else (full pipeline)

  let auditCompleted = false
  let auditFixRequested = false
  let didWrite = false
  let autoFixRounds = 0
  for (let step = 0; step < MAX_STEPS; step++) {
    await emit({ type: 'status', text: step === 0 ? 'Memeriksa proyek…' : 'Menerapkan rencana…' })

    if (!quickEdit && auditCompleted && didWrite) {
      await emit({ type: 'status', text: 'Menyusun ringkasan akhir…' })
      await new Promise((r) => setImmediate(r))
      const dbg = (m: string) => { try { appendFileSync('/home/hatch/workspace/logs/vb-sse-debug.log', `${new Date().toISOString()} [agent] ${m}\n`) } catch {} }
      dbg(`final summary start project=${projectId} msgs=${messages.length}`)
      const summarize = async () => {
        let streamed = ''
        const finalResp = await complete(
          [...messages, { role: 'user', content: 'Beri ringkasan akhir sekarang tanpa memanggil tool.' }],
          {
            model, temperature: 0.25, maxTokens: 4000,
            onDelta: async (d) => {
              streamed += d
              await emit({ type: 'assistant_delta', text: d })
            },
          },
        )
        const clean = (typeof finalResp.message.content === 'string' ? finalResp.message.content : '').trim()
        dbg(`final summary response project=${projectId} len=${clean.length} streamed=${streamed.length}`)
        if (!clean) throw new Error('ringkasan akhir kosong')
        addMessage(projectId, 'assistant', clean)
        await emit({ type: 'assistant', text: clean })
      }
      try {
        await summarize()
        await sendScreenshot()
        return
      } catch (err) {
        dbg(`final summary first attempt failed project=${projectId}: ${(err as Error).message}`)
        await emit({ type: 'status', text: 'Ringkasan akhir terganggu, mencoba ulang…' })
        await new Promise((r) => setTimeout(r, 1200))
        try {
          await summarize()
          await sendScreenshot()
          return
        } catch (err2) {
          dbg(`final summary retry failed project=${projectId}: ${(err2 as Error).message}`)
          await emit({ type: 'error', text: `Ringkasan akhir gagal: ${(err2 as Error).message}` })
          return
        }
      }
    }

    let resp
    try {
      resp = await complete(messages, { model, tools: TOOLS, temperature: 0.25, maxTokens: 8192 })
    } catch (err) {
      await emit({ type: 'error', text: `LLM gagal: ${(err as Error).message}` })
      return
    }

    const msg = resp.message
    const calls: ToolCall[] = msg.tool_calls ?? []

    if (msg.content && typeof msg.content === 'string' && msg.content.trim() && !calls.length) {
      if (!quickEdit && !auditCompleted && didWrite && !auditFixRequested) {
        auditFixRequested = true
        messages.push({ role: 'assistant', content: msg.content })
        messages.push({ role: 'user', content: 'Panggil tool audit satu kali sekarang untuk meninjau keamanan, data, UI, dan aksesibilitas.' })
        continue
      }
      const clean = msg.content.trim()
      addMessage(projectId, 'assistant', clean)
      await emit({ type: 'assistant', text: clean })
      await sendScreenshot()
      return
    }

    if (!calls.length) {
      await emit({ type: 'error', text: 'Model berhenti tanpa memanggil tool.' })
      return
    }

    messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: calls })

    let stepDidWrite = false

    for (const call of calls) {
      const name = call.function.name
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(call.function.arguments || '{}')
      } catch {
        messages.push({ role: 'tool', tool_call_id: call.id, name, content: 'ERROR: arguments bukan JSON valid' })
        continue
      }

      let result = ''

      if (name === 'list_files') {
        result = listFiles(projectId)
          .map((f) => f.path)
          .join('\n')
      } else if (name === 'read_file') {
        const content = readProjectFile(projectId, String(args.path ?? ''))
        result = content ?? `ERROR: file ${args.path} tidak ditemukan`
      } else if (name === 'write_file') {
        try {
          const path = writeProjectFile(projectId, String(args.path ?? ''), String(args.content ?? ''))
          putFile(projectId, path, String(args.content ?? ''))
          if (/(^|\/)(src|app|pages|components|routes)\//.test(path) && /\.(tsx|jsx|css|html)$/i.test(path)) touchedUi = true
          await emit({ type: 'file', path, action: 'write' })
          stepDidWrite = true
          didWrite = true
          result = `OK: ${path} ditulis (${String(args.content ?? '').length} bytes)`
        } catch (err) {
          result = `ERROR: ${(err as Error).message}`
        }
      } else if (name === 'delete_file') {
        try {
          deleteProjectFile(projectId, String(args.path ?? ''))
          removeFile(projectId, String(args.path ?? ''))
          await emit({ type: 'file', path: String(args.path ?? ''), action: 'delete' })
          stepDidWrite = true
          didWrite = true
          result = 'OK: file dihapus'
        } catch (err) {
          result = `ERROR: ${(err as Error).message}`
        }
      } else if (name === 'audit') {
        if (auditCompleted) {
          result = 'Audit sudah dijalankan untuk putaran ini. Lanjutkan ke ringkasan akhir; jangan panggil audit lagi.'
        } else {
        await emit({ type: 'status', text: 'Meninjau keamanan dan kualitas…' })
        try {
          const files = listFiles(projectId).filter((f) => /\.(tsx?|jsx?|css|json)$/.test(f.path) && !/(lock|\.gen\.)/.test(f.path)).slice(0, 16)
          let auditBytes = 0
          const source = files.map((f) => {
            if (auditBytes >= 48_000) return ''
            const content = readProjectFile(projectId, f.path) ?? ''
            const excerpt = content.slice(0, Math.min(8_000, 48_000 - auditBytes))
            auditBytes += excerpt.length
            return `\n--- BERKAS: ${f.path} (${content.split('\n').length} baris) ---\n${excerpt}`
          }).filter(Boolean).join('\n')
          if (source.length >= 48_000) emit({ type: 'status', text: 'Audit dibatasi ke 48 KB kode terpilih…' })
          auditCompleted = true // juga menandai selesai bila provider gagal diparse; error dikirim sebagai hasil audit di bawah.
          const auditResp = await complete([{ role: 'system', content: AUDIT_SYSTEM }, { role: 'user', content: source || '(belum ada file)' }], { model: process.env.VB_MODEL_AUDIT ?? 'cx/gpt-5.6-luna-review', temperature: 0.1, maxTokens: 3500 })
          const raw = typeof auditResp.message.content === 'string' ? auditResp.message.content : ''
          const jsonText = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)
          const report = JSON.parse(jsonText)
          const needsFix = lastBuildFailed
          const paths = new Set(files.map((f) => f.path))
          const modelFindings = (Array.isArray(report.temuan) ? report.temuan : []).filter((x: any) =>
            x && ['kritis', 'penting', 'ringan'].includes(x.tingkat) &&
            ['keamanan', 'data', 'ui', 'aksesibilitas', 'kode'].includes(x.kategori) &&
            typeof x.berkas === 'string' && paths.has(x.berkas) &&
            typeof x.masalah === 'string' && typeof x.perbaikan === 'string',
          ).map((x: any) => ({
            tingkat: x.tingkat, kategori: x.kategori, berkas: x.berkas,
            baris: Math.max(1, Math.min((readProjectFile(projectId, x.berkas) ?? '').split('\\n').length || 1, Number(x.baris) || 1)),
            masalah: x.masalah.slice(0, 500), perbaikan: x.perbaikan.slice(0, 500),
          })).slice(0, 12)
          const deterministic = scanRiskPatterns(files.map((f) => ({ path: f.path, content: readProjectFile(projectId, f.path) ?? '' })))
          const seen = new Set(modelFindings.map((x: any) => `${x.berkas}:${x.kategori}:${x.masalah}`))
          const temuan = [...modelFindings, ...deterministic.filter((x) => !seen.has(`${x.berkas}:${x.kategori}:${x.masalah}`))].slice(0, 16)
          await emit({ type: 'audit', nilai: Math.max(0, Math.min(100, Number(report.nilai ?? 0))), temuan, catatan: String(report.catatan ?? '') })
          result = JSON.stringify({nilai:report.nilai,temuan,catatan:report.catatan, instruksi: needsFix ? 'Perbaiki hanya temuan kritis/penting yang nyata, build ulang, lalu langsung beri ringkasan akhir tanpa memanggil audit lagi.' : 'Tidak ada temuan kritis/penting. Langsung beri ringkasan akhir tanpa memanggil audit lagi.'})
        } catch (err) {
          const note = `Audit gagal dijalankan atau diparse: ${(err as Error).message}`
          await emit({ type: 'audit', nilai: 0, temuan: [], catatan: note })
          auditCompleted = true
          result = note
        }
        }
      } else if (name === 'install') {
        await emit({ type: 'status', text: 'Install dependency…' })
        const r = await installDeps(projectId)
        await emit({ type: 'install', ok: r.code === 0, log: r.output.slice(-4000) })
        result = `exit=${r.code}\n${r.output.slice(-2500)}`
      } else if (name === 'build') {
        await emit({ type: 'status', text: 'Build…' })
        const r = await buildProject(projectId)
        lastBuildFailed = r.code !== 0
        buildSucceeded = r.code === 0
        await emit({ type: 'build', ok: r.code === 0, log: r.output.slice(-4000) })
        result = `exit=${r.code}\n${r.output.slice(-6000)}${r.code === 0 ? '' : '\nPERBAIKI ERROR DI ATAS.'}`
      } else {
        result = `ERROR: tool ${name} tidak dikenal`
      }

      messages.push({ role: 'tool', tool_call_id: call.id, name, content: result.slice(0, 12_000) })
    }

    // Auto-fix build: setelah giliran menulis file, bila build terakhir gagal, suruh agent memperbaiki sendiri.
    if (stepDidWrite && lastBuildFailed && autoFixRounds < 4) {
      autoFixRounds++
      messages.push({ role: 'user', content: 'Build terakhir GAGAL. Perbaiki error build sekarang: baca file terkait bila perlu, tulis perbaikan lewat write_file, lalu panggil build lagi. Jangan menambah fitur baru.' })
    }

    if (!quickEdit && didWrite && !auditCompleted && step === 0) {
      messages.push({ role: 'user', content: 'Sebelum ringkasan akhir, panggil tool audit satu kali.' })
    }
  }

  // Snapshot setelah run selesai (versi hasil) + catat versi untuk UI history.
  try { snapshotVersion(projectId, `sesudah: ${versionLabel}`) } catch { /* abaikan */ }

  await emit({ type: 'error', text: `Batas ${MAX_STEPS} langkah tercapai.` })
}

type RiskFinding = { tingkat: string; kategori: string; berkas: string; baris: number; masalah: string; perbaikan: string }

/** Fast, deterministic checks complement the model review; these are signals, not a full SAST. */
function scanRiskPatterns(files: { path: string; content: string }[]): RiskFinding[] {
  const findings: RiskFinding[] = []
  const rules: { re: RegExp; severity: string; category: string; issue: string; fix: string }[] = [
    { re: /dangerouslySetInnerHTML\s*=|\binnerHTML\s*=/, severity: 'penting', category: 'keamanan', issue: 'HTML mentah dimasukkan ke DOM; input tak tepercaya dapat membuka XSS.', fix: 'Hindari HTML mentah atau sanitasi dengan allowlist yang teruji.' },
    { re: /\beval\s*\(|new\s+Function\s*\(/, severity: 'kritis', category: 'keamanan', issue: 'Eksekusi kode dinamis dapat menjalankan input sebagai kode.', fix: 'Hapus evaluasi dinamis dan gunakan parser/operasi terstruktur.' },
    { re: /(?:api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"\n]{12,}['"]/i, severity: 'kritis', category: 'keamanan', issue: 'Nilai mirip kredensial tertulis langsung di source.', fix: 'Pindahkan secret ke environment server dan rotasi nilai yang terekspos.' },
    { re: /\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^;`]*\$\{[^}]+\}/i, severity: 'penting', category: 'keamanan', issue: 'Query SQL tampak menyisipkan interpolasi string yang dapat membuka SQL injection.', fix: 'Gunakan parameter binding/prepared statement untuk semua nilai.' },
  ]
  for (const file of files) {
    const lines = file.content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      for (const rule of rules) {
        if (!rule.re.test(lines[i])) continue
        findings.push({ tingkat: rule.severity, kategori: rule.category, berkas: file.path, baris: i + 1, masalah: rule.issue, perbaikan: rule.fix })
        break
      }
      if (findings.length >= 16) return findings
    }
  }
  return findings
}

function fileIndex(projectId: string) {
  const files = listFiles(projectId)
  if (!files.length) return '(kosong, selain template dasar: src/routes/__root.tsx, src/routes/index.tsx, src/styles.css)'
  return files.map((f) => `- ${f.path}`).join('\n')
}


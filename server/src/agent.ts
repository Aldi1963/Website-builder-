import { complete, STRONG_MODEL, effectiveAuditModel, type ChatMessage, type ToolCall } from './llm.ts'
import { appendFileSync } from 'node:fs'
import { AUDIT_SYSTEM, BASE_SYSTEM, PLAN_SYSTEM, QUICK_EDIT_SYSTEM } from './prompts.ts'
import {
  readProjectFile,
  writeProjectFile,
  newDirsForFile,
  deleteProjectFile,
  buildProject,
  installDeps,
  ensureWorkspace,
} from './workspace.ts'
import { putFile, removeFile, listFiles, addMessage, listMessages } from './db.ts'
import { savePendingPlan, clearPendingPlan } from './pending-plan.ts'
import { snapshotVersion, restoreVersion, listVersions } from './versions.ts'
import { captureScreenshot, captureForReview } from './screenshots.ts'
import { isManagedDbEnabled, execProjectSql } from './managed-db.ts'

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
      name: 'check_preview',
      description: 'Ambil screenshot preview aplikasi + error runtime (console/pageerror) agar kamu bisa MELIHAT hasil render nyata dan memperbaiki masalah visual/fungsional. Panggil setelah build sukses bila ada perubahan UI. Kamu akan menerima gambar sebagai pesan berikutnya.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'db_schema',
      description: 'Buat atau ubah tabel di database proyek (Postgres terkelola, permanen). Satu pernyataan per panggilan; hanya CREATE TABLE (pakai IF NOT EXISTS), CREATE [UNIQUE] INDEX, ALTER TABLE, COMMENT ON. DROP/TRUNCATE/GRANT/ekstensi/administratif ditolak.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { sql: { type: 'string', description: 'Satu pernyataan SQL DDL. Contoh: CREATE TABLE IF NOT EXISTS notes (id serial primary key, user_email text not null, title text not null, body text, created_at timestamptz default now())' } },
        required: ['sql'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'db_query',
      description: 'Jalankan satu pernyataan SELECT/INSERT/UPDATE/DELETE/WITH di database proyek untuk memverifikasi skema atau seed data. DDL dan operasi administratif ditolak.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { sql: { type: 'string', description: 'Satu pernyataan SQL.' } },
        required: ['sql'],
      },
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
  | { type: 'file'; path: string; action: 'write' | 'delete' | 'mkdir' }
  | { type: 'build'; ok: boolean; log: string }
  | { type: 'install'; ok: boolean; log: string }
  | { type: 'assistant_delta'; text: string }
  | { type: 'assistant'; text: string }
  | { type: 'screenshot'; url: string; name: string }
  | { type: 'awaiting_confirmation'; ringkasan: string }
  | { type: 'done' }
  | { type: 'error'; text: string }

const MAX_STEPS = Number(process.env.VB_MAX_STEPS ?? 30)

export async function runAgent(
  projectId: string,
  userPrompt: string,
  emit: (e: AgentEvent) => void | Promise<void>,
  model?: string,
  forcePlanMode?: boolean,
  opts?: { userId?: string; confirmed?: boolean; confirmPlan?: boolean },
): Promise<void> {
  ensureWorkspace(projectId)
  // Run baru menggantikan rencana lama yang belum disetujui (atau menghabiskan
  // rencana yang sedang dikonfirmasi) — jangan biarkan kartu basi tertinggal.
  clearPendingPlan(projectId)
  // Saat user menyetujui rencana, run ini adalah lanjutan (confirmed=true):
  // prompt asli sudah tercatat, jangan catat dua kali sebagai pesan user.
  if (!opts?.confirmed) addMessage(projectId, 'user', userPrompt)
  const versionLabel = userPrompt

  // Snapshot sebelum run — dipakai untuk version history & rollback UI.
  let snapshotId = 0
  try { snapshotId = snapshotVersion(projectId, `sebelum: ${versionLabel}`) } catch { /* snapshot gagal tidak memblokir run */ }

  const history = listMessages(projectId).slice(-24)
  const messages: ChatMessage[] = [
    { role: 'system', content: `${BASE_SYSTEM}\n\nWorkspace saat ini:\n${fileIndex(projectId)}` },
    ...history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
  ]

  /* Deteksi sapaan/pertanyaan ringan TANPA LLM (instan & hemat token): pesan
     pendek yang cuma menyapa / basa-basi dijawab sebagai chat biasa — tidak
     membangun apa pun. Penting untuk proyek baru yang masih kosong, karena
     klasifikasi kecil/konsultasi/penuh di bawah hanya aktif saat proyek sudah
     punya file. */
  const trimmedPrompt = userPrompt.trim()
  const buildVerb = /\b(buat|buatkan|bikin|bikinkan|bangun|buatlah|tambah|tambahkan|ubah|ganti|perbaiki|hapus|implementasi|integrasi|desain|kembangkan|tulis|coding|program)\b/i
  const greetWord = /^(halo+|hai+|hei+|hello+|hi+|hey+|pagi|siang|sore|malam|assalam|permisi|tes+|test+)\b/i
  const isGreeting =
    trimmedPrompt.length <= 40 &&
    greetWord.test(trimmedPrompt) &&
    !buildVerb.test(trimmedPrompt)
  if (isGreeting) {
    await emit({ type: 'status', text: 'Menyusun jawaban…' })
    let streamed = ''
    await complete(
      [...messages, { role: 'user', content: `${userPrompt}\n\nIni hanya sapaan/pertanyaan ringan. Balas singkat dan ramah (1-3 kalimat) dalam bahasa user, TANPA menulis/mengubah file, TANPA tool, TANPA rencana. Tawarkan bantuan dan tanyakan aplikasi apa yang ingin dibangun. Jangan pakai jargon teknis internal.` }],
      {
        model, temperature: 0.5, maxTokens: 300, userId: opts?.userId,
        onDelta: async (d) => { streamed += d; await emit({ type: 'assistant_delta', text: d }) },
      },
    )
    const answer = streamed.trim()
    if (answer) addMessage(projectId, 'assistant', answer)
    return
  }

  let lastBuildFailed = false
  let buildSucceeded = false
  let touchedUi = false
  let screenshotSent = false
  /* Self-healing visual: batasi berapa kali agent mengulang siklus
     "lihat preview → perbaiki → build" agar tidak meledak biaya/waktu. */
  const MAX_PREVIEW_ROUNDS = Number(process.env.VB_MAX_PREVIEW_ROUNDS ?? 2)
  let previewRounds = 0
  let pendingPreviewImage: string | null = null
  let pendingPreviewErrors: string[] = []

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
  // Saat confirmed=true, user sudah menyetujui rencana — lewati klasifikasi & regenerasi
  // plan, langsung eksekusi. History sudah memuat "Rencana kerja" dari run sebelumnya.
  let quickEdit = false
  let consult = false
  if (!opts?.confirmed && !forcePlanMode && history.length > 1 && listFiles(projectId).length > 0) {
    try {
      // Tiga jalur: kecil (edit cepat) / konsultasi (pertanyaan analitik, tak menulis kode) /
      // pekerjaan penuh (buat fitur/struktur/halaman baru). Tanpa jalur konsultasi, pertanyaan
      // seperti "apa kekurangan web ini" jatuh ke pekerjaan penuh lalu memicu rencana + audit.
      const cls = await complete([
        { role: 'system', content: 'Klasifikasi permintaan. Balas HANYA JSON: {"jenis": "kecil"|"konsultasi"|"penuh"}. "kecil" bila permintaan hanya mengubah satu bagian kecil yang sudah ada (teks, warna, komponen tunggal, perbaikan kecil). "konsultasi" bila user bertanya/meminta saran/opini/penjelasan/analisis tentang proyek (contoh: "apa kekurangan web ini", "saran fitur", "kenapa error X", "bagaimana cara kerja") dan TIDAK meminta kode ditulis. "penuh" bila menambah fitur, mengubah struktur data, atau membuat halaman/flow baru. Default "penuh" bila ragu.' },
        { role: 'user', content: userPrompt },
      ], { model, temperature: 0, maxTokens: 100, userId: opts?.userId })
      const raw = typeof cls.message.content === 'string' ? cls.message.content : ''
      const jsonText = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)
      const jenis = JSON.parse(jsonText).jenis
      quickEdit = jenis === 'kecil'
      consult = jenis === 'konsultasi'
    } catch { /* default: jalur penuh */ }
  }

  // Jalur konsultasi: pertanyaan analitik dijawab langsung sebagai chat — tanpa rencana,
  // tanpa menulis file, tanpa audit. User cuma minta saran/penjelasan, bukan implementasi.
  if (consult) {
    await emit({ type: 'status', text: 'Menyusun jawaban…' })
    let streamed = ''
    let answer = ''
    await complete(
      [...messages, { role: 'user', content: `${userPrompt}\n\nPENTING: Ini pertanyaan/permintaan saran. Jawab HANYA dalam bentuk penjelasan/saran di chat. JANGAN menulis file, JANGAN menjalankan build/audit, JANGAN membuat rencana kerja. Baca kode proyek bila relevan lalu beri jawaban langsung.` }],
      {
        model, temperature: 0.3, maxTokens: 2500, userId: opts?.userId,
        onDelta: async (d) => { streamed += d; await emit({ type: 'assistant_delta', text: d }) },
      },
    )
    answer = streamed.trim()
    if (answer) addMessage(projectId, 'assistant', answer)
    return
  }

  // Saat confirmed, user sudah menyetujui rencana pada run sebelumnya — jangan
  // regenerate plan (nanti membingungkan karena bisa berubah). Langsung eksekusi.
  if (quickEdit || opts?.confirmed) {
    if (!opts?.confirmed) {
      messages[0] = { role: 'system', content: `${QUICK_EDIT_SYSTEM}\n\nWorkspace saat ini:\n${fileIndex(projectId)}` }
      await emit({ type: 'plan', ringkasan: 'Edit cepat: perubahan kecil langsung diterapkan', langkah: [{ judul: 'Terapkan perubahan', detail: 'Menulis file minimum yang disebut permintaan.' }, { judul: 'Verifikasi build', detail: 'Build produksi untuk memastikan tidak merusak aplikasi.' }], berkas: [], asumsi: [] })
    }
  } else {
  // Susun rencana konkret sebelum agent implementasi menulis file. JSON-nya
  // di-buffer; yang tampil ke user hanya kartu rencana + satu kalimat ringkas.
  await emit({ type: 'status', text: 'Menyusun rencana…' })
  let planText = ''
  let plan: any = null
  try {
    const planResp = await complete([
      { role: 'system', content: PLAN_SYSTEM },
      { role: 'user', content: `Permintaan: ${userPrompt}\n\nBerkas yang ada:\n${fileIndex(projectId)}` },
    ], {
      model, temperature: 0.15, maxTokens: 1800, userId: opts?.userId,
      // JSON rencana di-buffer, BUKAN di-stream ke chat: user tidak boleh melihat
      // kurung kurawal/kunci mentah. Narasi manusiawi dipancarkan setelah parse.
      onDelta: async (d) => { planText += d },
    })
    const raw = typeof planResp.message.content === 'string' ? planResp.message.content : planText
    const jsonText = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)
    plan = JSON.parse(jsonText)
  } catch {
    /* narasi/parse gagal → fallback plan bawaan di bawah */
  }
  const langkah = Array.isArray(plan?.langkah) && plan.langkah.length ? plan.langkah.slice(0, 6) : [
    { judul: 'Memahami proyek', detail: 'Membaca struktur dan pola kode yang sudah ada.' },
    { judul: 'Menerapkan perubahan', detail: 'Menulis komponen dan logika yang diperlukan.' },
    { judul: 'Menguji hasil', detail: 'Menjalankan build dan memperbaiki error.' },
  ]
  const ringkasan = String(plan?.ringkasan ?? 'Membangun perubahan yang diminta')
  const berkas = Array.isArray(plan?.berkas) ? plan.berkas.slice(0, 10) : []
  const asumsi = Array.isArray(plan?.asumsi) ? plan.asumsi.slice(0, 3) : []
  await emit({ type: 'plan', ringkasan, langkah, berkas, asumsi })
  // Narasi manusiawi singkat di chat — tanpa JSON/kunci mentah.
  await emit({ type: 'assistant', text: ringkasan })
  if (langkah.length) messages.push({ role: 'assistant', content: `Rencana kerja: ${langkah.map((x: {judul:string;detail:string}, i:number) => `${i + 1}. ${x.judul}: ${x.detail}`).join('\n')}` })

  // Gerbang konfirmasi: hanya aktif bila client memintanya (confirmPlan=true).
  // Rencana ditampilkan lalu eksekusi berhenti; user menyetujui lewat tombol di
  // chat, yang mengirim ulang prompt yang sama dengan confirmed=true.
  if (opts?.confirmPlan && !opts?.confirmed) {
    // Simpan rencana ke DB supaya tidak hilang bila user keluar sebelum
    // menyetujui; simpan juga ringkasannya sebagai pesan asisten supaya
    // thread tidak kosong saat user kembali.
    savePendingPlan(projectId, userPrompt, { ringkasan, langkah, berkas, asumsi })
    const planText = langkah.length
      ? `${ringkasan}\n\nRencana kerja:\n${langkah.map((x: { judul: string; detail: string }, i: number) => `${i + 1}. ${x.judul}: ${x.detail}`).join('\n')}`
      : ringkasan
    addMessage(projectId, 'assistant', planText)
    await emit({ type: 'awaiting_confirmation', ringkasan })
    return
  }
  } // end else (full pipeline)

  let auditCompleted = false
  let auditFixRequested = false
  let didWrite = false
  let autoFixRounds = 0
  for (let step = 0; step < MAX_STEPS; step++) {
    await emit({ type: 'status', text: step === 0 ? 'Memeriksa proyek…' : 'Menerapkan rencana…' })

    if (!quickEdit && auditCompleted && didWrite && (!touchedUi || previewRounds >= 1)) {
      await emit({ type: 'status', text: 'Menyusun ringkasan akhir…' })
      await new Promise((r) => setImmediate(r))
      const dbg = (m: string) => { try { appendFileSync('/home/hatch/workspace/logs/vb-sse-debug.log', `${new Date().toISOString()} [agent] ${m}\n`) } catch {} }
      dbg(`final summary start project=${projectId} msgs=${messages.length}`)
      const summarize = async () => {
        let streamed = ''
        const finalResp = await complete(
          [...messages, { role: 'user', content: 'Beri ringkasan akhir sekarang tanpa memanggil tool.' }],
          {
            model, temperature: 0.25, maxTokens: 4000, userId: opts?.userId,
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

    /* Self-healing: bila putaran sebelumnya memanggil check_preview, suntikkan
       gambar hasil render + error runtime sebagai pesan user multimodal supaya
       model bisa MELIHAT aplikasinya sendiri lalu memutuskan memperbaiki atau tidak. */
    if (pendingPreviewImage) {
      const errList = pendingPreviewErrors.length ? pendingPreviewErrors.join('\n') : '(tidak ada)'
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: `Ini screenshot preview aplikasimu saat ini. Error runtime:\n${errList}\n\nBila ada masalah visual nyata (layout rusak, konten kosong/placeholder, elemen tumpang tindih, error tercantum), perbaiki lewat write_file lalu panggil build, lalu check_preview lagi. Bila tampilan sudah baik, JANGAN menulis file apa pun dan langsung beri ringkasan akhir.` },
          { type: 'image_url', image_url: { url: pendingPreviewImage } },
        ],
      })
      pendingPreviewImage = null
      pendingPreviewErrors = []
    }

    let resp
    try {
      resp = await complete(messages, { model, tools: TOOLS, temperature: 0.25, maxTokens: 8192, userId: opts?.userId })
    } catch (err) {
      /* Bila panggilan dengan gambar ditolak upstream (model tanpa vision /
         payload terlalu besar), ulangi SEKALI tanpa gambar supaya run yang
         sudah dibayar user tidak ikut gagal. Review visual hanya bonus. */
      const hadImage = messages.length > 0 && Array.isArray(messages[messages.length - 1]?.content)
      if (hadImage) {
        messages.pop()
        pendingPreviewImage = null
        pendingPreviewErrors = []
        await emit({ type: 'status', text: 'Model tidak mendukung gambar, lanjut tanpa review visual…' })
        try {
          resp = await complete(messages, { model, tools: TOOLS, temperature: 0.25, maxTokens: 8192, userId: opts?.userId })
        } catch (err2) {
          await emit({ type: 'error', text: `LLM gagal: ${(err2 as Error).message}` })
          return
        }
      } else {
        await emit({ type: 'error', text: `LLM gagal: ${(err as Error).message}` })
        return
      }
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
      /* Guard visual: model boleh saja menjawab pakai teks, tetapi kalau
         perubahan UI/build sukses/audit selesai dan preview belum pernah
         dicek, jawaban itu belum sah sebagai ringkasan akhir. Paksa satu
         putaran lagi supaya tool check_preview benar-benar dipanggil dan
         gambar runtime masuk ke konteks model. */
      if (!quickEdit && touchedUi && buildSucceeded && auditCompleted && previewRounds < 1 && !pendingPreviewImage) {
        messages.push({ role: 'assistant', content: msg.content })
        messages.push({ role: 'user', content: 'Jangan selesaikan run sebelum check_preview. Panggil tool check_preview SEKALI sekarang untuk melihat render nyata, lalu beri ringkasan akhir setelah hasilnya.' })
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
        await emit({ type: 'status', text: 'Melihat daftar file…' })
        result = listFiles(projectId)
          .map((f) => f.path)
          .join('\n')
      } else if (name === 'read_file') {
        await emit({ type: 'status', text: `Membaca ${String(args.path ?? '')}…` })
        const content = readProjectFile(projectId, String(args.path ?? ''))
        result = content ?? `ERROR: file ${args.path} tidak ditemukan`
      } else if (name === 'write_file') {
        try {
          const path = String(args.path ?? '')
          const newDirs = newDirsForFile(projectId, path)
          const written = writeProjectFile(projectId, path, String(args.content ?? ''))
          putFile(projectId, written, String(args.content ?? ''))
          if (/(^|\/)(src|app|pages|components|routes)\//.test(written) && /\.(tsx|jsx|css|html)$/i.test(written)) touchedUi = true
          for (const d of newDirs) await emit({ type: 'file', path: d, action: 'mkdir' })
          await emit({ type: 'file', path: written, action: 'write' })
          stepDidWrite = true
          didWrite = true
          result = `OK: ${written} ditulis (${String(args.content ?? '').length} bytes)`
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
          const auditResp = await complete([{ role: 'system', content: AUDIT_SYSTEM }, { role: 'user', content: source || '(belum ada file)' }], { model: effectiveAuditModel(), temperature: 0.1, maxTokens: 3500, userId: opts?.userId })
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
      } else if (name === 'check_preview') {
        /* Self-healing visual: render preview nyata, kirim gambar + error runtime
           ke agent supaya bisa MELIHAT dan memperbaiki. Berbatas ronde agar hemat. */
        if (previewRounds >= MAX_PREVIEW_ROUNDS) {
          result = `Batas ${MAX_PREVIEW_ROUNDS} putaran check_preview tercapai. Lanjutkan ke ringkasan akhir.`
        } else {
          previewRounds++
          await emit({ type: 'status', text: 'Melihat preview aplikasi…' })
          try {
            const cap = await captureForReview(projectId)
            pendingPreviewImage = cap.image
            pendingPreviewErrors = cap.runtimeErrors
            // Gambar dilewatkan lewat message user multimodal di giliran berikut,
            // bukan lewat content tool (tool tak mendukung gambar).
            const errNote = cap.runtimeErrors.length
              ? `\n\nError runtime terdeteksi (${cap.runtimeErrors.length}):\n${cap.runtimeErrors.join('\n')}`
              : '\n\nTidak ada error console/pageerror.'
            result = `Screenshot preview diambil. Gambar dikirim pada pesan berikutnya.${errNote}\n\nPeriksa gambar: bila ada kerusakan visual, layout rusak, konten kosong, atau error di atas, perbaiki lewat write_file lalu build lagi. Bila tampilan sudah baik, langsung beri ringkasan akhir.`
            stepDidWrite = false // melihat preview bukan menulis; jangan picu auto-fix build
          } catch (err) {
            result = `Preview gagal diambil: ${(err as Error).message}. Lewati review visual.`
            pendingPreviewImage = null
          }
        }
      } else if (name === 'db_schema' || name === 'db_query') {
        await emit({ type: 'status', text: name === 'db_schema' ? 'Menyiapkan tabel database…' : 'Menjalankan query database…' })
        if (!isManagedDbEnabled()) {
          result = 'ERROR: Database terkelola belum aktif di server.'
        } else {
          const r = await execProjectSql(projectId, String(args.sql ?? ''), name === 'db_schema' ? 'schema' : 'query')
          stepDidWrite = true
          didWrite = true
          result = r.ok ? `OK: ${JSON.stringify(r.result)}` : `ERROR: ${r.error}`
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

    // Self-healing visual: setelah build SUKSES pada perubahan UI dan audit selesai,
    // minta agent melihat preview sekali sebelum ringkasan akhir (nudge tunggal per
    // build sukses — tidak berulang, agar tidak boros biaya/waktu).
    if (!quickEdit && stepDidWrite && buildSucceeded && touchedUi && auditCompleted && previewRounds < 1 && !pendingPreviewImage && !lastBuildFailed) {
      messages.push({ role: 'user', content: 'Build sudah sukses dan ada perubahan tampilan. Panggil tool check_preview SEKALI sekarang untuk melihat hasil render nyata dan error runtime, lalu perbaiki bila ada kerusakan visual atau langsung beri ringkasan akhir bila sudah baik.' })
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


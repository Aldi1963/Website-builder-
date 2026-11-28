import { TOOLS } from './agent-tools.ts'
import { complete, STRONG_MODEL, effectiveAuditModel, type ChatMessage, type ContentPart, type ToolCall } from './llm.ts'
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
import { putFile, removeFile, listFiles, addMessage, listMessages, setSetting as setSettingFromAgent } from './db.ts'
import { savePendingPlan, clearPendingPlan, type PendingPlanData } from './pending-plan.ts'
import { savePendingAnswer, clearPendingAnswer } from './pending-answer.ts'
import { readReferenceImage } from './reference-images.ts'
import { snapshotVersion, restoreVersion, listVersions } from './versions.ts'
import { captureScreenshot, captureForReview } from './screenshots.ts'
import { interactPreview, closePreviewSession } from './preview-interact.ts'
import { runProjectCommand } from './run-command.ts'
import { routePathFromFile } from './route-paths.ts'
import { isManagedDbEnabled, execProjectSql, projectSchemaBrief } from './managed-db.ts'

export type AgentEvent =
  | { type: 'status'; text: string }
  | { type: 'context'; paths: string[] }
  | { type: 'plan'; ringkasan: string; langkah: { judul: string; detail: string }[]; berkas: string[]; asumsi: string[] }
  | { type: 'audit'; nilai: number; temuan: { tingkat: string; kategori: string; berkas: string; baris: number; masalah: string; perbaikan: string }[]; catatan: string }
  | { type: 'file'; path: string; action: 'write' | 'delete' | 'mkdir' }
  | { type: 'build'; ok: boolean; log: string }
  | { type: 'install'; ok: boolean; log: string }
  | { type: 'terminal'; command: string; ok: boolean; log: string }
  | { type: 'assistant_delta'; text: string }
  | { type: 'assistant'; text: string }
  | { type: 'screenshot'; url: string; name: string }
  | { type: 'awaiting_confirmation'; ringkasan: string }
  | { type: 'awaiting_answer'; question: string; hint: string | null }
  | { type: 'done' }
  | { type: 'error'; text: string }

const MAX_STEPS = Number(process.env.VB_MAX_STEPS ?? 30)

export async function runAgent(
  projectId: string,
  userPrompt: string,
  emit: (e: AgentEvent) => void | Promise<void>,
  model?: string,
  forcePlanMode?: boolean,
  opts?: { userId?: string; confirmed?: boolean; confirmPlan?: boolean; imageIds?: string[]; answer?: string },
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
  /* Skema database nyata disuntikkan ke system prompt. Tanpa ini model menebak
     nama tabel/kolom saat user minta perubahan data, lalu build sukses tapi
     query runtime gagal. Ringkas & best-effort: kegagalan baca skema tidak
     memblokir run. */
  let schemaBrief = ''
  try { schemaBrief = (await projectSchemaBrief(projectId)) ?? '' } catch { /* abaikan */ }
  const dbContext = schemaBrief ? `\n\nSkema database proyek saat ini (pakai nama ini, jangan menebak):\n${schemaBrief}` : ''
  /* DESIGN.md adalah kontrak visual proyek. Disuntikkan setiap run supaya
     keputusan desain tidak hilang antar percakapan. Proyek lama yang belum
     punya file memakai default dari template — agent akan menuliskannya
     saat diminta mengubah desain. */
  const designBrief = (readProjectFile(projectId, 'DESIGN.md') ?? '').trim().slice(0, 4000)
  const designContext = designBrief
    ? `\n\nKONTRAK DESAIN PROYEK (DESIGN.md — ikuti, jangan bertentangan):\n${designBrief}`
    : `\n\nKONTRAK DESAIN PROYEK: proyek ini belum punya DESIGN.md. Ikuti DESIGN_FILTER pada instruksi utama; bila user meminta perubahan desain, tulis DESIGN.md berisi keputusan visual yang dipakai.`
  const ctx = contextBrief(projectId, userPrompt)
  const filePathsRead: string[] = [...ctx.paths]
  await emit({ type: 'context', paths: filePathsRead })
  const messages: ChatMessage[] = [
    { role: 'system', content: `${BASE_SYSTEM}${designContext}${ctx.text}\n\nWorkspace saat ini:\n${fileIndex(projectId)}${dbContext}` },
    ...history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
  ]
  if (opts?.answer) {
    // Lanjutan setelah user menjawab pertanyaan agent: jawaban menjadi pesan
    // user agar model melanjutkan kerja dengan konteks yang sama.
    messages.push({ role: 'user', content: `Jawaban user untuk pertanyaanmu: ${opts.answer}\n\nWAJIB: pakai jawaban ini SENDIRI untuk menyelesaikan pekerjaan. Bila jawaban berisi email/password, daftarkan atau promosikan akun itu lewat server function (registerUser(..., 'admin') / helper sejenis) lalu verifikasi — JANGAN menyuruh user daftar manual, JANGAN menunda dengan "setelah pendaftaran beri tahu saya", dan JANGAN menanyakan kredensial yang sama dua kali. Bila kredensial untuk layanan eksternal, simpan lewat set_secret. Lanjutkan dari titik berhenti, lalu verifikasi dengan build + check_preview.` })
  }

  /* Referensi gambar dari user: dimuat dari .references, dikirim sekali di awal
     sebagai pesan user multimodal. Bersifat referensi visual, bukan screenshot
     hasil render — jangan tertukar dengan loop check_preview. */
  const imageIds = Array.from(new Set(opts?.imageIds ?? [])).slice(0, 3)
  const referenceParts: ContentPart[] = []
  for (const id of imageIds) {
    try {
      const img = await readReferenceImage(projectId, id)
      if (!img) continue
      await emit({ type: 'status', text: `Melihat referensi gambar: ${img.name}…` })
      referenceParts.push({ type: 'image_url', image_url: { url: img.dataUrl } })
    } catch { /* referensi rusak tidak memblokir run */ }
  }
  if (referenceParts.length) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: `${userPrompt}\n\nGAMBAR REFERENSI DESAIN dari user (${referenceParts.length} gambar). Amati warna, tipografi, spacing, grid, komponen, dan hierarchy visualnya. Pakai sebagai acuan nyata: selaraskan DESIGN.md dan token di src/styles.css dengan pola yang terlihat, lalu terapkan ke komponen. Jangan menyalin teks/brand pihak ketiga atau aset berhak cipta — ambil hanya pola visualnya. Jangan mengklaim sudah mengikuti gambar bila tidak menyentuh file.` },
        ...referenceParts,
      ],
    })
  }

  /* Deteksi sapaan/pertanyaan ringan TANPA LLM (instan & hemat token): pesan
     pendek yang cuma menyapa / basa-basi dijawab sebagai chat biasa — tidak
     membangun apa pun. Penting untuk proyek baru yang masih kosong, karena
     klasifikasi kecil/konsultasi/penuh di bawah hanya aktif saat proyek sudah
     punya file. */
  const trimmedPrompt = userPrompt.trim()
  const buildVerb = /\b(buat|buatkan|bikin|bikinkan|bangun|buatlah|tambah|tambahkan|ubah|ganti|perbaiki|hapus|implementasi|integrasi|desain|kembangkan|tulis|coding|program)\b/i
  /* "tes"/"test" sering jadi pembuka pertanyaan proyek, bukan sapaan. */
  const greetWord = /^(halo+|hai+|hei+|hello+|hi+|hey+|pagi|siang|sore|malam|assalam|permisi)[!.?\s]*$/i
  const isMurniKata = (s: string) => /^[\w!.\s]+$/u.test(s) && s.split(/\s+/).length <= 2
  const punyaFile = listFiles(projectId).length > 0
  const isMurniSapaan =
    isMurniKata(trimmedPrompt) &&
    (greetWord.test(trimmedPrompt) || /^(halo|hai|hi|tes|test|coba)\b/i.test(trimmedPrompt))
  const isPertanyaan = /\?/.test(trimmedPrompt) || /^(apa|apakah|bagaimana|kenapa|mengapa|bisakah|bisa|boleh|sudah|gimana)\b/i.test(trimmedPrompt)
  const isGreeting =
    !punyaFile &&
    trimmedPrompt.length <= 40 &&
    isMurniSapaan &&
    !buildVerb.test(trimmedPrompt) &&
    !isPertanyaan
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
  const MAX_PREVIEW_ROUNDS = Number(process.env.VB_MAX_PREVIEW_ROUNDS ?? 4)
  let previewRounds = 0
  /* File rute yang ditulis pada run ini — dipakai probe untuk mendeteksi
     halaman yatim (dibuat tapi tak bisa dicapai dari UI). */
  const newRouteFiles: string[] = []
  let pendingPreviewImage: string | null = null
  let pendingPreviewErrors: string[] = []
let pendingPreviewDefects: string[] = []
  let lastDefectCount = 0
  /* Bukti terbaru: true hanya bila check_preview terakhir kembali BERSIH.
     Dipakai supaya klaim model ("sudah diperbaiki") tidak diterima sebelum
     render ulang benar-benar membuktikan cacat hilang. */
  let defectsVerifiedClean = false

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
        { role: 'system', content: 'Klasifikasi permintaan. Balas HANYA JSON: {"jenis": "kecil"|"konsultasi"|"penuh"}. "kecil" bila permintaan hanya mengubah satu bagian kecil yang sudah ada (teks, warna, komponen tunggal, perbaikan kecil). "konsultasi" bila user bertanya/meminta saran/opini/penjelasan/analisis tentang proyek (contoh: "apa kekurangan web ini", "saran fitur", "kenapa error X", "bagaimana cara kerja", "sudah siap live atau belum", "apakah route login sudah benar", "tes apa web ini sudah siap") dan TIDAK meminta kode ditulis. "penuh" bila menambah fitur, mengubah struktur data, atau membuat halaman/flow baru. Default "penuh" bila ragu.' },
        { role: 'user', content: userPrompt },
      ], { model, temperature: 0, maxTokens: 100, userId: opts?.userId })
      const raw = typeof cls.message.content === 'string' ? cls.message.content : ''
      const jsonText = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)
      const jenis = JSON.parse(jsonText).jenis
      quickEdit = jenis === 'kecil'
      consult = jenis === 'konsultasi'
    } catch { /* default: jalur penuh */ }
  }

  // Jalur konsultasi: pertanyaan analitik dijawab berbasis kode nyata — model boleh
  // membaca file & mencari kode (read-only), tetapi tidak boleh menulis/build/audit.
  // Tanpa tool di jalur ini, model hanya menebak dari nama file (kasus "siap live?").
  if (consult) {
    await emit({ type: 'status', text: 'Membaca konteks proyek…' })
    const consultTools = TOOLS.filter((t) => ['list_files', 'read_file', 'search_code'].includes(t.function.name))
    const consultMessages: ChatMessage[] = [
      ...messages,
      { role: 'user', content: `${userPrompt}\n\nPENTING: Proyek ini SUDAH ADA — daftar berkas dan potongan file relevan ada di pesan system. Jawab sebagai konsultasi tentang proyek ini berdasarkan isi berkas yang kamu baca, jangan bertanya \"aplikasi apa yang ingin dibangun\" dan jangan berpura-pura proyek kosong. Gunakan tool read_file/search_code untuk memeriksa kode sebelum menjawab. Bila perlu dicek secara nyata (build/preview/route), katakan terus terang bahwa itu perlu dijalankan — jangan mengklaim sudah lolos. Jawab HANYA penjelasan/saran di chat; JANGAN menulis file, menjalankan build/audit, atau membuat rencana kerja.` },
    ]
    for (let turn = 0; turn < 6; turn++) {
      let streamed = ''
      const resp = await complete(consultMessages, {
        model, tools: consultTools, temperature: 0.3, maxTokens: 2500, userId: opts?.userId,
        onDelta: async (d) => { streamed += d; await emit({ type: 'assistant_delta', text: d }) },
      })
      const msg = resp.message
      const calls: ToolCall[] = msg.tool_calls ?? []
      if (!calls.length) {
        const answer = (typeof msg.content === 'string' ? msg.content : streamed).trim()
        if (answer) addMessage(projectId, 'assistant', answer)
        return
      }
      consultMessages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: calls })
      for (const call of calls) {
        const name = call.function.name
        let args: Record<string, unknown> = {}
        try { args = JSON.parse(call.function.arguments || '{}') } catch { args = {} }
        let result = 'ERROR: argumen tidak valid'
        if (name === 'list_files') {
          result = listFiles(projectId).map((f) => f.path).join('\n')
        } else if (name === 'read_file') {
          const path = String(args.path ?? '')
          result = readProjectFile(projectId, path) ?? `ERROR: file ${path} tidak ditemukan`
          if (!filePathsRead.includes(path)) filePathsRead.push(path)
        } else if (name === 'search_code') {
          result = searchProjectCode(projectId, String(args.pattern ?? ''), String(args.path ?? ''))
        }
        consultMessages.push({ role: 'tool', tool_call_id: call.id, name, content: result })
      }
    }
    await emit({ type: 'error', text: 'Pemeriksaan konteks mencapai batas langkah. Jawaban tidak disimpan agar tidak menyesatkan.' })
    return
  }

  // Saat confirmed, user sudah menyetujui rencana pada run sebelumnya — jangan
  // regenerate plan (nanti membingungkan karena bisa berubah). Langsung eksekusi.
  if (quickEdit || opts?.confirmed) {
    if (!opts?.confirmed) {
      messages[0] = { role: 'system', content: `${QUICK_EDIT_SYSTEM}${designContext}\n\nWorkspace saat ini:\n${fileIndex(projectId)}` }
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
      { role: 'user', content: `Permintaan: ${userPrompt}\n\nBerkas yang ada:\n${fileIndex(projectId)}${ctx.text}` },
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
    savePendingPlan(projectId, userPrompt, { ringkasan, langkah, berkas, asumsi, imageIds })
    const planText = langkah.length
      ? `${ringkasan}\n\nRencana kerja:\n${langkah.map((x: { judul: string; detail: string }, i: number) => `${i + 1}. ${x.judul}: ${x.detail}`).join('\n')}`
      : ringkasan
    addMessage(projectId, 'assistant', planText)
    await emit({ type: 'awaiting_confirmation', ringkasan })
    return
  }
  } // end else (full pipeline)

  let askedUser = false
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
      const defectList = pendingPreviewDefects.length ? pendingPreviewDefects.join('\n') : '(tidak ada — render lolos probe otomatis)'
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: `Ini screenshot preview aplikasimu saat ini. Error runtime:\n${errList}\n\nCacat yang TERDETEKSI otomatis (visual DAN interaksi nyata — harus diperbaiki, bukan sekadar opini):\n${defectList}\n\nTemuan dead-button/form-no-submit/form-invalid berarti tombol atau form ada di tampilan tetapi tidak berfungsi saat diklik/disubmit. Perbaiki handler submit/klik, endpoint yang dipanggil, atau state yang tidak berubah — jangan hanya mengganti warna atau teksnya.\n\nBila ada cacat di atas atau masalah visual nyata (layout rusak, konten kosong/placeholder, elemen tumpang tindih), perbaiki lewat write_file lalu panggil build, lalu check_preview lagi. Bila daftar cacat KOSONG dan error runtime tidak ada, JANGAN menulis file apa pun dan langsung beri ringkasan akhir.` },
          { type: 'image_url', image_url: { url: pendingPreviewImage } },
        ],
      })
      pendingPreviewImage = null
      pendingPreviewErrors = []
      pendingPreviewDefects = []
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
        pendingPreviewDefects = []
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
      /* Gerbang cacat: probe menemukan masalah nyata dan belum diperbaiki.
         Model tidak boleh mengakhiri run dengan klaim sukses. Suntik daftar
         cacat sekali lagi dan paksa memperbaiki lewat write_file + build. */
      if (!quickEdit && pendingPreviewDefects.length && msg.content && typeof msg.content === 'string' && !calls.length) {
        const list = pendingPreviewDefects.join('\n')
        pendingPreviewDefects = []
        messages.push({ role: 'assistant', content: msg.content })
        messages.push({ role: 'user', content: `Jangan beri ringkasan akhir: probe visual masih menemukan ${lastDefectCount} cacat nyata:\n${list}\n\nPerbaiki SEMUanya lewat write_file, panggil build, lalu check_preview lagi. Jangan mengklaim selesai sebelum cacat hilang.` })
        continue
      }
      /* Bukti > klaim: bila putaran terakhir masih membawa cacat dan model
         hendak merangkum, paksa check_preview ULANG (bila ronde tersisa)
         supaya perbaikan diverifikasi dari render nyata, bukan dari kata
         model sendiri. */
      if (!quickEdit && touchedUi && buildSucceeded && !defectsVerifiedClean && previewRounds > 0 && previewRounds < MAX_PREVIEW_ROUNDS) {
        messages.push({ role: 'assistant', content: msg.content })
        messages.push({ role: 'user', content: 'Sebelum merangkum, panggil check_preview SATU kali lagi untuk membuktikan cacat tadi benar-benar hilang pada render terbaru. Jangan mengklaim selesai hanya karena kamu menulis perbaikan.' })
        previewRounds++
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
        const path = String(args.path ?? '')
        await emit({ type: 'status', text: `Membaca ${path}…` })
        await emit({ type: 'context', paths: [path] })
        const content = readProjectFile(projectId, path)
        if (!filePathsRead.includes(path)) filePathsRead.push(path)
        result = content ?? `ERROR: file ${path} tidak ditemukan`
      } else if (name === 'search_code') {
        await emit({ type: 'status', text: 'Mencari kode terkait…' })
        result = searchProjectCode(projectId, String(args.pattern ?? ''), String(args.path ?? ''))
      } else if (name === 'write_file') {
        try {
          const path = String(args.path ?? '')
          const newDirs = newDirsForFile(projectId, path)
          const written = writeProjectFile(projectId, path, String(args.content ?? ''))
          putFile(projectId, written, String(args.content ?? ''))
          if (/(^|\/)(src|app|pages|components|routes)\//.test(written) && /\.(tsx|jsx|css|html)$/i.test(written)) touchedUi = true
          if (/src\/routes\//.test(written) && /\.(tsx|jsx)$/i.test(written)) {
            const routePath = routePathFromFile(written)
            if (routePath && !newRouteFiles.includes(routePath)) newRouteFiles.push(routePath)
          }
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
          /* Audit terstruktur disimpan juga sebagai pesan asisten (seperti
             rencana di atas) supaya nilainya bertahan melewati reload —
             event 'audit' saja hanya hidup di stream dan hilang. */
          const auditText = [
            `Audit kualitas: nilai ${Math.max(0, Math.min(100, Number(report.nilai ?? 0)))}/100.`,
            ...temuan.map((x: any) => `- [${x.tingkat}/${x.kategori}] ${x.berkas}: ${x.masalah} Perbaikan: ${x.perbaikan}`),
            String(report.catatan ?? '') ? `Catatan: ${String(report.catatan)}` : '',
          ].filter(Boolean).join('\n').slice(0, 4000)
          addMessage(projectId, 'assistant', auditText)
          result = JSON.stringify({nilai:report.nilai,temuan,catatan:report.catatan, instruksi: needsFix ? 'Perbaiki hanya temuan kritis/penting yang nyata, build ulang, lalu langsung beri ringkasan akhir tanpa memanggil audit lagi.' : 'Tidak ada temuan kritis/penting. Langsung beri ringkasan akhir tanpa memanggil audit lagi.'})
        } catch (err) {
          const note = `Audit gagal dijalankan atau diparse: ${(err as Error).message}`
          await emit({ type: 'audit', nilai: 0, temuan: [], catatan: note })
          addMessage(projectId, 'assistant', note)
          auditCompleted = true
          result = note
        }
        }
      } else if (name === 'check_preview') {
        /* Self-healing visual: render preview nyata, kirim gambar + error runtime
           ke agent supaya bisa MELIHAT dan memperbaiki. Berbatas ronde agar hemat. */
        if (previewRounds >= MAX_PREVIEW_ROUNDS) {
          result = `Batas ${MAX_PREVIEW_ROUNDS} putaran check_preview tercapai. Sisa cacat: ${lastDefectCount}. Perbaiki langsung tanpa check_preview lagi lalu beri ringkasan yang jujur (sebutkan bila belum selesai).`
        } else {
          previewRounds++
          await emit({ type: 'status', text: 'Melihat preview aplikasi…' })
          try {
            const cap = await captureForReview(projectId, { newRoutes: newRouteFiles })
            pendingPreviewImage = cap.image
            pendingPreviewErrors = cap.runtimeErrors
            pendingPreviewDefects = cap.defects
            lastDefectCount = cap.defects.length
            defectsVerifiedClean = cap.defects.length === 0 && cap.runtimeErrors.length === 0
            if (cap.defects.length) {
              await emit({ type: 'status', text: `Ada ${cap.defects.length} masalah tampilan, memperbaiki otomatis…` })
            }
            // Gambar dilewatkan lewat message user multimodal di giliran berikut,
            // bukan lewat content tool (tool tak mendukung gambar).
            const errNote = cap.runtimeErrors.length
              ? `\n\nError runtime terdeteksi (${cap.runtimeErrors.length}):\n${cap.runtimeErrors.join('\n')}`
              : '\n\nTidak ada error console/pageerror.'
            const defectNote = cap.defects.length
              ? `\n\nCacat render terdeteksi (${cap.defects.length}):\n${cap.defects.join('\n')}`
              : '\n\nProbe visual otomatis: LOLOS (tidak ada cacat terdeteksi).'
            result = `Screenshot preview diambil. Gambar dikirim pada pesan berikutnya.${errNote}${defectNote}\n\nPeriksa gambar: bila ada kerusakan visual, layout rusak, konten kosong, atau error di atas, perbaiki lewat write_file lalu build lagi. Bila tampilan sudah baik, langsung beri ringkasan akhir.`
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
        const packages = Array.isArray(args.packages) ? args.packages.filter((p): p is string => typeof p === 'string' && p.length > 0) : []
        const r = await installDeps(projectId, packages)
        await emit({ type: 'install', ok: r.code === 0, log: r.output.slice(-4000) })
        result = `exit=${r.code}\n${r.output.slice(-2500)}`
      } else if (name === 'ask_user') {
        const question = String(args.question ?? '').trim().slice(0, 500)
        const hint = String(args.hint ?? '').trim().slice(0, 300) || null
        if (!question) {
          result = 'ERROR: pertanyaan tidak boleh kosong.'
        } else {
          savePendingAnswer(projectId, question, hint ?? undefined)
          addMessage(projectId, 'assistant', `${question}${hint ? `\n\n${hint}` : ''}`)
          await emit({ type: 'awaiting_answer', question, hint })
          result = 'MENUNGGU_JAWABAN_USER: run dihentikan. Jangan lanjutkan atau merangkum sampai user menjawab.'
          askedUser = true
        }
      } else if (name === 'set_secret') {
        const key = String(args.key ?? '').trim()
        const value = String(args.value ?? '')
        if (!/^[A-Z][A-Z0-9_]*$/.test(key) || !value) {
          result = 'ERROR: key harus HURUF_KAPITAL_ANGKA dan value tidak boleh kosong.'
        } else {
          setSettingFromAgent(projectId, `secret_${key}`, value)
          result = `OK: ${key} tersimpan sebagai environment variable server preview (nilai tidak ditampilkan).`
        }
      } else if (name === 'interact_preview') {
        await emit({ type: 'status', text: 'Mengoperasikan browser preview…' })
        const r = await interactPreview(projectId, args)
        result = `${r.ok ? 'OK' : 'GAGAL'}: ${r.detail}\nURL: ${r.url}${r.text ? `\nTEKS HALAMAN:\n${r.text}` : ''}${r.runtimeErrors.length ? `\nError runtime: ${r.runtimeErrors.join(' | ')}` : ''}`
      } else if (name === 'run') {
        await emit({ type: 'status', text: 'Menjalankan perintah…' })
        const r = await runProjectCommand(projectId, args)
        await emit({ type: 'terminal', command: r.command, ok: r.ok, log: r.output.slice(-4000) })
        result = `exit=${r.code}\n${r.output.slice(-8000)}`
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
      if (askedUser) break
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

    if (askedUser) {
      // Simpan percakapan parsial supaya run lanjutan tidak kehilangan jejak
      // (rencana, tool call, hasil sebelumnya). Jawaban user disuntikkan di
      // awal run berikutnya lewat opts.answer.
      for (const m of messages.slice(1)) {
        if (m.role === 'assistant' && m.content && typeof m.content === 'string' && !m.tool_calls) addMessage(projectId, 'assistant', m.content)
      }
      await emit({ type: 'done' })
      return
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

/* Context pack: sisipkan potongan file paling relevan ke system prompt agar
   model tidak menebak dari nama file saja. Skor: token prompt yang muncul di
   path atau isi file,文件的 path lebih pendek sedikit diprioritaskan. Best-effort
   dan dibatasi total char supaya tidak membengkakkan biaya. */
function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []).filter((t) => !/^(yang|dan|dari|untuk|dengan|pada|ini|itu|bagaimana|apakah)$/.test(t))
}
function contextBrief(projectId: string, prompt: string): { text: string; paths: string[] } {
  const tokens = Array.from(new Set(tokenize(prompt)))
  if (!tokens.length) return { text: '', paths: [] }
  const scored = listFiles(projectId)
    .filter((f) => /\.(tsx?|jsx?|css|json|md|sql|html)$/.test(f.path) && !/(lock|\.gen\.)/.test(f.path))
    .map((f) => {
      const content = readProjectFile(projectId, f.path) ?? ''
      const lowPath = f.path.toLowerCase()
      const lowBody = content.toLowerCase()
      const score = tokens.reduce((n, t) => n + (lowPath.includes(t) ? 3 : 0) + (lowBody.includes(t) ? 1 : 0), 0)
      return { path: f.path, content, score }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
  let budget = 18_000
  const blocks: string[] = []
  const paths: string[] = []
  for (const f of scored) {
    if (budget <= 0) break
    const excerpt = f.content.slice(0, budget)
    if (!excerpt.trim()) continue
    blocks.push(`--- ${f.path} ---\n${excerpt}`)
    paths.push(f.path)
    budget -= excerpt.length
  }
  return { text: blocks.length ? `\n\nKONTEKS PROYEK (potongan file paling relevan dengan permintaan ini — baca file lengkap dengan read_file bila perlu):\n${blocks.join('\n\n')}` : '', paths }
}
/* Cari pola di seluruh file workspace (dipakai tool search_code). */
function searchProjectCode(projectId: string, pattern: string, pathFilter: string): string {
  let re: RegExp
  try { re = new RegExp(pattern, 'i') } catch (e) { return `ERROR: pola regex tidak valid: ${(e as Error).message}` }
  const hits: string[] = []
  let total = 0
  for (const f of listFiles(projectId)) {
    if (pathFilter && !f.path.toLowerCase().includes(pathFilter.toLowerCase())) continue
    const content = readProjectFile(projectId, f.path) ?? ''
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue
      total++
      if (hits.length < 40) hits.push(`${f.path}:${i + 1}: ${lines[i].trim().slice(0, 220)}`)
    }
  }
  return hits.length ? `${hits.join('\n')}${total > hits.length ? `\n… dan ${total - hits.length} kecocokan lain (dibatasi 40).` : ''}` : `(tidak ada kecocokan untuk /${pattern}/i)`
}

function fileIndex(projectId: string) {
  const files = listFiles(projectId)
  if (!files.length) return '(kosong, selain template dasar: src/routes/__root.tsx, src/routes/index.tsx, src/styles.css)'
  return files.map((f) => `- ${f.path}`).join('\n')
}

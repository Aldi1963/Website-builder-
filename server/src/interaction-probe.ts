/* Interaction probe: membuktikan tombol & form benar-benar berfungsi, bukan
   hanya tampil di screenshot. Dijalankan setelah screenshot diambil supaya
   gambar yang dikirim ke model tetap merepresentasikan keadaan awal halaman.

   KONTRAK NON-MUTATING — probe TIDAK PERNAH mengubah data aplikasi:
   - Form HANYA diisi lalu diperiksa validasi client-side (checkValidity(),
     tombol submit tersedia & aktif). TIDAK PERNAH submit: tanpa
     requestSubmit(), tanpa klik tombol submit, tanpa dispatch event
     'submit', tanpa menekan Enter di dalam form.
   - Tombol HANYA diklik bila labelnya jelas non-mutating (navigasi,
     buka/tutup dialog, batal) DAN tombol itu bukan tombol submit DAN tidak
     berada di dalam <form>. Semua label yang bisa bermutasi (daftar,
     simpan, buat, tambah, kirim, beli, bayar, hapus, ...) dilewati.
     Bila ragu, LEWATI tombolnya daripada diklik.
   - Karena tidak ada aksi mutasi, tidak ada yang perlu di-"reset": reload
     halaman sesudah probe (screenshots.ts) hanya membersihkan nilai yang
     diketik dari DOM, BUKAN mengembalikan baris database — tidak ada baris
     yang pernah ditulis probe.

   Semua pemeriksaan deterministik dan dibatasi (maks 5 tombol, 2 form) agar
   capture tetap cepat. */

export type InteractionFinding = { kind: string; detail: string }

/* Label yang bisa bermutasi — JANGAN PERNAH diklik / di-submit probe.
   Daftar ini sengaja luas: label yang ambigu dianggap bermutasi. */
const MUTATING =
  /daftar|register|sign ?up|gabung|langganan|subscribe|simpan|save|buat|create|tambah|add|kirim|send|beli|buy|bayar|pay|checkout|pesan|order|publish|terbitkan|hapus|delete|remove|update|perbarui|ubah|edit|login|masuk|logout|keluar|log ?out|verifikasi|verify|kirim ulang|resend|proses|process|konfirmasi|confirm|setuju|agree|terapkan|apply|unggah|upload|impor|import|ekspor|export|reset|pulihkan|restore|selesai|submit|lanjutkan|checkout/i

/* Satu-satunya label yang boleh diklik: navigasi / dialog / batal / cari.
   Tombol yang tidak cocok pola ini dilewati (tidak diketahui aman). */
const SAFE_CLICK =
  /^(tutup|close|batal|cancel|lewati|skip|lihat|detail|selengkapnya|kembali|back|buka|open|tampilkan|tampil|sembunyikan|filter|urutkan|cari|search|salin|copy|pratinjau|preview|info|bantuan|help)\b/i
const CLOSE_ONLY = /^(tutup|close|batal|cancel|skip|lewati)$/i

function short(value: unknown, max = 70): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max) || '(tanpa label)'
}

export async function probeInteractions(page: any, target: string): Promise<InteractionFinding[]> {
  const findings: InteractionFinding[] = []

  const installObserver = async () => {
    await page.evaluate(() => {
      const w = window as any
      w.__vbProbeMutations = 0
      if (w.__vbProbeObserver) w.__vbProbeObserver.disconnect()
      w.__vbProbeObserver = new MutationObserver((records: any[]) => {
        w.__vbProbeMutations += records.length
      })
      w.__vbProbeObserver.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
    })
  }
  const resetObserver = async () => page.evaluate(() => { (window as any).__vbProbeMutations = 0 })
  const mutations = async () => page.evaluate(() => (window as any).__vbProbeMutations ?? 0)
  const dialogs = async () => page.evaluate(() =>
    document.querySelectorAll('[role="dialog"], dialog[open], [data-vbprobe-toast]').length,
  )
  const text = async () => page.evaluate(() => (document.body?.innerText ?? '').trim())

  const beforeAction = async () => ({
    url: page.url(),
    mutations: 0,
    dialogs: await dialogs(),
    text: await text(),
  })
  const hadEffect = (before: Awaited<ReturnType<typeof beforeAction>>, afterMutations: number, afterText: string, afterDialogs: number) =>
    afterMutations > 0 ||
    page.url() !== before.url ||
    afterDialogs > before.dialogs ||
    Math.abs(afterText.length - before.text.length) > 10

  try {
    /* ---- (1) Tombol aksi: klik HANYA yang jelas non-mutating, ukur efek ---- */
    const buttons: { idx: number; text: string }[] = await page.evaluate(() => {
      const out: { idx: number; text: string }[] = []
      const els = Array.from(document.querySelectorAll('button, [role="button"], input[type="button"]'))
      let n = 0
      for (const el of els) {
        if (n >= 5) break
        const node = el as HTMLElement
        const label = node.innerText || (node as HTMLInputElement).value || node.getAttribute('aria-label') || ''
        const box = node.getBoundingClientRect()
        const style = getComputedStyle(node)
        if (!label.trim() || box.width < 4 || box.height < 4) continue
        if ((node as HTMLButtonElement).disabled || style.visibility === 'hidden' || style.display === 'none') continue
        /* Tombol yang terikat ke form tidak pernah diklik: kliknya sama
           dengan submit form (mutasi). Tombol tanpa type di LUAR form aman:
           <button> tanpa type memang default 'submit', tapi tanpa form
           pemilik tidak ada yang di-submit saat diklik. */
        if (node.closest('form') || node.hasAttribute('form')) continue
        node.setAttribute('data-vbprobe-idx', String(n))
        out.push({ idx: n, text: label.trim().slice(0, 70) })
        n++
      }
      return out
    })

    if (buttons.length) await installObserver()
    for (const btn of buttons) {
      /* Bila ragu, lewati: label bermutasi ATAU tidak terbukti aman. */
      if (MUTATING.test(btn.text)) continue
      if (!SAFE_CLICK.test(btn.text)) continue
      await resetObserver()
      const before = await beforeAction()
      await page.locator(`[data-vbprobe-idx="${btn.idx}"]`).first().click({ timeout: 2000, force: true }).catch(() => {})
      await page.waitForTimeout(350)
      const afterMutations = await mutations()
      const afterText = await text()
      const afterDialogs = await dialogs()
      if (hadEffect(before, afterMutations, afterText, afterDialogs)) continue
      if (CLOSE_ONLY.test(btn.text)) continue
      findings.push({
        kind: 'dead-button',
        detail: `Tombol "${short(btn.text)}" diklik tetapi tidak ada perubahan apa pun (URL, teks, dialog, atau DOM). User akan mengira tombol rusak.`,
      })
    }

    /* ---- (2) Form: isi nilai wajar, periksa validasi client-side, TANPA submit ----
       Tidak ada requestSubmit(), tidak ada klik tombol submit, tidak ada
       dispatch 'submit'. Yang diperiksa: (a) form punya tombol submit yang
       aktif — tanpanya user tidak bisa mengirim form; (b) isian yang valid
       lolos checkValidity() — bila ditolak, aturan validasi form bermasalah. */
    const forms: number[] = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('form'))
      const out: number[] = []
      let n = 0
      for (const el of els) {
        if (n >= 2) break
        const f = el as HTMLFormElement
        const box = f.getBoundingClientRect()
        if (box.width < 4 || box.height < 4) continue
        f.setAttribute('data-vbprobe-form', String(n))
        out.push(n)
        n++
      }
      return out
    })

    if (forms.length) await installObserver()
    for (const idx of forms) {
      await page.evaluate((n: number) => {
        const f = document.querySelector(`[data-vbprobe-form="${n}"]`) as HTMLFormElement | null
        if (!f) return
        for (const el of Array.from(f.querySelectorAll('input, textarea, select'))) {
          const node = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
          if (node.disabled || (node instanceof HTMLInputElement && node.type === 'hidden')) continue
          if (node instanceof HTMLInputElement && (node.type === 'checkbox' || node.type === 'radio')) {
            node.checked = true
          } else if (node instanceof HTMLSelectElement) {
            if (node.options.length > 1) node.selectedIndex = 1
          } else if (node instanceof HTMLInputElement && node.type === 'email') {
            node.value = 'probe@example.com'
          } else if (node instanceof HTMLInputElement && node.type === 'number') {
            node.value = '1'
          } else if (node instanceof HTMLInputElement && node.type === 'password') {
            node.value = 'Probe12345'
          } else {
            node.value = 'Probe'
          }
          node.dispatchEvent(new Event('input', { bubbles: true }))
          node.dispatchEvent(new Event('change', { bubbles: true }))
        }
      }, idx)

      await page.waitForTimeout(350)
      const state = await page.evaluate((n: number) => {
        const f = document.querySelector(`[data-vbprobe-form="${n}"]`) as HTMLFormElement | null
        if (!f) return null
        const submit = f.querySelector('button[type="submit"], input[type="submit"], button:not([type])') as HTMLElement | null
        const submitEnabled = !!submit && !(submit as HTMLButtonElement).disabled
        const invalid: string[] = []
        if (!f.checkValidity()) {
          for (const el of Array.from(f.elements)) {
            const node = el as HTMLInputElement
            if (node.validationMessage) invalid.push(`${node.name || node.type || 'field'}: ${node.validationMessage}`)
          }
        }
        return { hasSubmit: !!submit, submitEnabled, valid: f.checkValidity(), invalid: invalid.slice(0, 3) }
      }, idx)
      if (!state) continue

      if (!state.hasSubmit || !state.submitEnabled) {
        findings.push({
          kind: 'form-no-submit',
          detail: `Form pada ${short(target, 90)} tidak punya tombol submit yang aktif — user tidak bisa mengirim form ini.`,
        })
      } else if (!state.valid) {
        findings.push({
          kind: 'form-invalid',
          detail: `Form pada ${short(target, 90)} menolak isian yang valid (${short(state.invalid.join('; '), 120)}). Periksa aturan validasi form.`,
        })
      }
    }
  } finally {
    try { await page.evaluate(() => { const w = window as any; if (w.__vbProbeObserver) w.__vbProbeObserver.disconnect() }) } catch { /* abaikan */ }
  }
  return findings.slice(0, 6)
}

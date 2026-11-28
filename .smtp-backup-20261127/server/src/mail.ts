/*
 * Pengiriman tautan reset password.
 *
 * Tanpa provider email, token TIDAK pernah dikembalikan ke response — itu
 * sebelumnya memungkinkan account takeover hanya dengan mengetahui email.
 * Dua jalur pengiriman yang didukung:
 *   1. Resend HTTP API (cukup fetch, tanpa dependency): VB_RESEND_KEY + VB_MAIL_FROM
 *   2. Dev/self-host opt-in VB_DEV_RESET_LINK=1 -> token dikembalikan ke caller.
 *
 * Nilai kunci hanya dibaca dari environment, tidak pernah ditulis ke kode/log.
 */
const RESEND_ENDPOINT = 'https://api.resend.com/emails'

export type ResetDelivery =
  | { mode: 'sent'; message: string }
  | { mode: 'dev'; link: string; message: string }
  | { mode: 'logged'; message: string }

export function resetDeliveryConfigured(): boolean {
  return Boolean(process.env.VB_RESEND_KEY && process.env.VB_MAIL_FROM)
}

export function devResetLinkEnabled(): boolean {
  return process.env.VB_DEV_RESET_LINK === '1'
}

export async function deliverResetLink(email: string, link: string): Promise<ResetDelivery> {
  const key = process.env.VB_RESEND_KEY
  const from = process.env.VB_MAIL_FROM
  if (key && from) {
    try {
      const res = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from,
          to: [email],
          subject: 'Tautan atur ulang password VibeBuilder',
          text: `Buka tautan ini untuk mengatur ulang password kamu:\n\n${link}\n\nTautan berlaku 30 menit. Jika kamu tidak memintanya, abaikan email ini.\n`,
        }),
      })
      if (res.ok) {
        return { mode: 'sent', message: 'Jika email terdaftar, tautan atur ulang sudah dikirim.' }
      }
      console.error('[auth] gagal mengirim email reset: HTTP', res.status)
    } catch (err) {
      console.error('[auth] gagal mengirim email reset:', (err as Error).message)
    }
    /* Gagal kirim: jangan bocorkan token, jangan beri kesan sukses. */
    return { mode: 'logged', message: 'Email belum bisa dikirim. Hubungi admin situs ini.' }
  }
  if (devResetLinkEnabled()) {
    return { mode: 'dev', link, message: 'Mode pengembangan: tautan atur ulang dibuat.' }
  }
  /* Self-host tanpa provider: admin bisa melihat tautan di log server. */
  console.log(`[auth] reset link untuk ${email}: ${link}`)
  return { mode: 'logged', message: 'Jika email terdaftar, hubungi admin situs ini untuk menerima tautan atur ulang.' }
}

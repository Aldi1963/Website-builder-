/*
 * Pengiriman tautan reset password.
 *
 * Token TIDAK pernah dikembalikan ke response — itu sebelumnya memungkinkan
 * account takeover hanya dengan mengetahui email. Urutan pengiriman:
 *   1. SMTP dari panel admin (admin_settings smtp.*) / env VB_SMTP_*
 *   2. Resend HTTP API (fallback lama): VB_RESEND_KEY + VB_MAIL_FROM
 *   3. Dev/self-host opt-in VB_DEV_RESET_LINK=1 -> token ke caller (dev only)
 *   4. Self-host tanpa provider -> token hanya di log server (admin baca log)
 *
 * Nilai rahasia tidak pernah ditulis ke kode atau log.
 */
import { sendMail, smtpConfig } from './smtp.ts'

const RESEND_ENDPOINT = 'https://api.resend.com/emails'

export type ResetDelivery =
  | { mode: 'sent'; message: string }
  | { mode: 'dev'; link: string; message: string }
  | { mode: 'logged'; message: string }

export function resetDeliveryConfigured(): boolean {
  const s = smtpConfig()
  const smtpReady = Boolean(s.host && s.port && s.from)
  return smtpReady || Boolean(process.env.VB_RESEND_KEY && process.env.VB_MAIL_FROM)
}

export function devResetLinkEnabled(): boolean {
  return process.env.VB_DEV_RESET_LINK === '1'
}

const SUBJECT = 'Tautan atur ulang password VibeBuilder'
const textFor = (link: string) =>
  `Buka tautan ini untuk mengatur ulang password kamu:\n\n${link}\n\n` +
  `Tautan berlaku 30 menit. Jika kamu tidak memintanya, abaikan email ini.\n`

export async function deliverResetLink(email: string, link: string): Promise<ResetDelivery> {
  const sent: ResetDelivery = { mode: 'sent', message: 'Jika email terdaftar, tautan atur ulang sudah dikirim.' }
  const s = smtpConfig()
  if (s.host && s.port && s.from) {
    try {
      await sendMail(email, SUBJECT, textFor(link), s)
      return sent
    } catch (err) {
      console.error('[auth] gagal mengirim email reset via SMTP:', (err as Error).message)
      /* Jangan jatuhkan ke Resend: admin mengira SMTP aktif padahal gagal. */
      return { mode: 'logged', message: 'Email belum bisa dikirim. Hubungi admin situs ini.' }
    }
  }
  const key = process.env.VB_RESEND_KEY
  const from = process.env.VB_MAIL_FROM
  if (key && from) {
    try {
      const res = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: [email], subject: SUBJECT, text: textFor(link) }),
      })
      if (res.ok) return sent
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

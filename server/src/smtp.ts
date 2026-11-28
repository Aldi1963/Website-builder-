/*
 * SMTP relay untuk email transaksional (tautan reset password, verifikasi, dst).
 *
 * Konfigurasi diatur dari panel admin (tabel admin_settings, kunci smtp.*),
 * bukan ditulis di kode. Environment hanya fallback untuk deployment lama.
 * Nilai rahasia (password) TIDAK pernah dikembalikan ke API atau ditulis ke log.
 *
 * Koneksi memakai node:net / node:tls langsung — tanpa dependency baru.
 * AUTENTIKASI DITOLAK bila koneksi belum terenkripsi (STARTTLS / implicit TLS).
 */
import { connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { adminSetting } from './llm.ts'

export type SmtpConfig = {
  host: string
  port: number
  user: string
  pass: string
  from: string
  /** true = implicit TLS (465), false = STARTTLS bila didukung relay */
  secure: boolean
}

export function smtpConfig(): SmtpConfig {
  const portRaw = adminSetting('smtp.port') ?? process.env.VB_SMTP_PORT ?? ''
  const portNum = Number(portRaw)
  return {
    host: (adminSetting('smtp.host') ?? process.env.VB_SMTP_HOST ?? '').trim(),
    port: Number.isFinite(portNum) && portNum > 0 && portNum <= 65535 ? portNum : (portNum === 587 ? 587 : 0),
    user: (adminSetting('smtp.user') ?? process.env.VB_SMTP_USER ?? '').trim(),
    pass: adminSetting('smtp.pass') ?? process.env.VB_SMTP_PASS ?? '',
    from: (adminSetting('smtp.from') ?? process.env.VB_SMTP_FROM ?? '').trim(),
    secure: (adminSetting('smtp.secure') ?? process.env.VB_SMTP_SECURE ?? '').trim() === '1',
  }
}

export function smtpConfigured(): boolean {
  const c = smtpConfig()
  return Boolean(c.host && c.port && c.from)
}

/** Status untuk panel admin: hanya flag & nilai non-rahasia yang terpotong. */
export function smtpSettingsView() {
  const c = smtpConfig()
  return {
    configured: smtpConfigured(),
    host: c.host ? c.host.slice(0, 60) : '',
    port: c.port,
    from: c.from ? c.from.slice(0, 80) : '',
    hasUser: Boolean(c.user),
    hasPassword: Boolean(c.pass),
    secure: c.secure,
    fromPanel: {
      host: adminSetting('smtp.host') !== undefined,
      port: adminSetting('smtp.port') !== undefined,
      from: adminSetting('smtp.from') !== undefined,
    },
    note: 'SMTP diatur di sini. Password tidak pernah ditampilkan kembali; kosongkan field untuk menghapus. Autentikasi hanya dikirim lewat koneksi TLS/STARTTLS.',
  }
}

/* ---- Client SMTP minimal, promise-based ---- */
type Wire = {
  socket: Socket | TLSSocket
  readLine(): Promise<string>
  command(line: string): Promise<string>
  detach(): void
  close(): void
}

function wrap(socket: Socket | TLSSocket): Wire {
  let buffer = ''
  /* Balasan multibar sering tiba dalam SATU chunk TCP. Baris yang belum
     punya peminta harus diantre, bukan dibuang — kalau tidak, EHLO selalu
     hang pada relay sungguhan. */
  const lines: string[] = []
  const waiters: Array<(line: string) => void> = []
  const onData = (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    let i: number
    while ((i = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, i)
      buffer = buffer.slice(i + 2)
      const resolve = waiters.shift()
      if (resolve) resolve(line)
      else lines.push(line)
    }
  }
  socket.on('data', onData)
  socket.on('error', () => {
    while (waiters.length) waiters.shift()?.('')
  })
  const readLine = () => new Promise<string>((resolve) => {
    const next = lines.shift()
    if (next !== undefined) resolve(next)
    else waiters.push(resolve)
  })
  return {
    socket,
    readLine,
    async command(line) {
      socket.write(`${line}\r\n`)
      const first = await readLine()
      if (!first) throw new Error('koneksi SMTP terputus')
      let last = first
      /* Balasan multibar: baris dengan '-' di posisi ke-4 menandakan masih
         ada lanjutan. Cek baris TERAKHIR yang dibaca, bukan baris pertama. */
      while (last.slice(3, 4) === '-') {
        last = await readLine()
        if (!last) throw new Error('koneksi SMTP terputus saat balasan multibar')
      }
      return last
    },
    detach() {
      socket.off('data', onData)
    },
    close() {
      socket.off('data', onData)
      socket.destroy()
    },
  }
}

function code(line: string): number {
  return Number(line.slice(0, 3))
}

function encodeAuth(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64')
}

async function upgradeStartTls(wire: Wire, host: string): Promise<Wire> {
  /* Lepas listener lama SEBELUM upgrade: jika tidak, sisa buffer TLS bisa
     memicu resolve ganda dan pesan DATA tampak tertelan. */
  wire.detach()
  const tlsSocket = tlsConnect({ socket: wire.socket, servername: host })
  await new Promise<void>((resolve, reject) => {
    tlsSocket.once('secureConnect', resolve)
    tlsSocket.once('error', reject)
  })
  return wrap(tlsSocket)
}

async function authenticate(wire: Wire, c: SmtpConfig, capabilities: string) {
  if (!c.user || !c.pass) return
  if (!/250[- ]AUTH/i.test(capabilities) && !/250[- ]AUTH\s/i.test(capabilities)) {
    throw new Error('relay tidak mengiklankan AUTH; kredensial tidak dikirim')
  }
  if (/PLAIN/i.test(capabilities)) {
    const res = await wire.command(`AUTH PLAIN ${encodeAuth(`\u0000${c.user}\u0000${c.pass}`)}`)
    if (code(res) !== 235) throw new Error('autentikasi SMTP ditolak')
    return
  }
  let res = await wire.command('AUTH LOGIN')
  if (code(res) !== 334) throw new Error('relay tidak mendukung AUTH LOGIN')
  res = await wire.command(encodeAuth(c.user))
  if (code(res) !== 334) throw new Error('autentikasi SMTP gagal pada username')
  res = await wire.command(encodeAuth(c.pass))
  if (code(res) !== 235) throw new Error('autentikasi SMTP ditolak')
}

function envelope(value: string): string {
  /* Tolak character injection pada alamat. */
  if (/[\r\n<>]/.test(value)) throw new Error('alamat email mengandung karakter tidak valid')
  return value.trim()
}

export async function sendMail(to: string, subject: string, text: string, config = smtpConfig()): Promise<void> {
  if (!config.host || !config.port || !config.from) throw new Error('SMTP belum dikonfigurasi')
  const recipient = envelope(to)
  const timeoutMs = 10_000
  let wire: Wire | null = null
  try {
    const socket = config.secure
      ? tlsConnect({ host: config.host, port: config.port, servername: config.host })
      : netConnect({ host: config.host, port: config.port })
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('timeout koneksi SMTP')))
    await new Promise<void>((resolve, reject) => {
      socket.once(config.secure ? 'secureConnect' : 'connect', resolve)
      socket.once('error', reject)
    })
    wire = wrap(socket)
    const greeting = await wire.readLine()
    if (code(greeting) !== 220) throw new Error('relay menolak koneksi')

    let ehlo = await wire.command(`EHLO ${envelope(config.from.split('@')[1] || 'localhost')}`)
    if (code(ehlo) !== 250) throw new Error('EHLO ditolak relay')

    if (!config.secure) {
      const startTls = /250[- ]STARTTLS/i.test(ehlo) || /\bSTARTTLS\b/i.test(ehlo)
      if ((config.user || config.pass) && !startTls) {
        throw new Error('relay tidak mendukung STARTTLS — kredensial tidak dikirim')
      }
      if (startTls) {
        const start = await wire.command('STARTTLS')
        if (code(start) !== 220) throw new Error('STARTTLS ditolak relay')
        wire = await upgradeStartTls(wire, config.host)
        ehlo = await wire.command(`EHLO ${envelope(config.from.split('@')[1] || 'localhost')}`)
        if (code(ehlo) !== 250) throw new Error('EHLO setelah STARTTLS ditolak')
      }
    }

    await authenticate(wire, config, ehlo)

    let res = await wire.command(`MAIL FROM:<${envelope(config.from)}>`)
    if (code(res) !== 250) throw new Error('MAIL FROM ditolak relay')
    res = await wire.command(`RCPT TO:<${recipient}>`)
    if (code(res) !== 250 && code(res) !== 251) throw new Error('RCPT TO ditolak relay')
    res = await wire.command('DATA')
    if (code(res) !== 354) throw new Error('relay tidak menerima DATA')

    const safeSubject = String(subject).replace(/[\r\n]/g, ' ')
    const safeText = String(text).replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..')
    wire.socket.write(
      `From: ${config.from}\r\nTo: ${recipient}\r\nSubject: ${safeSubject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${safeText}\r\n.\r\n`,
    )
    res = await wire.readLine()
    if (code(res) !== 250) throw new Error('relay menolak pesan')

    try { await wire.command('QUIT') } catch { /* relay boleh menutup lebih dulu */ }
  } finally {
    wire?.close()
  }
}

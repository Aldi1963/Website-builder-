import { getPgPool, query } from './db-browser'
import { ensureAuthSchema, type SafeUser } from './auth'

/**
 * Schema tiketing: events, ticket_types, orders, order_items, attendees,
 * ticket_scans, promo_codes. Semua idempoten — aman dipanggil berulang.
 *
 * Uang disimpan sebagai INTEGER sen (bukan float) supaya tidak ada
 * pembulatan pada harga tiket dan total order.
 */
export async function ensureTiketSchema(): Promise<void> {
  await ensureAuthSchema()

  await query(`
    create table if not exists events (
      id serial primary key,
      title text not null,
      slug text not null unique,
      description text not null default '',
      venue text not null default '',
      starts_at timestamptz,
      status text not null default 'draft',
      created_by integer references users(id) on delete set null,
      created_at timestamptz not null default now()
    )
  `)
  await query(`create index if not exists events_status_idx on events(status, starts_at)`)

  await query(`
    create table if not exists ticket_types (
      id serial primary key,
      event_id integer not null references events(id) on delete cascade,
      name text not null,
      price_cents integer not null check (price_cents >= 0),
      quota integer not null check (quota >= 0),
      sold integer not null default 0 check (sold >= 0),
      created_at timestamptz not null default now()
    )
  `)
  await query(`create index if not exists ticket_types_event_idx on ticket_types(event_id)`)

  await query(`
    create table if not exists orders (
      id serial primary key,
      user_id integer not null references users(id) on delete cascade,
      event_id integer not null references events(id) on delete restrict,
      code text not null unique,
      status text not null default 'pending',
      subtotal_cents integer not null check (subtotal_cents >= 0),
      discount_cents integer not null default 0 check (discount_cents >= 0),
      total_cents integer not null check (total_cents >= 0),
      promo_code text,
      created_at timestamptz not null default now()
    )
  `)
  await query(`create index if not exists orders_user_idx on orders(user_id, created_at desc)`)

  await query(`
    create table if not exists order_items (
      id serial primary key,
      order_id integer not null references orders(id) on delete cascade,
      ticket_type_id integer not null references ticket_types(id) on delete restrict,
      quantity integer not null check (quantity > 0),
      unit_price_cents integer not null check (unit_price_cents >= 0)
    )
  `)
  await query(`create index if not exists order_items_order_idx on order_items(order_id)`)

  await query(`
    create table if not exists attendees (
      id serial primary key,
      order_id integer not null references orders(id) on delete cascade,
      ticket_type_id integer not null references ticket_types(id) on delete restrict,
      name text not null,
      email text not null,
      code text not null unique,
      checked_in_at timestamptz,
      created_at timestamptz not null default now()
    )
  `)
  await query(`create index if not exists attendees_order_idx on attendees(order_id)`)

  await query(`
    create table if not exists ticket_scans (
      id serial primary key,
      attendee_id integer not null references attendees(id) on delete cascade,
      scanned_by integer references users(id) on delete set null,
      scanned_at timestamptz not null default now()
    )
  `)

  await query(`
    create table if not exists promo_codes (
      id serial primary key,
      code text not null unique,
      event_id integer references events(id) on delete cascade,
      percent integer not null check (percent > 0 and percent <= 100),
      max_uses integer not null default 100 check (max_uses > 0),
      used_count integer not null default 0 check (used_count >= 0),
      created_at timestamptz not null default now()
    )
  `)
}

/** Event boleh dilihat publik hanya bila statusnya published. */
export async function canManageEvent(
  event: { id: number; created_by: number | null },
  user: SafeUser | null,
): Promise<boolean> {
  if (!user) return false
  if (user.role === 'admin') return true
  if (user.role !== 'organizer') return false
  return event.created_by === user.id
}

/**
 * Buat pesanan dengan transaksi nyata: cek kuota, kurangi stok, dan buat
 * kode peserta. Katalog publik hanya boleh memesan event published.
 */
export async function createOrder(input: {
  userId: number
  eventId: number
  items: { ticketTypeId: number; quantity: number }[]
  promoCode?: string
}) {
  if (!input.items.length) throw new Error('Pilih minimal satu jenis tiket.')
  if (input.items.length > 10) throw new Error('Maksimal 10 jenis tiket per pesanan.')
  for (const it of input.items) {
    if (!Number.isInteger(it.quantity) || it.quantity < 1 || it.quantity > 20) {
      throw new Error('Jumlah tiket harus antara 1 dan 20.')
    }
  }

  const client = await (await getPgPool()).connect()
  try {
    await client.query('begin')
    const ev = await client.query(
      `select id, status, created_by from events where id=$1 and status='published' for update`,
      [input.eventId],
    )
    if (!ev.rows.length) throw new Error('Event tidak tersedia untuk dipesan.')

    let subtotal = 0
    const lines: { ticket_type_id: number; quantity: number; unit_price_cents: number }[] = []
    for (const it of input.items) {
      const tt = await client.query(
        `select id, price_cents, quota, sold from ticket_types where id=$1 and event_id=$2 for update`,
        [it.ticketTypeId, input.eventId],
      )
      const row = tt.rows[0]
      if (!row) throw new Error('Jenis tiket tidak ditemukan pada event ini.')
      if (row.sold + it.quantity > row.quota) {
        throw new Error(`Kuota ${row.name ?? 'tiket'} tidak mencukupi.`)
      }
      subtotal += row.price_cents * it.quantity
      lines.push({ ticket_type_id: row.id, quantity: it.quantity, unit_price_cents: row.price_cents })
    }

    let discount = 0
    let promoCode: string | null = null
    if (input.promoCode) {
      const promo = await client.query(
        `select * from promo_codes where upper(code)=upper($1)
           and (event_id is null or event_id=$2) and used_count < max_uses for update`,
        [input.promoCode, input.eventId],
      )
      const p = promo.rows[0]
      if (!p) throw new Error('Kode promo tidak valid atau sudah habis.')
      discount = Math.round((subtotal * p.percent) / 100)
      promoCode = p.code
      await client.query(`update promo_codes set used_count=used_count+1 where id=$1`, [p.id])
    }

    const total = subtotal - discount
    const code = `TKT-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
    const order = await client.query(
      `insert into orders (user_id, event_id, code, status, subtotal_cents, discount_cents, total_cents, promo_code)
       values ($1,$2,$3,'paid',$4,$5,$6,$7) returning id, code, total_cents`,
      [input.userId, input.eventId, code, subtotal, discount, total, promoCode],
    )
    const orderId = order.rows[0].id

    const attendees: { code: string; ticket_type_id: number }[] = []
    for (const line of lines) {
      await client.query(
        `insert into order_items (order_id, ticket_type_id, quantity, unit_price_cents)
         values ($1,$2,$3,$4)`,
        [orderId, line.ticket_type_id, line.quantity, line.unit_price_cents],
      )
      await client.query(
        `update ticket_types set sold=sold+$1 where id=$2`,
        [line.quantity, line.ticket_type_id],
      )
      for (let i = 0; i < line.quantity; i++) {
        const attendeeCode = `SCAN-${Math.random().toString(36).slice(2, 10).toUpperCase()}`
        await client.query(
          `insert into attendees (order_id, ticket_type_id, name, email, code)
           values ($1,$2,$3,$4,$5)`,
          [orderId, line.ticket_type_id, `Peserta ${i + 1}`, 'pending@local', attendeeCode],
        )
        attendees.push({ code: attendeeCode, ticket_type_id: line.ticket_type_id })
      }
    }

    await client.query('commit')
    return { order: order.rows[0], attendees }
  } catch (err) {
    await client.query('rollback').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/** Check-in hanya oleh organizer/event itu atau admin, dan hanya sekali. */
export async function checkIn(
  token: string | undefined | null,
  code: string,
  requireRole: (t: string | undefined | null, roles: string | string[]) => Promise<SafeUser>,
  getCurrentUser: (t: string | undefined | null) => Promise<SafeUser | null>,
) {
  const user = await getCurrentUser(token)
  if (!user) throw new Error('Silakan masuk terlebih dahulu.')
  const a = await query<{ id: number; event_id: number; checked_in_at: Date | null }>(
    `select a.id, e.id as event_id, a.checked_in_at
       from attendees a join orders o on o.id=a.order_id join events e on e.id=o.event_id
      where a.code=$1`,
    [code],
  )
  const row = a.rows[0]
  if (!row) throw new Error('Kode tiket tidak ditemukan.')
  if (row.checked_in_at) throw new Error('Tiket ini sudah check-in.')
  if (user.role !== 'admin') {
    if (user.role !== 'organizer') throw new Error('Hanya organizer yang bisa check-in.')
    const ev = await query<{ created_by: number | null }>(`select created_by from events where id=$1`, [row.event_id])
    if (ev.rows[0]?.created_by !== user.id) throw new Error('Anda tidak mengelola event ini.')
  }
  await query(`update attendees set checked_in_at=now() where id=$1 and checked_in_at is null`, [row.id])
  await query(`insert into ticket_scans (attendee_id, scanned_by) values ($1,$2)`, [row.id, user.id])
  return { ok: true, code }
}

export type TiketEvent = {
  id: number
  title: string
  slug: string
  description: string
  venue: string
  starts_at: Date | null
  status: string
}

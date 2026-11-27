/**
 * Skema database tiketing dalam format Drizzle ORM (PostgreSQL).
 *
 * File ini adalah kontrak/template skema: merepresentasikan tabel yang dibuat
 * secara idempoten oleh `ensureTiketSchema()` di src/lib/tiket.ts melalui tool
 * db_schema. Aplikasi berjalan memakai helper `query` (SQL berparameter),
 * jadi file ini tidak diimpor saat runtime — ia menjadi sumber kebenaran
 * bentuk tabel untuk generator/migrasi dan dokumentasi data model.
 *
 * Setara dengan pola repo Replit: shared/schema.ts + migrations/.
 */
import {
  pgEnum,
  pgTable,
  index,
  integer,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

export const eventStatusEnum = pgEnum('event_status', ['draft', 'published', 'cancelled'])
export const orderStatusEnum = pgEnum('order_status', ['pending', 'paid', 'failed', 'refunded'])

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name'),
  role: text('role'),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
})

export const events = pgTable('events', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  slug: text('slug').notNull().unique(),
  description: text('description').notNull().default(''),
  venue: text('venue').notNull().default(''),
  startsAt: timestamp('starts_at', { withTimezone: true }),
  status: eventStatusEnum('status').notNull().default('draft'),
  createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('events_status_idx').on(t.status, t.startsAt)])

export const ticketTypes = pgTable('ticket_types', {
  id: serial('id').primaryKey(),
  eventId: integer('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  priceCents: integer('price_cents').notNull(),
  quota: integer('quota').notNull(),
  sold: integer('sold').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('ticket_types_event_idx').on(t.eventId)])

export const orders = pgTable('orders', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  eventId: integer('event_id').notNull().references(() => events.id, { onDelete: 'restrict' }),
  code: text('code').notNull().unique(),
  status: orderStatusEnum('status').notNull().default('pending'),
  subtotalCents: integer('subtotal_cents').notNull(),
  discountCents: integer('discount_cents').notNull().default(0),
  totalCents: integer('total_cents').notNull(),
  promoCode: text('promo_code'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('orders_user_idx').on(t.userId, t.createdAt)])

export const orderItems = pgTable('order_items', {
  id: serial('id').primaryKey(),
  orderId: integer('order_id').notNull().references(() => orders.id, { onDelete: 'cascade' }),
  ticketTypeId: integer('ticket_type_id').notNull().references(() => ticketTypes.id, { onDelete: 'restrict' }),
  quantity: integer('quantity').notNull(),
  unitPriceCents: integer('unit_price_cents').notNull(),
}, (t) => [index('order_items_order_idx').on(t.orderId)])

export const attendees = pgTable('attendees', {
  id: serial('id').primaryKey(),
  orderId: integer('order_id').notNull().references(() => orders.id, { onDelete: 'cascade' }),
  ticketTypeId: integer('ticket_type_id').notNull().references(() => ticketTypes.id, { onDelete: 'restrict' }),
  name: text('name').notNull(),
  email: text('email').notNull(),
  code: text('code').notNull().unique(),
  checkedInAt: timestamp('checked_in_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('attendees_order_idx').on(t.orderId)])

export const ticketScans = pgTable('ticket_scans', {
  id: serial('id').primaryKey(),
  attendeeId: integer('attendee_id').notNull().references(() => attendees.id, { onDelete: 'cascade' }),
  scannedBy: integer('scanned_by').references(() => users.id, { onDelete: 'set null' }),
  scannedAt: timestamp('scanned_at', { withTimezone: true }).notNull().defaultNow(),
})

export const promoCodes = pgTable('promo_codes', {
  id: serial('id').primaryKey(),
  code: text('code').notNull().unique(),
  eventId: integer('event_id').references(() => events.id, { onDelete: 'cascade' }),
  percent: integer('percent').notNull(),
  maxUses: integer('max_uses').notNull().default(100),
  usedCount: integer('used_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('promo_codes_code_idx').on(t.code)])

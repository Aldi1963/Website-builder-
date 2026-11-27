-- Migrasi skema tiketing (idempoten, urutan bergantung).
-- Sumber kebenaran bentuk tabel: shared/schema.ts (Drizzle).
-- Aplikasi membuat tabel yang sama lewat ensureTiketSchema()/tool db_schema.

create table if not exists users (
  id serial primary key,
  email text not null unique,
  name text,
  role text,
  password_hash text not null,
  created_at timestamptz default now()
);

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
);
create index if not exists events_status_idx on events(status, starts_at);

create table if not exists ticket_types (
  id serial primary key,
  event_id integer not null references events(id) on delete cascade,
  name text not null,
  price_cents integer not null check (price_cents >= 0),
  quota integer not null check (quota >= 0),
  sold integer not null default 0 check (sold >= 0),
  created_at timestamptz not null default now()
);
create index if not exists ticket_types_event_idx on ticket_types(event_id);

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
);
create index if not exists orders_user_idx on orders(user_id, created_at desc);

create table if not exists order_items (
  id serial primary key,
  order_id integer not null references orders(id) on delete cascade,
  ticket_type_id integer not null references ticket_types(id) on delete restrict,
  quantity integer not null check (quantity > 0),
  unit_price_cents integer not null check (unit_price_cents >= 0)
);
create index if not exists order_items_order_idx on order_items(order_id);

create table if not exists attendees (
  id serial primary key,
  order_id integer not null references orders(id) on delete cascade,
  ticket_type_id integer not null references ticket_types(id) on delete restrict,
  name text not null,
  email text not null,
  code text not null unique,
  checked_in_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists attendees_order_idx on attendees(order_id);

create table if not exists ticket_scans (
  id serial primary key,
  attendee_id integer not null references attendees(id) on delete cascade,
  scanned_by integer references users(id) on delete set null,
  scanned_at timestamptz not null default now()
);

create table if not exists promo_codes (
  id serial primary key,
  code text not null unique,
  event_id integer references events(id) on delete cascade,
  percent integer not null check (percent > 0 and percent <= 100),
  max_uses integer not null default 100 check (max_uses > 0),
  used_count integer not null default 0 check (used_count >= 0),
  created_at timestamptz not null default now()
);

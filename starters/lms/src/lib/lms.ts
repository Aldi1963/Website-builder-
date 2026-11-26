import { query } from './db'

/**
 * Schema LMS: courses, lessons, enrollments, assignments, submissions,
 * discussions. Semua idempoten — aman dipanggil berulang dari bootstrap.
 */
export async function ensureLmsSchema(): Promise<void> {
  await query(`
    create table if not exists courses (
      id serial primary key,
      title text not null,
      slug text not null unique,
      description text default '',
      cover_url text,
      published boolean not null default true,
      created_by integer references users(id) on delete set null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `)

  await query(`
    create table if not exists lessons (
      id serial primary key,
      course_id integer not null references courses(id) on delete cascade,
      title text not null,
      content text not null default '',
      video_url text,
      position integer not null default 0,
      created_at timestamptz not null default now()
    )
  `)
  await query(`create index if not exists lessons_course_idx on lessons(course_id, position)`)

  await query(`
    create table if not exists enrollments (
      id serial primary key,
      user_id integer not null references users(id) on delete cascade,
      course_id integer not null references courses(id) on delete cascade,
      enrolled_at timestamptz not null default now(),
      unique (user_id, course_id)
    )
  `)
  await query(`create index if not exists enrollments_user_idx on enrollments(user_id)`)
  await query(`create index if not exists enrollments_course_idx on enrollments(course_id)`)

  await query(`
    create table if not exists lesson_progress (
      id serial primary key,
      user_id integer not null references users(id) on delete cascade,
      lesson_id integer not null references lessons(id) on delete cascade,
      completed_at timestamptz not null default now(),
      unique (user_id, lesson_id)
    )
  `)

  await query(`
    create table if not exists assignments (
      id serial primary key,
      course_id integer not null references courses(id) on delete cascade,
      title text not null,
      description text not null default '',
      due_at timestamptz,
      created_at timestamptz not null default now()
    )
  `)
  await query(`create index if not exists assignments_course_idx on assignments(course_id)`)

  await query(`
    create table if not exists submissions (
      id serial primary key,
      assignment_id integer not null references assignments(id) on delete cascade,
      user_id integer not null references users(id) on delete cascade,
      content text not null default '',
      attachment_url text,
      grade integer,
      feedback text,
      submitted_at timestamptz not null default now(),
      graded_at timestamptz,
      unique (assignment_id, user_id)
    )
  `)
  await query(`create index if not exists submissions_assignment_idx on submissions(assignment_id)`)

  await query(`
    create table if not exists discussions (
      id serial primary key,
      course_id integer not null references courses(id) on delete cascade,
      user_id integer not null references users(id) on delete cascade,
      body text not null,
      created_at timestamptz not null default now()
    )
  `)
  await query(`create index if not exists discussions_course_idx on discussions(course_id, created_at desc)`)
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'kursus'
}

export async function uniqueCourseSlug(title: string, excludeId?: number): Promise<string> {
  const base = slugify(title)
  let slug = base
  for (let i = 2; i < 200; i++) {
    const r = await query<{ id: number }>(
      `select id from courses where slug = $1 ${excludeId ? 'and id <> $2' : ''} limit 1`,
      excludeId ? [slug, excludeId] : [slug],
    )
    if (r.rows.length === 0) return slug
    slug = `${base}-${i}`
  }
  return `${base}-${Date.now()}`
}

import { query } from './db'
import { ensureAuthSchema, type SafeUser } from './auth'

/** Publication permits catalog discovery, never access to protected content. */
export async function coursePermissions(course: { id: number; created_by: number | null }, user: SafeUser | null) {
  const canManage = Boolean(user && (user.role === 'admin' || (user.role === 'guru' && course.created_by === user.id)))
  const enrolled = Boolean(user && (await query('select 1 from enrollments where course_id=$1 and user_id=$2', [course.id, user.id])).rows.length)
  return { canManage, enrolled, canViewContent: canManage || Boolean(user?.role === 'siswa' && enrolled) }
}

/**
 * Schema LMS: courses, lessons, enrollments, assignments, submissions,
 * discussions. Semua idempoten — aman dipanggil berulang dari bootstrap.
 * Tabel `users` dipastikan lebih dulu karena courses.created_by mereferensikannya.
 */
export async function ensureLmsSchema(): Promise<void> {
  await ensureAuthSchema()
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

  /* Kuis pilihan ganda: skor dihitung server-side, jawaban benar tak pernah
     dikirim ke klien sebelum submit. */
  await query(`
    create table if not exists quizzes (
      id serial primary key,
      course_id integer not null references courses(id) on delete cascade,
      title text not null,
      description text not null default '',
      created_at timestamptz not null default now()
    )
  `)
  await query(`create index if not exists quizzes_course_idx on quizzes(course_id)`)

  await query(`
    create table if not exists quiz_questions (
      id serial primary key,
      quiz_id integer not null references quizzes(id) on delete cascade,
      question text not null,
      position integer not null default 0
    )
  `)

  await query(`
    create table if not exists quiz_options (
      id serial primary key,
      question_id integer not null references quiz_questions(id) on delete cascade,
      option_text text not null,
      is_correct boolean not null default false,
      position integer not null default 0
    )
  `)

  await query(`
    create table if not exists quiz_attempts (
      id serial primary key,
      quiz_id integer not null references quizzes(id) on delete cascade,
      user_id integer not null references users(id) on delete cascade,
      score integer not null,
      total integer not null,
      answers jsonb not null default '{}'::jsonb,
      submitted_at timestamptz not null default now()
    )
  `)
  await query(`create index if not exists quiz_attempts_user_idx on quiz_attempts(user_id, quiz_id)`)
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

/* ---------- Kuis pilihan ganda ---------- */

export type QuizSummary = {
  id: number
  title: string
  description: string
  question_count: number
  last_score: number | null
  last_total: number | null
  attempted_at: string | null
}

/** Daftar kuis sebuah kursus + hasil terakhir user (null bila belum pernah). */
export async function listQuizzes(courseId: number, userId: number | null): Promise<QuizSummary[]> {
  return (
    await query<QuizSummary>(
      `select q.id, q.title, q.description,
              (select count(*)::int from quiz_questions qq where qq.quiz_id=q.id) as question_count,
              a.score as last_score, a.total as last_total, a.submitted_at as attempted_at
         from quizzes q
         left join lateral (
           select score, total, submitted_at from quiz_attempts
            where quiz_id=q.id and user_id=$2
            order by submitted_at desc limit 1
         ) a on true
        where q.course_id=$1
        order by q.id`,
      [courseId, userId ?? 0],
    )
  ).rows
}

export type QuizQuestionForStudent = { id: number; question: string; options: { id: number; text: string }[] }

/** Soal + opsi tanpa membocorkan kunci jawaban. */
export async function quizForAttempt(quizId: number): Promise<QuizQuestionForStudent[]> {
  const qs = (
    await query<{ id: number; question: string }>(
      `select id, question from quiz_questions where quiz_id=$1 order by position, id`,
      [quizId],
    )
  ).rows
  if (!qs.length) return []
  const opts = (
    await query<{ id: number; question_id: number; option_text: string }>(
      `select o.id, o.question_id, o.option_text
         from quiz_options o join quiz_questions q on q.id=o.question_id
        where q.quiz_id=$1 order by o.position, o.id`,
      [quizId],
    )
  ).rows
  return qs.map((q) => ({
    id: q.id,
    question: q.question,
    options: opts.filter((o) => o.question_id === q.id).map((o) => ({ id: o.id, text: o.option_text })),
  }))
}

/** Hitung skor dari jawaban {questionId: optionId} — kunci jawaban tetap di server. */
export async function scoreQuiz(
  quizId: number,
  answers: Record<string, number>,
): Promise<{ score: number; total: number; detail: { questionId: number; correct: boolean }[] }> {
  const rows = (
    await query<{ question_id: number; correct_option: number | null }>(
      `select q.id as question_id,
              (select o.id from quiz_options o where o.question_id=q.id and o.is_correct order by o.id limit 1) as correct_option
         from quiz_questions q where q.quiz_id=$1`,
      [quizId],
    )
  ).rows
  const detail = rows.map((r) => ({
    questionId: r.question_id,
    correct: r.correct_option != null && Number(answers[String(r.question_id)]) === r.correct_option,
  }))
  return { score: detail.filter((d) => d.correct).length, total: rows.length, detail }
}

export async function createQuiz(courseId: number, title: string, description: string): Promise<number> {
  const r = await query<{ id: number }>(
    `insert into quizzes (course_id, title, description) values ($1,$2,$3) returning id`,
    [courseId, title.trim(), description.trim()],
  )
  return r.rows[0].id
}

export async function deleteQuiz(quizId: number): Promise<void> {
  await query(`delete from quizzes where id=$1`, [quizId])
}

export async function addQuizQuestion(
  quizId: number,
  question: string,
  options: { text: string; correct: boolean }[],
): Promise<void> {
  const pos = (await query<{ n: number }>(`select coalesce(max(position),-1)+1 as n from quiz_questions where quiz_id=$1`, [quizId])).rows[0].n
  const q = await query<{ id: number }>(
    `insert into quiz_questions (quiz_id, question, position) values ($1,$2,$3) returning id`,
    [quizId, question.trim(), pos],
  )
  const questionId = q.rows[0].id
  for (let i = 0; i < options.length; i++) {
    const o = options[i]
    await query(
      `insert into quiz_options (question_id, option_text, is_correct, position) values ($1,$2,$3,$4)`,
      [questionId, o.text.trim(), o.correct, i],
    )
  }
}

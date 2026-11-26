import { useState } from 'react'
import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { getCookie } from '@tanstack/react-start/server'
import { query } from '~/lib/db'
import { getCurrentUser, AUTH_COOKIE_NAME } from '~/lib/auth'
import { ensureLmsSchema } from '~/lib/lms'

type Lesson = { id: number; title: string; content: string; video_url: string | null; position: number; done: boolean }
type Assignment = { id: number; title: string; description: string; due_at: string | null }
type Discussion = { id: number; body: string; user_name: string; created_at: string }
type GradeItem = { assignment_id: number; title: string; grade: number | null; feedback: string | null; content: string }
type Detail = {
  course: { id: number; title: string; description: string; slug: string; published: boolean }
  lessons: Lesson[]
  assignments: Assignment[]
  discussions: Discussion[]
  user: { id: number; role: string | null; name: string | null; email: string } | null
  enrolled: boolean
  progress: number
  myGrades: GradeItem[]
}

const loadCourse = createServerFn({ method: 'GET' })
  .validator((input: { slug: string }) => input)
  .handler(async ({ data }): Promise<Detail> => {
    await ensureLmsSchema()
    const token = getCookie(AUTH_COOKIE_NAME)
    const user = await getCurrentUser(token)
    const r = await query<Detail['course']>(
      `select id, title, description, slug, published from courses where slug=$1`,
      [data.slug],
    )
    const course = r.rows[0]
    if (!course) throw new Error('Kursus tidak ditemukan.')
    if (!course.published && user?.role !== 'admin' && user?.role !== 'guru') {
      throw new Error('Kursus ini belum diterbitkan.')
    }

    const access = user ? await requireCourseAccess({ data: { slug: data.slug } }) : { ok: false }
    const canViewContent = Boolean(user && (user.role === 'admin' || user.role === 'guru' || access.ok))

    const lessons = canViewContent
      ? (
          await query<Lesson>(
            `select l.id, l.title, l.content, l.video_url, l.position,
                    exists(select 1 from lesson_progress lp where lp.lesson_id=l.id and lp.user_id=$2) as done
               from lessons l where l.course_id=$1 order by l.position, l.id`,
            [course.id, user!.id],
          )
        ).rows
      : []

    const assignments = canViewContent
      ? (
          await query<Assignment>(
            `select id, title, description, due_at from assignments where course_id=$1 order by id`,
            [course.id],
          )
        ).rows
      : []

    const discussions = canViewContent
      ? (
          await query<Discussion>(
            `select d.id, d.body, coalesce(u.name,u.email) as user_name, d.created_at
               from discussions d join users u on u.id=d.user_id
              where d.course_id=$1 order by d.created_at desc limit 30`,
            [course.id],
          )
        ).rows
      : []

    const enrolled = user
      ? Boolean((await query(`select 1 from enrollments where user_id=$1 and course_id=$2`, [user.id, course.id])).rows.length)
      : false

    const doneCount = lessons.filter((l) => l.done).length
    const progress = enrolled && lessons.length ? Math.round((doneCount / lessons.length) * 100) : 0

    const myGrades = enrolled
      ? (
          await query<GradeItem>(
            `select a.id as assignment_id, a.title, s.grade, s.feedback, s.content
               from submissions s join assignments a on a.id=s.assignment_id
              where s.user_id=$1 and a.course_id=$2`,
            [user!.id, course.id],
          )
        ).rows
      : []

    return { course, lessons, assignments, discussions, user, enrolled, progress, myGrades }
  })

const requireCourseAccess = createServerFn({ method: 'POST' })
  .validator((input: { slug: string }) => input)
  .handler(async ({ data }) => {
    const user = await getCurrentUser(getCookie(AUTH_COOKIE_NAME))
    if (!user) return { ok: false }
    const access = await query(
      `select 1 from courses c where c.slug=$1 and (c.created_by=$2 or c.published = true or exists(select 1 from enrollments e where e.course_id=c.id and e.user_id=$2))`,
      [data.slug, user.id],
    )
    return { ok: Boolean(access.rows.length) }
  })

const enroll = createServerFn({ method: 'POST' })
  .validator((input: { slug: string }) => input)
  .handler(async ({ data }) => {
    const token = getCookie(AUTH_COOKIE_NAME)
    const user = await getCurrentUser(token)
    if (!user) throw new Error('Silakan masuk terlebih dahulu.')
    const c = (await query<{ id: number }>(`select id from courses where slug=$1 and published=true`, [data.slug])).rows[0]
    if (!c) throw new Error('Kursus tidak ditemukan atau belum diterbitkan.')
    await query(`insert into enrollments (user_id, course_id) values ($1,$2) on conflict do nothing`, [user.id, c.id])
    return { ok: true }
  })

const completeLesson = createServerFn({ method: 'POST' })
  .validator((input: { lessonId: number }) => input)
  .handler(async ({ data }) => {
    const user = await getCurrentUser(getCookie(AUTH_COOKIE_NAME))
    if (!user) throw new Error('Silakan masuk terlebih dahulu.')
    const allowed = await query(
      `select 1 from lessons l join enrollments e on e.course_id=l.course_id where l.id=$1 and e.user_id=$2`,
      [data.lessonId, user.id],
    )
    if (!allowed.rows.length) throw new Error('Kamu belum terdaftar di kursus ini.')
    await query(`insert into lesson_progress (user_id, lesson_id) values ($1,$2) on conflict do nothing`, [user.id, data.lessonId])
    return { ok: true }
  })

const submitAssignment = createServerFn({ method: 'POST' })
  .validator((input: { assignmentId: number; content: string }) => input)
  .handler(async ({ data }) => {
    const token = getCookie(AUTH_COOKIE_NAME)
    const user = await getCurrentUser(token)
    if (!user) throw new Error('Silakan masuk terlebih dahulu.')
    if (data.content.trim().length < 3) throw new Error('Jawaban terlalu singkat.')
    const allowed = await query(
      `select 1 from assignments a join enrollments e on e.course_id=a.course_id where a.id=$1 and e.user_id=$2`,
      [data.assignmentId, user.id],
    )
    if (!allowed.rows.length) throw new Error('Kamu belum terdaftar di kursus ini.')
    await query(
      `insert into submissions (assignment_id, user_id, content) values ($1,$2,$3)
       on conflict (assignment_id, user_id) do update set content=excluded.content, submitted_at=now(), grade=null, feedback=null`,
      [data.assignmentId, user.id, data.content.trim()],
    )
    return { ok: true }
  })

const postDiscussion = createServerFn({ method: 'POST' })
  .validator((input: { slug: string; body: string }) => input)
  .handler(async ({ data }) => {
    const token = getCookie(AUTH_COOKIE_NAME)
    const user = await getCurrentUser(token)
    if (!user) throw new Error('Silakan masuk terlebih dahulu.')
    if (data.body.trim().length < 2) throw new Error('Pesan kosong.')
    const c = (await query<{ id: number }>(`select id from courses where slug=$1`, [data.slug])).rows[0]
    if (!c) throw new Error('Kursus tidak ditemukan.')
    await query(`insert into discussions (course_id, user_id, body) values ($1,$2,$3)`, [
      c.id,
      user.id,
      data.body.trim().slice(0, 2000),
    ])
    return { ok: true }
  })

export const Route = createFileRoute('/courses/$slug')({
  loader: ({ params }) => loadCourse({ data: { slug: params.slug } }),
  component: CoursePage,
})

function CoursePage() {
  const data = Route.useLoaderData()
  const router = useRouter()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [answer, setAnswer] = useState<Record<number, string>>({})
  const [message, setMessage] = useState('')

  async function act(fn: () => Promise<unknown>) {
    setBusy(true)
    setError('')
    try {
      await fn()
      await router.invalidate()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const canManage = data.user && (data.user.role === 'admin' || data.user.role === 'guru')

  return (
    <main className="min-h-dvh">
      <header className="border-b border-white/10 bg-slate-950/70 backdrop-blur">
        <div className="container-page flex items-center justify-between py-4">
          <Link to="/" className="font-bold text-white">← Akademi</Link>
          <div className="flex items-center gap-2">
            {data.user && <Link to="/dashboard" className="btn-ghost text-xs">Dashboard</Link>}
            <span className="badge capitalize">{data.user?.role || 'tamu'}</span>
          </div>
        </div>
      </header>
      <section className="container-page py-10">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <h1 className="text-3xl font-bold text-white">{data.course.title}</h1>
            <p className="mt-2 text-slate-400">{data.course.description}</p>
          </div>
          <div className="flex flex-col items-end gap-2">
            {!data.enrolled && data.user && (
              <button className="btn-primary" disabled={busy} onClick={() => act(() => enroll({ data: { slug: data.course.slug } }))}>
                Daftar kursus
              </button>
            )}
            {!data.user && <Link to="/login" className="btn-primary">Masuk untuk mendaftar</Link>}
            {canManage && (
              <Link to="/courses/$slug/manage" params={{ slug: data.course.slug }} className="btn-ghost text-sm">
                Kelola konten →
              </Link>
            )}
            {data.enrolled && (
              <span className="badge border-emerald-400/30 bg-emerald-400/10 text-emerald-300">
                Progres {data.progress}%
              </span>
            )}
          </div>
        </div>
        {error && <p className="mt-4 rounded-xl border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-300">{error}</p>}

        {!data.enrolled && !canManage && <p className="mt-6 rounded-xl border border-emerald-400/20 bg-emerald-400/5 p-4 text-sm text-slate-300">Daftar di kursus ini untuk membuka materi, tugas, progres, dan diskusi.</p>}
        <div className="mt-10 grid gap-8 lg:grid-cols-[1.6fr_1fr]">
          <div>
            <h2 className="text-xl font-semibold text-white">Materi</h2>
            {data.lessons.length === 0 && <p className="mt-3 text-sm text-slate-400">Belum ada materi.</p>}
            <div className="mt-4 space-y-3">
              {data.lessons.map((l) => (
                <article key={l.id} className="card p-5">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="font-semibold text-white">
                      {l.position + 1}. {l.title}
                    </h3>
                    {data.enrolled && (
                      l.done ? (
                        <span className="badge border-emerald-400/30 bg-emerald-400/10 text-emerald-300">Selesai</span>
                      ) : (
                        <button
                          className="text-xs text-emerald-300 underline"
                          disabled={busy}
                          onClick={() => act(() => completeLesson({ data: { lessonId: l.id } }))}
                        >
                          Tandai selesai
                        </button>
                      )
                    )}
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-slate-300">{l.content}</p>
                  {l.video_url && (
                    <a href={l.video_url} target="_blank" rel="noreferrer" className="mt-2 inline-block text-sm text-emerald-300 underline">
                      Tonton video ↗
                    </a>
                  )}
                </article>
              ))}
            </div>

            <h2 className="mt-10 text-xl font-semibold text-white">Tugas</h2>
            {data.assignments.length === 0 && <p className="mt-3 text-sm text-slate-400">Belum ada tugas.</p>}
            <div className="mt-4 space-y-4">
              {data.assignments.map((a) => {
                const sub = data.myGrades.find((g) => g.assignment_id === a.id)
                return (
                  <article key={a.id} className="card p-5">
                    <div className="flex justify-between gap-3">
                      <h3 className="font-semibold text-white">{a.title}</h3>
                      {sub?.grade != null ? (
                        <span className="badge border-emerald-400/30 text-emerald-300">Nilai {sub.grade}</span>
                      ) : sub ? (
                        <span className="badge">Dikumpulkan</span>
                      ) : null}
                    </div>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-slate-400">{a.description}</p>
                    {a.due_at && (
                      <p className="mt-1 text-xs text-slate-500">Batas: {new Date(a.due_at).toLocaleString('id-ID')}</p>
                    )}
                    {sub?.feedback && (
                      <p className="mt-2 rounded-lg bg-white/5 p-3 text-sm text-slate-300">Catatan guru: {sub.feedback}</p>
                    )}
                    {data.enrolled && (
                      <div className="mt-3 flex gap-2">
                        <textarea
                          className="input"
                          rows={3}
                          placeholder={sub ? `Jawaban terkumpul: ${sub.content}` : 'Tulis jawaban…'}
                          value={answer[a.id] ?? ''}
                          onInput={(e) => setAnswer((s) => ({ ...s, [a.id]: (e.target as HTMLTextAreaElement).value }))}
                        />
                        <button
                          className="btn-primary self-start"
                          disabled={busy || (answer[a.id] ?? '').trim().length < 3}
                          onClick={() => act(() => submitAssignment({ data: { assignmentId: a.id, content: answer[a.id] ?? '' } }))}
                        >
                          {sub ? 'Perbarui' : 'Kumpulkan'}
                        </button>
                      </div>
                    )}
                  </article>
                )
              })}
            </div>
          </div>

          <aside>
            <h2 className="text-xl font-semibold text-white">Diskusi</h2>
            {data.user && (
              <form
                className="mt-4 flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  void act(() => postDiscussion({ data: { slug: data.course.slug, body: message } })).then(() => setMessage(''))
                }}
              >
                <input
                  className="input"
                  placeholder="Tulis pertanyaan…"
                  value={message}
                  onInput={(e) => setMessage((e.target as HTMLInputElement).value)}
                />
                <button className="btn-primary" disabled={busy || message.trim().length < 2}>
                  Kirim
                </button>
              </form>
            )}
            <div className="mt-4 space-y-3">
              {data.discussions.length === 0 && <p className="text-sm text-slate-400">Belum ada diskusi.</p>}
              {data.discussions.map((d) => (
                <div key={d.id} className="card p-4">
                  <p className="text-sm text-slate-200">{d.body}</p>
                  <p className="mt-2 text-xs text-slate-500">
                    {d.user_name} · {new Date(d.created_at).toLocaleString('id-ID')}
                  </p>
                </div>
              ))}
            </div>

            {data.enrolled && (
              <div className="card mt-6 p-5">
                <h2 className="font-semibold text-white">Nilai saya</h2>
                {data.myGrades.length === 0 ? (
                  <p className="mt-2 text-sm text-slate-400">Belum ada tugas dikumpulkan.</p>
                ) : (
                  <ul className="mt-3 space-y-2 text-sm">
                    {data.myGrades.map((g, i) => (
                      <li key={i} className="flex justify-between text-slate-300">
                        <span>{g.title}</span>
                        <span>{g.grade ?? 'menunggu'}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </aside>
        </div>
      </section>
    </main>
  )
}

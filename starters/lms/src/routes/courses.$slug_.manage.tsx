import { useState, type FormEvent } from 'react'
import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { getCookie } from '@tanstack/react-start/server'
import { query } from '~/lib/db'
import { requireRole, AUTH_COOKIE_NAME } from '~/lib/auth'
import { ensureLmsSchema, createQuiz, deleteQuiz, addQuizQuestion } from '~/lib/lms'

type ManageData = {
  course: { id: number; title: string; slug: string; description: string; published: boolean }
  lessons: { id: number; title: string; position: number }[]
  assignments: { id: number; title: string; due_at: string | null }[]
  submissions: { id: number; assignment_title: string; user_name: string; grade: number | null; submitted_at: string }[]
  quizzes: { id: number; title: string; question_count: number }[]
}

const loadManage = createServerFn({ method: 'GET' })
  .validator((input: { slug: string }) => input)
  .handler(async ({ data }): Promise<ManageData> => {
    await ensureLmsSchema()
    const manager = await requireRole(getCookie(AUTH_COOKIE_NAME), ['admin', 'guru'])
    const c = (await query<ManageData['course']>(
      `select id, title, slug, description, published from courses where slug=$1 and ($2='admin' or created_by=$3)`,
      [data.slug, manager.role, manager.id],
    )).rows[0]
    if (!c) throw new Error('Kursus tidak ditemukan atau bukan milikmu.')
    const lessons = (await query<ManageData['lessons'][number]>(
      `select id, title, position from lessons where course_id=$1 order by position, id`,
      [c.id],
    )).rows
    const assignments = (await query<ManageData['assignments'][number]>(
      `select id, title, due_at from assignments where course_id=$1 order by id`,
      [c.id],
    )).rows
    const submissions = (await query<ManageData['submissions'][number]>(
      `select s.id, a.title as assignment_title, coalesce(u.name,u.email) as user_name, s.grade, s.submitted_at
         from submissions s
         join assignments a on a.id=s.assignment_id
         join users u on u.id=s.user_id
        where a.course_id=$1
        order by s.submitted_at desc limit 50`,
      [c.id],
    )).rows;

    const quizzes = (await query<ManageData['quizzes'][number]>(
      `select q.id, q.title,
              (select count(*)::int from quiz_questions qq where qq.quiz_id=q.id) as question_count
         from quizzes q where q.course_id=$1 order by q.id`,
      [c.id],
    )).rows

    return { course: c, lessons, assignments, submissions, quizzes }
  })

async function requireManageableCourse(courseId: number) {
  const user = await requireRole(getCookie(AUTH_COOKIE_NAME), ['admin', 'guru'])
  const r = await query<{ id: number }>(
    `select id from courses where id=$1 and ($2::text='admin' or created_by=$3)`,
    [courseId, user.role, user.id],
  )
  if (!r.rows.length) throw new Error('Kursus tidak ditemukan atau bukan milikmu.')
  return user
}

const togglePublish = createServerFn({ method: 'POST' })
  .validator((input: { courseId: number; published: boolean }) => input)
  .handler(async ({ data }) => {
    await requireManageableCourse(data.courseId)
    await query(`update courses set published=$1, updated_at=now() where id=$2`, [data.published, data.courseId])
    return { ok: true }
  })

const addLesson = createServerFn({ method: 'POST' })
  .validator((input: { courseId: number; title: string; content: string; videoUrl?: string }) => input)
  .handler(async ({ data }) => {
    await requireManageableCourse(data.courseId)
    if (!/^https:\/\//i.test(data.videoUrl ?? '') && data.videoUrl?.trim()) throw new Error('URL video harus https.')
    if (data.title.trim().length < 2) throw new Error('Judul materi minimal 2 karakter.')
    const pos = (await query<{ n: number }>(`select coalesce(max(position), -1) + 1 as n from lessons where course_id=$1`, [data.courseId])).rows[0]?.n ?? 0
    await query(
      `insert into lessons (course_id, title, content, video_url, position) values ($1,$2,$3,$4,$5)`,
      [data.courseId, data.title.trim(), data.content.trim(), data.videoUrl?.trim() || null, pos],
    )
    return { ok: true }
  })

const deleteLesson = createServerFn({ method: 'POST' })
  .validator((input: { lessonId: number }) => input)
  .handler(async ({ data }) => {
    const manager = await requireRole(getCookie(AUTH_COOKIE_NAME), ['admin', 'guru'])
    const r = await query(`delete from lessons l using courses c where l.id=$1 and c.id=l.course_id and ($2::text='admin' or c.created_by=$3)`, [data.lessonId, manager.role, manager.id])
    if (!r.rowCount) throw new Error('Materi tidak ditemukan atau bukan milikmu.')
    return { ok: true }
  })

const addAssignment = createServerFn({ method: 'POST' })
  .validator((input: { courseId: number; title: string; description: string }) => input)
  .handler(async ({ data }) => {
    await requireManageableCourse(data.courseId)
    if (data.title.trim().length < 2) throw new Error('Judul tugas minimal 2 karakter.')
    await query(
      `insert into assignments (course_id, title, description) values ($1,$2,$3)`,
      [data.courseId, data.title.trim(), data.description.trim()],
    )
    return { ok: true }
  })

const addQuiz = createServerFn({ method: 'POST' })
  .validator((input: { courseId: number; title: string; description?: string }) => input)
  .handler(async ({ data }) => {
    await requireManageableCourse(data.courseId)
    if (data.title.trim().length < 3) throw new Error('Judul kuis minimal 3 karakter.')
    const id = await createQuiz(data.courseId, data.title, data.description ?? '')
    return { ok: true, id }
  })

const deleteQuizFn = createServerFn({ method: 'POST' })
  .validator((input: { quizId: number }) => input)
  .handler(async ({ data }) => {
    const manager = await requireRole(getCookie(AUTH_COOKIE_NAME), ['admin', 'guru'])
    const r = await query(
      `select q.id from quizzes q join courses c on c.id=q.course_id
        where q.id=$1 and ($2::text='admin' or c.created_by=$3)`,
      [data.quizId, manager.role, manager.id],
    )
    if (!r.rows.length) throw new Error('Kuis tidak ditemukan atau bukan milikmu.')
    await deleteQuiz(data.quizId)
    return { ok: true }
  })

const addQuestion = createServerFn({ method: 'POST' })
  .validator((input: { quizId: number; question: string; options: { text: string; correct: boolean }[] }) => input)
  .handler(async ({ data }) => {
    const manager = await requireRole(getCookie(AUTH_COOKIE_NAME), ['admin', 'guru'])
    const owned = await query(
      `select q.id from quizzes q join courses c on c.id=q.course_id
        where q.id=$1 and ($2::text='admin' or c.created_by=$3)`,
      [data.quizId, manager.role, manager.id],
    )
    if (!owned.rows.length) throw new Error('Kuis tidak ditemukan atau bukan milikmu.')
    if (data.question.trim().length < 5) throw new Error('Pertanyaan minimal 5 karakter.')
    const opts = data.options.map((o) => ({ text: o.text.trim(), correct: Boolean(o.correct) })).filter((o) => o.text.length > 0)
    if (opts.length < 2) throw new Error('Isi minimal 2 pilihan jawaban.')
    if (opts.filter((o) => o.correct).length !== 1) throw new Error('Tandai tepat satu jawaban benar.')
    await addQuizQuestion(data.quizId, data.question, opts)
    return { ok: true }
  })

export const Route = createFileRoute('/courses/$slug_/manage')({
  loader: ({ params }) => loadManage({ data: { slug: params.slug } }),
  component: ManageCoursePage,
})

function ManageCoursePage() {
  const data = Route.useLoaderData()
  const router = useRouter()
  const [lTitle, setLTitle] = useState('')
  const [lContent, setLContent] = useState('')
  const [lVideo, setLVideo] = useState('')
  const [aTitle, setATitle] = useState('')
  const [aDesc, setADesc] = useState('')
  const [qTitle, setQTitle] = useState('')
  const [qDesc, setQDesc] = useState('')
  const [quizId, setQuizId] = useState<string>(data.quizzes[0] ? String(data.quizzes[0].id) : '')
  const [qText, setQText] = useState('')
  const [qOpts, setQOpts] = useState<string[]>(['', '', '', ''])
  const [qCorrect, setQCorrect] = useState(0)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

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

  return (
    <main className="min-h-dvh">
      <header className="border-b border-edge bg-surface/90 backdrop-blur">
        <div className="container-page flex items-center justify-between py-4">
          <Link to="/courses/$slug" params={{ slug: data.course.slug }} className="font-bold text-ink">
            ← {data.course.title}
          </Link>
          <button
            className="btn-ghost text-xs"
            disabled={busy}
            onClick={() => act(() => togglePublish({ data: { courseId: data.course.id, published: !data.course.published } }))}
          >
            {data.course.published ? 'Jadikan Draft' : 'Terbitkan Kursus'}
          </button>
        </div>
      </header>

      <section className="container-page py-10">
        <h1 className="text-2xl font-bold text-ink">Kelola Konten Kursus</h1>
        {error && <p className="mt-4 rounded-xl border border-danger/30 bg-danger/10 p-3 text-sm text-danger">{error}</p>}

        <div className="mt-8 grid gap-8 lg:grid-cols-2">
          <form
            className="card p-5"
            onSubmit={(e: FormEvent) => {
              e.preventDefault()
              void act(() => addLesson({ data: { courseId: data.course.id, title: lTitle, content: lContent, videoUrl: lVideo } })).then(() => {
                setLTitle('')
                setLContent('')
                setLVideo('')
              })
            }}
          >
            <h2 className="font-semibold text-ink">Tambah Materi</h2>
            <div className="mt-4 space-y-3">
              <input className="input" placeholder="Judul materi" value={lTitle} onInput={(e) => setLTitle((e.target as HTMLInputElement).value)} />
              <textarea className="input" rows={4} placeholder="Isi materi…" value={lContent} onInput={(e) => setLContent((e.target as HTMLTextAreaElement).value)} />
              <input className="input" placeholder="URL Video (opsional)" value={lVideo} onInput={(e) => setLVideo((e.target as HTMLInputElement).value)} />
              <button className="btn-primary" disabled={busy || lTitle.trim().length < 2}>Simpan materi</button>
            </div>
          </form>

          <form
            className="card p-5"
            onSubmit={(e: FormEvent) => {
              e.preventDefault()
              void act(() => addAssignment({ data: { courseId: data.course.id, title: aTitle, description: aDesc } })).then(() => {
                setATitle('')
                setADesc('')
              })
            }}
          >
            <h2 className="font-semibold text-ink">Tambah Tugas</h2>
            <div className="mt-4 space-y-3">
              <input className="input" placeholder="Judul tugas" value={aTitle} onInput={(e) => setATitle((e.target as HTMLInputElement).value)} />
              <textarea className="input" rows={4} placeholder="Instruksi tugas…" value={aDesc} onInput={(e) => setADesc((e.target as HTMLTextAreaElement).value)} />
              <button className="btn-primary" disabled={busy || aTitle.trim().length < 2}>Simpan tugas</button>
            </div>
          </form>
        </div>

        <div className="mt-8 grid gap-8 lg:grid-cols-2">
          <form
            className="card p-5"
            onSubmit={(e: FormEvent) => {
              e.preventDefault()
              void act(() => addQuiz({ data: { courseId: data.course.id, title: qTitle, description: qDesc } })).then(() => {
                setQTitle('')
                setQDesc('')
              })
            }}
          >
            <h2 className="font-semibold text-ink">Buat Kuis</h2>
            <p className="mt-1 text-xs text-muted">Skor dihitung otomatis saat siswa mengumpulkan.</p>
            <div className="mt-4 space-y-3">
              <input className="input" placeholder="Judul kuis" value={qTitle} onInput={(e) => setQTitle((e.target as HTMLInputElement).value)} />
              <input className="input" placeholder="Deskripsi singkat (opsional)" value={qDesc} onInput={(e) => setQDesc((e.target as HTMLInputElement).value)} />
              <button className="btn-primary" disabled={busy || qTitle.trim().length < 3}>Simpan kuis</button>
            </div>
          </form>

          <form
            className="card p-5"
            onSubmit={(e: FormEvent) => {
              e.preventDefault()
              if (!quizId) return
              void act(() =>
                addQuestion({
                  data: {
                    quizId: Number(quizId),
                    question: qText,
                    options: qOpts.map((text, i) => ({ text, correct: i === qCorrect })),
                  },
                }),
              ).then(() => {
                setQText('')
                setQOpts(['', '', '', ''])
                setQCorrect(0)
              })
            }}
          >
            <h2 className="font-semibold text-ink">Tambah Soal</h2>
            <div className="mt-4 space-y-3">
              <select className="input" value={quizId} onChange={(e) => setQuizId((e.target as HTMLSelectElement).value)} aria-label="Pilih kuis">
                <option value="">Pilih kuis…</option>
                {data.quizzes.map((q) => (
                  <option key={q.id} value={q.id}>
                    {q.title}
                  </option>
                ))}
              </select>
              <input className="input" placeholder="Pertanyaan" value={qText} onInput={(e) => setQText((e.target as HTMLInputElement).value)} />
              <p className="text-xs text-muted">Tandai satu jawaban benar:</p>
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="flex items-center gap-3">
                  <input
                    type="radio"
                    name="jawaban-benar"
                    className="h-4 w-4 accent-emerald-400"
                    checked={qCorrect === i}
                    onChange={() => setQCorrect(i)}
                    aria-label={`Pilihan ${i + 1} adalah jawaban benar`}
                  />
                  <input
                    className="input"
                    placeholder={`Pilihan ${i + 1}`}
                    value={qOpts[i]}
                    onInput={(e) => {
                      const v = (e.target as HTMLInputElement).value
                      setQOpts((prev) => prev.map((o, idx) => (idx === i ? v : o)))
                    }}
                  />
                </div>
              ))}
              <button className="btn-primary" disabled={busy || !quizId || qText.trim().length < 5}>Simpan soal</button>
            </div>
          </form>
        </div>

        <div className="card mt-8 p-5">
          <h2 className="font-semibold text-ink">Daftar Kuis ({data.quizzes.length})</h2>
          {data.quizzes.length === 0 ? (
            <p className="mt-3 text-sm text-muted">Belum ada kuis. Buat kuis dulu, lalu tambahkan soalnya.</p>
          ) : (
            <ul className="mt-3 divide-y divide-edge text-sm">
              {data.quizzes.map((q) => (
                <li key={q.id} className="flex items-center justify-between py-2.5">
                  <span className="text-ink">
                    {q.title} <span className="text-muted">· {q.question_count} soal</span>
                  </span>
                  <button className="text-xs text-danger underline" disabled={busy} onClick={() => act(() => deleteQuizFn({ data: { quizId: q.id } }))}>
                    Hapus
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-8 grid gap-8 lg:grid-cols-2">
          <div className="card p-5">
            <h2 className="font-semibold text-ink">Daftar Materi ({data.lessons.length})</h2>
            <ul className="mt-3 divide-y divide-edge text-sm">
              {data.lessons.map((l) => (
                <li key={l.id} className="flex items-center justify-between py-2.5">
                  <span className="text-ink">{l.position + 1}. {l.title}</span>
                  <button className="text-xs text-danger underline" disabled={busy} onClick={() => act(() => deleteLesson({ data: { lessonId: l.id } }))}>
                    Hapus
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="card p-5">
            <h2 className="font-semibold text-ink">Pengumpulan Tugas ({data.submissions.length})</h2>
            <ul className="mt-3 divide-y divide-edge text-sm">
              {data.submissions.map((s) => (
                <li key={s.id} className="flex items-center justify-between py-2.5">
                  <span className="text-muted">{s.assignment_title} — <span className="text-muted">{s.user_name}</span></span>
                  <Link
                    to="/courses/$slug/grade/$submissionId"
                    params={{ slug: data.course.slug, submissionId: String(s.id) }}
                    className="text-emerald-700 underline"
                  >
                    {s.grade == null ? 'Nilai' : `Nilai: ${s.grade}`}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>
    </main>
  )
}

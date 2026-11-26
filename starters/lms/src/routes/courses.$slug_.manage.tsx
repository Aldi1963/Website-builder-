import { useState, type FormEvent } from 'react'
import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { getCookie } from '@tanstack/react-start/server'
import { query } from '~/lib/db'
import { requireRole, AUTH_COOKIE_NAME } from '~/lib/auth'
import { ensureLmsSchema } from '~/lib/lms'

type ManageData = {
  course: { id: number; title: string; slug: string; description: string; published: boolean }
  lessons: { id: number; title: string; position: number }[]
  assignments: { id: number; title: string; due_at: string | null }[]
  submissions: { id: number; assignment_title: string; user_name: string; grade: number | null; submitted_at: string }[]
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

    return { course: c, lessons, assignments, submissions }
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
      <header className="border-b border-white/10 bg-slate-950/70 backdrop-blur">
        <div className="container-page flex items-center justify-between py-4">
          <Link to="/courses/$slug" params={{ slug: data.course.slug }} className="font-bold text-white">
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
        <h1 className="text-2xl font-bold text-white">Kelola Konten Kursus</h1>
        {error && <p className="mt-4 rounded-xl border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-300">{error}</p>}

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
            <h2 className="font-semibold text-white">Tambah Materi</h2>
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
            <h2 className="font-semibold text-white">Tambah Tugas</h2>
            <div className="mt-4 space-y-3">
              <input className="input" placeholder="Judul tugas" value={aTitle} onInput={(e) => setATitle((e.target as HTMLInputElement).value)} />
              <textarea className="input" rows={4} placeholder="Instruksi tugas…" value={aDesc} onInput={(e) => setADesc((e.target as HTMLTextAreaElement).value)} />
              <button className="btn-primary" disabled={busy || aTitle.trim().length < 2}>Simpan tugas</button>
            </div>
          </form>
        </div>

        <div className="mt-8 grid gap-8 lg:grid-cols-2">
          <div className="card p-5">
            <h2 className="font-semibold text-white">Daftar Materi ({data.lessons.length})</h2>
            <ul className="mt-3 divide-y divide-white/10 text-sm">
              {data.lessons.map((l) => (
                <li key={l.id} className="flex items-center justify-between py-2.5">
                  <span className="text-slate-200">{l.position + 1}. {l.title}</span>
                  <button className="text-xs text-red-400 underline" disabled={busy} onClick={() => act(() => deleteLesson({ data: { lessonId: l.id } }))}>
                    Hapus
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="card p-5">
            <h2 className="font-semibold text-white">Pengumpulan Tugas ({data.submissions.length})</h2>
            <ul className="mt-3 divide-y divide-white/10 text-sm">
              {data.submissions.map((s) => (
                <li key={s.id} className="flex items-center justify-between py-2.5">
                  <span className="text-slate-300">{s.assignment_title} — <span className="text-slate-500">{s.user_name}</span></span>
                  <Link
                    to="/courses/$slug/grade/$submissionId"
                    params={{ slug: data.course.slug, submissionId: String(s.id) }}
                    className="text-emerald-300 underline"
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

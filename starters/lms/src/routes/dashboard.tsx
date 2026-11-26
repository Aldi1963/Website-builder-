import { useState, type FormEvent } from 'react'
import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { getCookie } from '@tanstack/react-start/server'
import { query } from '~/lib/db'
import { getCurrentUser, requireRole, AUTH_COOKIE_NAME } from '~/lib/auth'
import { ensureLmsSchema, uniqueCourseSlug } from '~/lib/lms'

type Course = { id: number; title: string; slug: string; published: boolean; lesson_count: number; student_count: number }
type Sub = { id: number; title: string; course_title: string; course_slug: string; user_name: string; grade: number | null; submitted_at: string }

const loadDashboard = createServerFn({ method: 'GET' }).handler(async () => {
  await ensureLmsSchema()
  const token = getCookie(AUTH_COOKIE_NAME)
  const user = await getCurrentUser(token)
  if (!user) return { user: null, courses: [], pending: [], enrolledCount: 0 }

  let courses: Course[] = []
  let pending: Sub[] = []
  let enrolledCount = 0

  if (user.role === 'admin' || user.role === 'guru') {
    const r = await query<Course>(
      `select c.id, c.title, c.slug, c.published,
              count(distinct l.id)::int as lesson_count,
              count(distinct e.id)::int as student_count
         from courses c
         left join lessons l on l.course_id=c.id
         left join enrollments e on e.course_id=c.id
        ${user.role === 'guru' ? 'where c.created_by = $1' : ''}
        group by c.id order by c.created_at desc`,
      user.role === 'guru' ? [user.id] : [],
    )
    courses = r.rows
    const g = await query<Sub>(
      `select s.id, a.title, c.title as course_title, c.slug as course_slug, coalesce(u.name,u.email) as user_name, s.grade, s.submitted_at
         from submissions s
         join assignments a on a.id=s.assignment_id
         join courses c on c.id=a.course_id
         join users u on u.id=s.user_id
        where s.grade is null ${user.role === 'guru' ? 'and c.created_by = $1' : ''}
        order by s.submitted_at asc limit 20`,
      user.role === 'guru' ? [user.id] : [],
    )
    pending = g.rows
  } else {
    const r = await query<Course>(
      `select c.id, c.title, c.slug, c.published,
              count(distinct l.id)::int as lesson_count,
              count(distinct e.id)::int as student_count
         from courses c
         left join lessons l on l.course_id=c.id
         left join enrollments e on e.course_id=c.id
        where exists(select 1 from enrollments me where me.course_id=c.id and me.user_id=$1)
        group by c.id order by max(e.enrolled_at) desc`,
      [user.id],
    )
    courses = r.rows
    enrolledCount = courses.length
  }
  return { user, courses, pending, enrolledCount }
})


const createCourse = createServerFn({ method: 'POST' })
  .validator((input: { title: string; description: string }) => input)
  .handler(async ({ data }) => {
    const token = getCookie(AUTH_COOKIE_NAME)
    const user = await requireRole(token, ['admin', 'guru'])
    const title = data.title.trim()
    if (title.length < 3) throw new Error('Judul kursus minimal 3 karakter.')
    const slug = await uniqueCourseSlug(title)
    const r = await query<{ id: number; slug: string }>(
      `insert into courses (title, description, slug, created_by) values ($1,$2,$3,$4) returning id, slug`,
      [title, data.description.trim(), slug, user.id],
    )
    return r.rows[0]
  })


export const Route = createFileRoute('/dashboard')({
  loader: () => loadDashboard(),
  component: Dashboard,
})

function Dashboard() {
  const data = Route.useLoaderData()
  const canManage = data.user && (data.user.role === 'admin' || data.user.role === 'guru')

  return (
    <main className="min-h-dvh">
      <header className="border-b border-white/10 bg-slate-950/70 backdrop-blur">
        <div className="container-page flex items-center justify-between py-4">
          <Link to="/" className="font-bold text-white">← Akademi</Link>
          <span className="badge capitalize">{data.user?.role || 'tamu'}</span>
        </div>
      </header>
      <section className="container-page py-10">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-white">Dashboard</h1>
            <p className="mt-1 text-sm text-slate-400">
              {canManage ? 'Kelola kursus, materi, tugas, dan penilaian.' : 'Kursus yang kamu ikuti.'}
            </p>
          </div>
          {!data.user && <Link to="/login" className="btn-primary">Masuk untuk melanjutkan</Link>}
        </div>

        {canManage && <CreateCourse />}

        {data.pending.length > 0 && (
          <div className="card mt-8 p-5">
            <h2 className="font-semibold text-white">Tugas perlu dinilai ({data.pending.length})</h2>
            <ul className="mt-3 divide-y divide-white/10 text-sm">
              {data.pending.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 py-2">
                  <span className="text-slate-300">{p.title} — <span className="text-slate-500">{p.user_name} · {p.course_title}</span></span>
                  <a href={`/courses/${p.course_slug}/grade/${p.id}`} className="text-emerald-300 underline">Nilai</a>
                </li>
              ))}
            </ul>
          </div>
        )}

        <h2 className="mt-8 text-xl font-semibold text-white">{canManage ? 'Kursus kelolaan' : 'Kursus saya'}</h2>
        {data.courses.length === 0 ? (
          <p className="mt-4 text-sm text-slate-400">Belum ada kursus.</p>
        ) : (
          <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {data.courses.map((c) => (
              <Link key={c.id} to="/courses/$slug" params={{ slug: c.slug }} className="card block p-5 transition hover:border-emerald-400/30">
                <div className="flex justify-between"><span className="badge">{c.published ? 'Diterbitkan' : 'Draft'}</span></div>
                <h3 className="mt-3 font-semibold text-white">{c.title}</h3>
                <div className="mt-3 flex gap-3 text-xs text-slate-500"><span>{c.lesson_count} materi</span><span>{c.student_count} siswa</span></div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </main>
  )
}

function CreateCourse() {
  const router = useRouter()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      const r = await createCourse({ data: { title, description } })
      await router.invalidate()
      await router.navigate({ to: '/courses/$slug', params: { slug: r.slug } })
    } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }
  return (
    <form onSubmit={submit} className="card mt-8 max-w-xl p-5">
      <h2 className="font-semibold text-white">Buat kursus baru</h2>
      <div className="mt-4 space-y-3">
        <input className="input" placeholder="Judul kursus" value={title} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
        <textarea className="input" placeholder="Deskripsi singkat" value={description} onInput={(e) => setDescription((e.target as HTMLTextAreaElement).value)} rows={3} />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button className="btn-primary" disabled={busy || title.trim().length < 3}>{busy ? 'Menyimpan…' : 'Buat kursus'}</button>
      </div>
    </form>
  )
}

import { createFileRoute, Link } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { getCookie } from '@tanstack/react-start/server'
import { query } from '~/lib/db'
import { getCurrentUser, AUTH_COOKIE_NAME } from '~/lib/auth'
import { ensureLmsSchema } from '~/lib/lms'

type Course = {
  id: number
  title: string
  slug: string
  description: string
  published: boolean
  lesson_count: number
  student_count: number
  enrolled: boolean
}

const loadHome = createServerFn({ method: 'GET' }).handler(async () => {
  await ensureLmsSchema()
  const token = getCookie(AUTH_COOKIE_NAME)
  const user = await getCurrentUser(token)
  const { rows } = await query<Course>(
    `select c.id, c.title, c.slug, c.description, c.published,
            count(distinct l.id)::int as lesson_count,
            count(distinct e.id)::int as student_count,
            ${user ? 'exists(select 1 from enrollments me where me.course_id=c.id and me.user_id=$1)' : 'false'} as enrolled
       from courses c
       left join lessons l on l.course_id = c.id
       left join enrollments e on e.course_id = c.id
      ${!user || user.role === 'siswa' ? 'where c.published = true' : ''}
      group by c.id
      order by c.created_at desc`,
    user ? [user.id] : [],
  )
  return { user, courses: rows }
})

export const Route = createFileRoute('/')({
  loader: () => loadHome(),
  component: Home,
})

function Home() {
  const { user, courses } = Route.useLoaderData()
  const canManage = user?.role === 'admin' || user?.role === 'guru'

  return (
    <main className="min-h-dvh">
      <header className="border-b border-white/10 bg-slate-950/70 backdrop-blur">
        <div className="container-page flex items-center justify-between py-4">
          <Link to="/" className="flex items-center gap-2 font-bold tracking-tight text-white">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-400/15 text-emerald-300">L</span>
            <span>Akademi</span>
          </Link>
          <nav className="flex items-center gap-2 text-sm">
            {user ? (
              <>
                <Link to="/dashboard" className="btn-ghost">Dashboard</Link>
                <span className="hidden text-slate-400 sm:inline">{user.name || user.email}</span>
                <span className="badge capitalize">{user.role || 'user'}</span>
              </>
            ) : (
              <Link to="/login" className="btn-primary">Masuk</Link>
            )}
          </nav>
        </div>
      </header>

      <section className="container-page py-14 sm:py-20">
        <div className="mx-auto max-w-3xl text-center">
          <span className="badge">Learning Management System</span>
          <h1 className="mt-4 text-4xl font-extrabold tracking-tight sm:text-6xl">
            Belajar, kelola, <span className="gradient-text">tumbuh</span>
          </h1>
          <p className="mt-5 text-base leading-relaxed text-slate-400 sm:text-lg">
            Platform LMS untuk kursus, materi, tugas, diskusi, dan penilaian. Guru kelola kelas,
            siswa belajar dengan progres yang jelas.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            {user ? (
              <Link to="/dashboard" className="btn-primary">Buka dashboard</Link>
            ) : (
              <>
                <Link to="/login" className="btn-primary">Daftar gratis</Link>
                <Link to="/login" className="btn-ghost">Sudah punya akun</Link>
              </>
            )}
          </div>
        </div>

        <div className="mt-14">
          <div className="mb-5 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold text-white">Kursus tersedia</h2>
              <p className="text-sm text-slate-400">{courses.length} kursus</p>
            </div>
            {canManage && <Link to="/dashboard" className="btn-ghost text-sm">Kelola kursus →</Link>}
          </div>

          {courses.length === 0 ? (
            <div className="card p-10 text-center">
              <p className="text-slate-300">Belum ada kursus.</p>
              <p className="mt-1 text-sm text-slate-400">
                {canManage ? 'Buat kursus pertama dari dashboard.' : 'Kursus akan muncul di sini setelah dipublikasikan.'}
              </p>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {courses.map((c) => (
                <Link key={c.id} to="/courses/$slug" params={{ slug: c.slug }} className="card group block p-5 transition hover:border-emerald-400/30 hover:bg-white/[0.06]">
                  <div className="flex items-start justify-between gap-3">
                    <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-400/10 text-lg font-bold text-emerald-300">
                      {c.title.slice(0, 1).toUpperCase()}
                    </div>
                    <div className="flex gap-1.5">
                      {!c.published && <span className="badge">Draft</span>}
                      {c.enrolled && <span className="badge border-emerald-400/30 bg-emerald-400/10 text-emerald-300">Terdaftar</span>}
                    </div>
                  </div>
                  <h3 className="mt-4 font-semibold text-white group-hover:text-emerald-200">{c.title}</h3>
                  <p className="mt-1 line-clamp-2 text-sm text-slate-400">{c.description || 'Belum ada deskripsi.'}</p>
                  <div className="mt-4 flex gap-3 text-xs text-slate-500">
                    <span>{c.lesson_count} materi</span>
                    <span>{c.student_count} siswa</span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </section>
    </main>
  )
}

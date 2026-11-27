import { useState, type FormEvent } from 'react'
import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { getCookie } from '@tanstack/react-start/server'
import { query } from '~/lib/db'
import { requireRole, AUTH_COOKIE_NAME } from '~/lib/auth'
import { ensureLmsSchema } from '~/lib/lms'

type SubmissionDetail = {
  id: number
  course_slug: string
  course_title: string
  assignment_title: string
  student_name: string
  content: string
  grade: number | null
  feedback: string | null
  submitted_at: string
}

const loadSubmission = createServerFn({ method: 'GET' })
  .validator((input: { submissionId: string }) => input)
  .handler(async ({ data }): Promise<SubmissionDetail> => {
    await ensureLmsSchema()
    const manager = await requireRole(getCookie(AUTH_COOKIE_NAME), ['admin', 'guru'])
    const id = Number(data.submissionId)
    if (!Number.isInteger(id) || id <= 0) throw new Error('ID pengumpulan tidak valid.')
    const r = await query<SubmissionDetail>(
      `select s.id, c.slug as course_slug, c.title as course_title, a.title as assignment_title,
              coalesce(u.name, u.email) as student_name, s.content, s.grade, s.feedback, s.submitted_at
         from submissions s
         join assignments a on a.id = s.assignment_id
         join courses c on c.id = a.course_id
         join users u on u.id = s.user_id
        where s.id = $1 and ($2::text='admin' or c.created_by=$3)`,
      [id, manager.role, manager.id],
    )
    if (!r.rows[0]) throw new Error('Pengumpulan tidak ditemukan atau bukan kursus kelolaanmu.')
    return r.rows[0]
  })

const saveGrade = createServerFn({ method: 'POST' })
  .validator((input: { submissionId: number; grade: number; feedback: string }) => input)
  .handler(async ({ data }) => {
    const manager = await requireRole(getCookie(AUTH_COOKIE_NAME), ['admin', 'guru'])
    const grade = Math.round(Number(data.grade))
    const submissionId = Number(data.submissionId)
    if (!Number.isInteger(submissionId) || submissionId <= 0) throw new Error('ID pengumpulan tidak valid.')
    if (!Number.isFinite(grade) || grade < 0 || grade > 100) throw new Error('Nilai harus antara 0 dan 100.')
    const r = await query(
      `update submissions s set grade=$1, feedback=$2, graded_at=now()
        from assignments a join courses c on c.id=a.course_id
       where s.assignment_id=a.id and s.id=$3 and ($4::text='admin' or c.created_by=$5)`,
      [grade, data.feedback.trim() || null, submissionId, manager.role, manager.id],
    )
    if (!r.rowCount) throw new Error('Pengumpulan tidak ditemukan atau bukan kursus kelolaanmu.')
    return { ok: true }
  })

export const Route = createFileRoute('/courses/$slug_/grade/$submissionId')({
  loader: ({ params }) => loadSubmission({ data: { submissionId: params.submissionId } }),
  component: GradePage,
})

function GradePage() {
  const sub = Route.useLoaderData()
  const router = useRouter()
  const [grade, setGrade] = useState(sub.grade != null ? String(sub.grade) : '')
  const [feedback, setFeedback] = useState(sub.feedback ?? '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await saveGrade({ data: { submissionId: sub.id, grade: Number(grade), feedback } })
      await router.navigate({ to: '/courses/$slug/manage', params: { slug: sub.course_slug } })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="min-h-dvh">
      <header className="border-b border-edge bg-surface/90 backdrop-blur">
        <div className="container-page flex items-center justify-between py-4">
          <Link to="/courses/$slug/manage" params={{ slug: sub.course_slug }} className="font-bold text-ink">
            ← {sub.course_title}
          </Link>
        </div>
      </header>
      <section className="container-page py-10">
        <div className="card mx-auto max-w-2xl p-6">
          <span className="badge">Penilaian Tugas</span>
          <h1 className="mt-3 text-2xl font-bold text-ink">{sub.assignment_title}</h1>
          <p className="mt-1 text-sm text-muted">
            Siswa: {sub.student_name} · Dikumpulkan {new Date(sub.submitted_at).toLocaleString('id-ID')}
          </p>
          <div className="mt-5 rounded-xl border border-edge bg-surface p-4">
            <p className="text-xs font-medium uppercase tracking-wider text-muted">Jawaban Siswa</p>
            <p className="mt-2 whitespace-pre-wrap text-sm text-ink">{sub.content}</p>
          </div>
          <form onSubmit={submit} className="mt-6 space-y-4">
            <div>
              <label className="label">Nilai (0–100)</label>
              <input
                className="input"
                type="number"
                min={0}
                max={100}
                value={grade}
                onInput={(e) => setGrade((e.target as HTMLInputElement).value)}
              />
            </div>
            <div>
              <label className="label">Catatan / Feedback</label>
              <textarea
                className="input"
                rows={4}
                value={feedback}
                onInput={(e) => setFeedback((e.target as HTMLTextAreaElement).value)}
              />
            </div>
            {error && <p className="text-sm text-danger">{error}</p>}
            <button className="btn-primary" disabled={busy || grade === ''}>
              {busy ? 'Menyimpan…' : 'Simpan Nilai'}
            </button>
          </form>
        </div>
      </section>
    </main>
  )
}

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chromium } from 'playwright-core'
import pg from 'pg'

const url = process.env.LMS_TEST_DATABASE_URL
if (!url || !/^lms_test_[a-z0-9_]+$/.test(new URL(url).pathname.slice(1))) throw new Error('Disposable LMS_TEST_DATABASE_URL required')
const base = 'http://127.0.0.1:15441'

// Only teacher provisioning bypasses the UI. Every learning/assessment mutation
// goes through the built app, with isolated teacher and student cookie jars.
test('teacher authors and publishes; student completes and submits; teacher grades; student reloads persisted grade', { timeout: 90000 }, async () => {
  const db = new pg.Client(url)
  await db.connect()
  let server, browser
  try {
    await db.query('drop schema public cascade; create schema public')
    server = spawn(process.execPath, ['server.mjs'], { cwd: new URL('../', import.meta.url), env: { ...process.env, VB_APP_DATABASE_URL: url, PORT: '15441', HOST: '127.0.0.1' }, stdio: 'ignore' })
    let ready = false
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) throw new Error('Disposable app server exited before readiness')
      try { if ((await fetch(base + '/login')).ok) { ready = true; break } } catch {}
      await new Promise(r => setTimeout(r, 100))
    }
    assert.ok(ready, 'Disposable app server became ready')
    browser = await chromium.launch({ executablePath: process.env.LMS_TEST_CHROMIUM, headless: true, args: ['--no-sandbox'] })
    const teacherContext = await browser.newContext()
    const studentContext = await browser.newContext()
    const teacher = await teacherContext.newPage()
    const student = await studentContext.newPage()
    const errors = []
    for (const page of [teacher, student]) {
      page.setDefaultTimeout(10000)
      page.on('pageerror', error => errors.push(error.message))
    }
    async function signup(page, name, email) {
      await page.goto(base + '/login')
      await page.getByRole('button', { name: 'Belum punya akun? Daftar' }).click()
      await page.getByPlaceholder('Nama lengkap').fill(name)
      await page.getByPlaceholder('nama@contoh.com').fill(email)
      await page.getByPlaceholder('Minimal 6 karakter').fill('disposable-assessment-password')
      await page.getByRole('button', { name: 'Daftar', exact: true }).click()
      await page.waitForURL('**/dashboard')
      await page.getByRole('heading', { name: 'Dashboard', exact: true }).waitFor()
    }
    await signup(teacher, 'Assessment Teacher', 'assessment-teacher@example.test')
    assert.equal((await db.query('select role from users where email=$1', ['assessment-teacher@example.test'])).rows[0].role, 'siswa')
    await db.query('update users set role=$1 where email=$2', ['guru', 'assessment-teacher@example.test'])
    assert.equal((await db.query('select role from users where email=$1', ['assessment-teacher@example.test'])).rows[0].role, 'guru')
    await teacher.reload()
    await teacher.getByPlaceholder('Judul kursus').fill('Assessment Browser Course')
    await teacher.getByPlaceholder('Deskripsi singkat').fill('A course authored entirely in Chromium')
    await teacher.getByRole('button', { name: 'Buat kursus', exact: true }).click()
    await teacher.waitForURL('**/courses/assessment-browser-course')
    const courseURL = teacher.url()
    await teacher.getByRole('link', { name: 'Kelola konten →' }).click()
    await teacher.getByRole('heading', { name: 'Kelola Konten Kursus' }).waitFor()
    await teacher.getByPlaceholder('Judul materi').fill('Assessment Lesson')
    await teacher.getByPlaceholder('Isi materi…').fill('Teacher authored lesson content')
    await teacher.getByRole('button', { name: 'Simpan materi' }).click()
    await teacher.getByRole('heading', { name: 'Daftar Materi (1)', exact: true }).waitFor()
    await teacher.getByPlaceholder('Judul tugas').fill('Assessment Assignment')
    await teacher.getByPlaceholder('Instruksi tugas…').fill('Explain what you learned in this lesson')
    await teacher.getByRole('button', { name: 'Simpan tugas' }).click()
    await teacher.waitForFunction(() => document.querySelector('input[placeholder="Judul tugas"]').value === '')
    const course = (await db.query('select * from courses where slug=$1', ['assessment-browser-course'])).rows[0]
    assert.equal(course.published, false)
    assert.equal((await db.query('select title, description from assignments where course_id=$1', [course.id])).rows[0].title, 'Assessment Assignment')
    await teacher.getByRole('button', { name: 'Terbitkan Kursus' }).click()
    await teacher.getByRole('button', { name: 'Jadikan Draft' }).waitFor()
    assert.equal((await db.query('select published from courses where id=$1', [course.id])).rows[0].published, true)

    await signup(student, 'Assessment Student', 'assessment-student@example.test')
    await student.goto(base + '/')
    await student.getByRole('link').filter({ has: student.getByRole('heading', { name: 'Assessment Browser Course', exact: true }) }).click()
    await student.waitForURL(courseURL)
    assert.equal(await student.getByText('Teacher authored lesson content', { exact: true }).count(), 0)
    assert.equal(await student.getByPlaceholder('Tulis jawaban…').count(), 0)
    await student.getByRole('button', { name: 'Daftar kursus' }).click()
    await student.getByText('Teacher authored lesson content', { exact: true }).waitFor()
    await student.getByText('Explain what you learned in this lesson', { exact: true }).waitFor()
    await student.getByText('Progres 0%', { exact: true }).waitFor()
    await student.getByRole('button', { name: 'Tandai selesai' }).click()
    await student.getByText('Progres 100%', { exact: true }).waitFor()
    await student.getByPlaceholder('Tulis jawaban…').fill('My persisted assessment answer from Chromium')
    await student.getByRole('button', { name: 'Kumpulkan', exact: true }).click()
    await student.getByText('Dikumpulkan', { exact: true }).waitFor()
    await student.reload()
    await student.getByText('Progres 100%', { exact: true }).waitFor()
    await student.getByPlaceholder('Jawaban terkumpul: My persisted assessment answer from Chromium', { exact: true }).waitFor()
    await student.getByText('menunggu', { exact: true }).waitFor()
    assert.equal(await student.getByRole('link', { name: 'Kelola konten →' }).count(), 0)

    await teacher.goto(base + '/dashboard')
    await teacher.getByRole('heading', { name: 'Tugas perlu dinilai (1)', exact: true }).waitFor()
    await teacher.getByRole('link', { name: 'Nilai', exact: true }).click()
    await teacher.getByRole('heading', { name: 'Assessment Assignment', exact: true }).waitFor()
    await teacher.getByText('My persisted assessment answer from Chromium', { exact: true }).waitFor()
    await teacher.getByRole('spinbutton').fill('87')
    await teacher.locator('textarea').fill('Clear explanation with supporting examples')
    await teacher.getByRole('button', { name: 'Simpan Nilai', exact: true }).click()
    await teacher.waitForURL('**/courses/assessment-browser-course/manage')
    await teacher.getByRole('link', { name: 'Nilai: 87', exact: true }).waitFor()
    await teacher.reload()
    await teacher.getByRole('link', { name: 'Nilai: 87', exact: true }).waitFor()
    await student.reload()
    await student.getByText('Nilai 87', { exact: true }).waitFor()
    await student.getByText('Catatan guru: Clear explanation with supporting examples', { exact: true }).waitFor()
    await student.getByText('Progres 100%', { exact: true }).waitFor()
    await student.getByRole('listitem').filter({ hasText: 'Assessment Assignment' }).getByText('87', { exact: true }).waitFor()
    const persisted = (await db.query(`select s.content, s.grade, s.feedback, s.graded_at, u.email
      from submissions s join users u on u.id=s.user_id join assignments a on a.id=s.assignment_id
      where a.course_id=$1`, [course.id])).rows
    assert.equal(persisted.length, 1)
    assert.equal(persisted[0].email, 'assessment-student@example.test')
    assert.equal(persisted[0].content, 'My persisted assessment answer from Chromium')
    assert.equal(persisted[0].grade, 87)
    assert.equal(persisted[0].feedback, 'Clear explanation with supporting examples')
    assert.ok(persisted[0].graded_at)
    assert.equal((await db.query('select count(*) from enrollments where course_id=$1', [course.id])).rows[0].count, '1')
    assert.equal((await db.query('select count(*) from lesson_progress')).rows[0].count, '1')
    await teacher.goto(base + '/dashboard')
    assert.equal(await teacher.getByRole('heading', { name: /Tugas perlu dinilai/ }).count(), 0)
    assert.deepEqual(errors, [], 'No browser runtime exceptions')
  } finally {
    await browser?.close()
    if (server && server.exitCode === null) {
      const exited = once(server, 'exit')
      server.kill('SIGTERM')
      await exited
    }
    await db.end()
  }
})

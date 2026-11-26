import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright-core'
import pg from 'pg'

const url = process.env.LMS_TEST_DATABASE_URL
if (!url || !/^lms_test_[a-z0-9_]+$/.test(new URL(url).pathname.slice(1))) throw new Error('Disposable LMS_TEST_DATABASE_URL required')
const base = 'http://127.0.0.1:15440'
test('browser signup, enrollment, protected content, progress and discussion persist', { timeout: 60000 }, async () => {
  const db = new pg.Client(url); await db.connect()
  await db.query('drop schema public cascade; create schema public')
  const server = spawn(process.execPath, ['server.mjs'], { cwd: new URL('../', import.meta.url), env: { ...process.env, VB_APP_DATABASE_URL: url, PORT: '15440', HOST: '127.0.0.1' }, stdio: 'ignore' })
  let browser
  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(base + '/login')).ok) break } catch {}
      await new Promise(r => setTimeout(r, 100))
    }
    browser = await chromium.launch({ executablePath: process.env.LMS_TEST_CHROMIUM, headless: true, args: ['--no-sandbox'] })
    const page = await browser.newPage()
    await page.goto(base + '/login')
    await page.getByRole('button', { name: 'Belum punya akun? Daftar' }).click()
    await page.getByPlaceholder('Nama lengkap').fill('Disposable Student')
    await page.getByPlaceholder('nama@contoh.com').fill('browser@example.test')
    await page.getByPlaceholder('Minimal 6 karakter').fill('test-only-password')
    await page.getByRole('button', { name: 'Daftar', exact: true }).click()
    await page.waitForURL('**/dashboard')
    await page.getByRole('heading', { name: /Dashboard/ }).waitFor()
    assert.equal((await db.query("select role from users where email='browser@example.test'")).rows[0].role, 'siswa')
    const id = (await db.query("insert into courses(title,slug,published) values('Browser Course','browser-course',true) returning id")).rows[0].id
    await db.query("insert into lessons(course_id,title,content) values($1,'Private Lesson','PRIVATE_LESSON_SENTINEL')", [id])
    await page.goto(base + '/courses/browser-course')
    assert.equal(await page.getByText('PRIVATE_LESSON_SENTINEL').count(), 0)
    assert.equal(await page.getByPlaceholder('Tulis pertanyaan…').count(), 0)
    await page.getByRole('button', { name: 'Daftar kursus' }).click()
    await page.getByText('PRIVATE_LESSON_SENTINEL').waitFor()
    await page.getByRole('button', { name: 'Tandai selesai' }).click()
    await page.getByText('Progres 100%').waitFor()
    await page.getByPlaceholder('Tulis pertanyaan…').fill('Browser persisted discussion')
    await page.getByRole('button', { name: 'Kirim', exact: true }).click()
    await page.getByText('Browser persisted discussion', { exact: true }).waitFor()
    await page.reload()
    await page.getByText('Progres 100%').waitFor()
    assert.equal((await db.query('select count(*) from lesson_progress')).rows[0].count, '1')
    assert.equal((await db.query('select count(*) from discussions')).rows[0].count, '1')
    const guest = await browser.newPage()
    await guest.goto(base + '/courses/browser-course')
    assert.equal(await guest.getByText('PRIVATE_LESSON_SENTINEL').count(), 0)
  } finally {
    await browser?.close()
    server.kill('SIGTERM')
    await db.end()
  }
})

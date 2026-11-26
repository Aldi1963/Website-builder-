import test from 'node:test'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'

// Real PostgreSQL, disposable database only. Never use the app's database URL.
const url = process.env.LMS_TEST_DATABASE_URL
if (!url) throw new Error('Set LMS_TEST_DATABASE_URL to a disposable PostgreSQL database named lms_test_*')
if (!/^lms_test_[a-z0-9_]+$/.test(new URL(url).pathname.slice(1))) throw new Error('Refusing non-test database')
process.env.VB_APP_DATABASE_URL = url
const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '../src')
const cache = new Map()
let cookie
// Only transport/React are stubbed: execute the actual route handler bodies and DB helpers.
function load(file, exports = []) {
  file = resolve(file)
  if (cache.has(file)) return cache.get(file).exports
  const module = { exports: {} }; cache.set(file, module)
  const source = readFileSync(file, 'utf8') + exports.map(n => `\nexport { ${n} };`).join('')
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText
  const localRequire = name => {
    if (name === '@tanstack/react-start') return { createServerFn: () => ({ validator() { return this }, handler(fn) { return (input = {}) => fn(input) } }) }
    if (name === '@tanstack/react-start/server') return { getCookie: () => cookie, setCookie: (_n, v) => { cookie = v } }
    if (name === '@tanstack/react-router') return { createFileRoute: () => config => config }
    if (name.startsWith('.') || name.startsWith('~/')) {
      const path = name.startsWith('~/') ? resolve(root, name.slice(2)) : resolve(dirname(file), name)
      return load(path + '.ts')
    }
    return require(name)
  }
  vm.runInThisContext(`(function(require,module,exports){${code}\n})`, { filename: file })(localRequire, module, module.exports)
  return module.exports
}
const db = load(resolve(root, 'lib/db.ts'))
const auth = load(resolve(root, 'lib/auth.ts'))
const login = load(resolve(root, 'routes/login.tsx'), ['doRegister'])
const pool = db.getPgPool()

test.before(async () => { await pool.query('drop schema public cascade; create schema public') })
test.after(async () => { await pool.end() })
const courseRoutes = load(resolve(root, 'routes/courses.$slug.tsx'), ['loadCourse', 'postDiscussion'])

async function actor(email, role) {
  const user = await auth.register(email + '@example.test', 'test-only-password', email, role)
  const session = await auth.login(user.email, 'test-only-password')
  return { ...user, token: session.token }
}

test('course content and discussion reads are limited to admin, owning teacher, enrolled student', async () => {
  await auth.ensureTables()
  await load(resolve(root, 'lib/lms.ts')).ensureLmsSchema()
  const owner = await actor('owner', 'guru')
  const other = await actor('other', 'guru')
  const student = await actor('student', 'siswa')
  const outsider = await actor('outsider', 'siswa')
  const admin = await actor('admin', 'admin')
  for (const published of [true, false]) {
    const slug = published ? 'published' : 'draft'
    const id = (await pool.query('insert into courses(title,slug,published,created_by) values($1,$1,$2,$3) returning id', [slug, published, owner.id])).rows[0].id
    await pool.query("insert into lessons(course_id,title,content) values($1,'lesson','protected lesson')", [id])
    await pool.query("insert into assignments(course_id,title,description) values($1,'assignment','protected assignment')", [id])
    await pool.query("insert into discussions(course_id,user_id,body) values($1,$2,'protected discussion')", [id, owner.id])
    await pool.query('insert into enrollments(user_id,course_id) values($1,$2)', [student.id, id])
    for (const user of [null, outsider, other, owner, student, admin]) {
      cookie = user?.token
      const allowed = user && [owner.id, student.id, admin.id].includes(user.id)
      if (!published && !allowed) {
        await assert.rejects(courseRoutes.loadCourse({ data: { slug } }), /ditolak|belum diterbitkan/, `${slug}: ${user?.role ?? 'guest'}`)
      } else {
        const detail = await courseRoutes.loadCourse({ data: { slug } })
        for (const field of ['lessons', 'assignments', 'discussions']) assert.equal(detail[field].length, allowed ? 1 : 0, `${slug}: ${user?.email ?? 'guest'} ${field}`)
      }
    }
  }
})

test('discussion writes reject outsiders without inserting and permit course members', async () => {
  for (const slug of ['published', 'draft']) {
    for (const email of [null, 'outsider', 'other', 'owner', 'student', 'admin']) {
      cookie = email ? (await auth.login(email + '@example.test', 'test-only-password')).token : undefined
      const before = Number((await pool.query('select count(*) from discussions')).rows[0].count)
      const call = () => courseRoutes.postDiscussion({ data: { slug, body: 'test discussion' } })
      if ([null, 'outsider', 'other'].includes(email)) {
        await assert.rejects(call(), /ditolak|masuk/)
        assert.equal(Number((await pool.query('select count(*) from discussions')).rows[0].count), before)
      } else {
        await call()
        assert.equal(Number((await pool.query('select count(*) from discussions')).rows[0].count), before + 1)
      }
    }
  }
})

test('first public registration completes without blocking and persists only siswa', async () => {
  await pool.query('drop schema public cascade; create schema public')
  const result = await login.doRegister({ data: { email: 'first@example.test', password: 'test-only-password', role: 'admin' } })
  assert.equal(result.user.role, 'siswa')
  assert.equal((await pool.query('select role from users')).rows[0].role, 'siswa')
  assert.equal((await auth.getCurrentUser(cookie)).role, 'siswa')
})

function bootstrap(email) {
  return new Promise(resolveResult => {
    const child = spawn(process.execPath, [resolve(root, '../scripts/bootstrap-admin.mjs'), '--email', email], { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] })
    let error = ''
    child.stderr.on('data', chunk => { error += chunk })
    child.on('close', code => resolveResult({ code, error }))
  })
}

test('trusted CLI bootstraps only the explicitly selected existing owner and refuses a second admin', async () => {
  await auth.register('trusted@example.test', 'test-only-password', 'Owner', 'siswa')
  await auth.login('trusted@example.test', 'test-only-password')
  const result = await bootstrap('trusted@example.test')
  assert.equal(result.code, 0, result.error)
  assert.equal((await pool.query("select role from users where email='trusted@example.test'")).rows[0].role, 'admin')
  assert.equal((await pool.query("select role from users where email='first@example.test'")).rows[0].role, 'siswa')
  assert.equal((await bootstrap('trusted@example.test')).code, 0)
  assert.notEqual((await bootstrap('first@example.test')).code, 0)
  assert.equal((await pool.query("select count(*) from users where role='admin'")).rows[0].count, '1')
  assert.equal((await pool.query('select count(*) from sessions s join users u on u.id=s.user_id where u.email=$1', ['trusted@example.test'])).rows[0].count, '0')
  await pool.query("update users set role='siswa'")
  const competing = await Promise.all([bootstrap('trusted@example.test'), bootstrap('first@example.test')])
  assert.equal(competing.filter(result => result.code === 0).length, 1)
  assert.equal((await pool.query("select count(*) from users where role='admin'")).rows[0].count, '1')
})

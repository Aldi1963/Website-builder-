import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const read = (p) => readFileSync(resolve(root, p), 'utf8')

for (const base of ['template/src', 'starters/lms/src']) {
  test(`${base}: public signup tidak bisa memilih role istimewa`, () => {
    const login = read(`${base}/routes/login.tsx`)
    const auth = read(`${base}/lib/auth.ts`)
    assert.match(login, /register\(data\.email, data\.password, data\.name, 'siswa'\)/)
    assert.match(auth, /requestedRole/)
    assert.match(auth, /\['admin', 'guru', 'teacher', 'superadmin'\]/)
    const fn = auth.slice(auth.indexOf('export async function register'))
    assert.ok(fn.indexOf('tidak dapat didaftarkan publik') < fn.indexOf('await ensureAuthSchema()'),
      `${base}: penolakan role harus terjadi sebelum akses DB`)
    assert.doesNotMatch(auth, /role\?\.trim\(\) \|\| null, hash/)
  })
}

test('setiap pemanggil register di route publik mengunci role', () => {
  const files = [
    'template/src/routes/login.tsx',
    'starters/lms/src/routes/login.tsx',
  ]
  for (const f of files) {
    const src = read(f)
    for (const m of src.matchAll(/register\(([^)]*)\)/g)) {
      const args = m[1]
      assert.ok(/'siswa'/.test(args), `${f}: register dipanggil tanpa role siswa: ${args}`)
    }
  }
})

/* TDD: kontrak routes setelah penggabungan halaman menjadi satu halaman
   bertumpuk (tanpa tab / tanpa query ?tab=).
   Jalankan: cd admin-react && node --test tests/routes.test.mjs */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'

const root = new URL('../', import.meta.url)
const src = (p) => fileURLToPath(new URL(p, root))
const jiti = createJiti(import.meta.url, { interopDefault: true, jsx: true })
globalThis.React ??= await import('react')

const { ROUTES, ADMIN_SECTIONS, matchRoute } = await jiti.import(src('src/routes.ts'))
const routesText = readFileSync(src('src/routes.ts'), 'utf8')

const MERGES = [
  {
    slug: 'konten',
    path: '/admin/konten',
    children: { projects: 'Daftar Proyek', moderasi: 'Moderasi', domain: 'Domain' },
  },
  {
    slug: 'monetisasi',
    path: '/admin/monetisasi',
    children: { plans: 'Plan', credits: 'Credit', billing: 'Pembayaran' },
  },
  {
    slug: 'komunikasi',
    path: '/admin/komunikasi',
    children: { messages: 'Pesan', pengumuman: 'Pengumuman', audit: 'Log Audit' },
  },
  {
    slug: 'sistem',
    path: '/admin/sistem',
    children: {
      health: 'Kesehatan', cadangan: 'Cadangan', pembersihan: 'Pembersihan',
      pemeliharaan: 'Pemeliharaan', settings: 'Pengaturan', sessions: 'Sesi', builds: 'Build',
    },
  },
  { slug: 'ai', path: '/admin/ai', children: { providers: 'Provider', 'ai-settings': 'Pengaturan AI', biaya: 'Biaya', usage: 'Usage' } },
]
const oldSlugs = MERGES.flatMap((m) => Object.keys(m.children))

function redirectName(slug) {
  return `${slug.split('-').map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join('')}Redirect`
}
function componentName(slug) {
  return redirectName(slug).replace(/Redirect$/, 'Page')
}

test('lima halaman induk tersedia dan dapat dicocokkan matchRoute', () => {
  for (const m of MERGES) {
    const route = ROUTES.find((r) => r.slug === m.slug)
    assert.ok(route, `route ${m.slug} harus ada`)
    assert.equal(route.path, m.path)
    assert.notEqual(route.hidden, true, `${m.slug} tidak boleh hidden`)
    assert.equal(matchRoute(m.path)?.route?.slug, m.slug)
  }
})

test('semua route lama yang tergabung hidden dan redirect tanpa ?tab=', () => {
  for (const m of MERGES) {
    for (const old of Object.keys(m.children)) {
      const route = ROUTES.find((r) => r.slug === old)
      assert.ok(route, `route lama ${old} harus tetap ada`)
      assert.equal(route.hidden, true, `${old} harus hidden`)
      const exportName = redirectName(old)
      assert.match(
        routesText,
        new RegExp(
          `case '${old}':[\\s\\S]{0,200}import\\('./pages/${m.slug}'\\)\\.then\\(\\(m\\) => \\(\\{ default: m\\.${exportName} \\}\\)\\)`,
        ),
        `${old} harus di-redirect ke ${m.slug}.${exportName}`,
      )
    }
  }
})

test('halaman induk benar-benar menyatu: tanpa tab bar, tanpa ?tab=, merender >=2 komponen asli', async () => {
  for (const m of MERGES) {
    const text = readFileSync(src(`src/pages/${m.slug}.tsx`), 'utf8')
    assert.match(text, /<PageHeader[\s\S]*title=/, `${m.slug} butuh satu PageHeader induk`)
    assert.doesNotMatch(text, /role="tablist"/, `${m.slug} tidak boleh punya tab bar`)
    assert.doesNotMatch(text, /\?tab=/, `${m.slug} tidak boleh memakai query ?tab=`)
    const rendered = []
    for (const old of Object.keys(m.children)) {
      assert.match(text, new RegExp(`import ${componentName(old)} from '\\./${old}'`), `${m.slug} harus import komponen ${old}`)
      assert.match(text, new RegExp(`<${componentName(old)}\\b`), `${m.slug} harus merender komponen ${old}`)
      assert.match(text, new RegExp(`export const ${redirectName(old)}`), `${m.slug} butuh ${redirectName(old)}`)
      rendered.push(old)
    }
    assert.ok(rendered.length >= 2 && new Set(rendered).size === rendered.length, `${m.slug} harus merender >=2 komponen asli`)
    // Section berurutan: tiap komponen diberi judul section.
    for (const [old, label] of Object.entries(m.children)) {
      assert.ok(text.includes(`'${label}'`), `${m.slug} butuh judul section '${label}'`)
    }
    const mod = await jiti.import(src(`src/pages/${m.slug}.tsx`))
    assert.equal(typeof mod.default, 'function', `${m.slug} default export harus komponen`)
    for (const old of Object.keys(m.children)) {
      assert.equal(typeof mod[redirectName(old)], 'function', `${redirectName(old)} harus diekspor`)
    }
  }
})

test('halaman asli mendukung prop embedded untuk menyembunyikan PageHeader ganda', () => {
  for (const old of oldSlugs) {
    const text = readFileSync(src(`src/pages/${old}.tsx`), 'utf8')
    assert.match(text, /embedded\?: boolean/, `${old} butuh prop embedded`)
    assert.match(text, /!embedded\s*\?[\s\S]{0,400}<PageHeader/, `${old} harus menyembunyikan PageHeader saat embedded`)
  }
})

test('redirect lama menuju path induk bersih tanpa query', () => {
  for (const m of MERGES) {
    const text = readFileSync(src(`src/pages/${m.slug}.tsx`), 'utf8')
    assert.match(text, new RegExp(`replaceState\\(null, '', '${m.path}'\\)`), `${m.slug} redirect harus ke ${m.path}`)
  }
})

test('tidak ada duplikat path', () => {
  const seen = new Map()
  for (const route of ROUTES) {
    assert.ok(!seen.has(route.path), `duplikat path ${route.path}: ${seen.get(route.path)} dan ${route.slug}`)
    seen.set(route.path, route.slug)
  }
})

test('setiap slug di ADMIN_SECTIONS punya route yang tidak hidden', () => {
  const all = new Set(ADMIN_SECTIONS.flatMap((s) => s.slugs))
  assert.deepEqual(
    [...ADMIN_SECTIONS.map((s) => s.label)],
    ['Utama', 'Konten', 'Layanan', 'Sistem'],
    ' Empat grup sesuai permintaan',
  )
  assert.deepEqual(ADMIN_SECTIONS.map((s) => s.slugs), [
    ['dashboard', 'users'],
    ['konten'],
    ['monetisasi', 'ai'],
    ['komunikasi', 'sistem'],
  ])
  assert.ok(oldSlugs.every((s) => !all.has(s)), 'slug lama tidak boleh muncul di sidebar')
  assert.ok(MERGES.every((m) => all.has(m.slug)), 'slug baru harus muncul di sidebar')
  for (const slug of all) {
    const route = ROUTES.find((r) => r.slug === slug)
    assert.ok(route, `slug ${slug} di ADMIN_SECTIONS tidak punya route`)
    assert.notEqual(route.hidden, true, `slug ${slug} tidak boleh hidden`)
  }
})

/* TDD: kontrak routes setelah penggabungan halaman bertab.
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
    tabs: { projects: 'Proyek', moderasi: 'Moderasi', domain: 'Domain' },
  },
  {
    slug: 'monetisasi',
    path: '/admin/monetisasi',
    tabs: { plans: 'Plan', credits: 'Credit', billing: 'Pembayaran' },
  },
  {
    slug: 'komunikasi',
    path: '/admin/komunikasi',
    tabs: { messages: 'Pesan', pengumuman: 'Pengumuman', audit: 'Log Audit' },
  },
  {
    slug: 'sistem',
    path: '/admin/sistem',
    tabs: {
      health: 'Kesehatan',
      cadangan: 'Cadangan',
      pembersihan: 'Pembersihan',
      pemeliharaan: 'Pemeliharaan',
      settings: 'Pengaturan',
      sessions: 'Sesi',
      builds: 'Build',
    },
  },
]
const oldSlugs = MERGES.flatMap((m) => Object.keys(m.tabs))

test('route baru bertab tersedia dan dapat dicocokkan matchRoute', () => {
  for (const m of MERGES) {
    const route = ROUTES.find((r) => r.slug === m.slug)
    assert.ok(route, `route ${m.slug} harus ada`)
    assert.equal(route.path, m.path)
    assert.notEqual(route.hidden, true, `${m.slug} tidak boleh hidden`)
    assert.equal(matchRoute(m.path)?.route?.slug, m.slug)
  }
})

test('semua route lama yang tergabung hidden dan redirect ke tab baru', () => {
  for (const m of MERGES) {
    for (const old of Object.keys(m.tabs)) {
      const route = ROUTES.find((r) => r.slug === old)
      assert.ok(route, `route lama ${old} harus tetap ada`)
      assert.equal(route.hidden, true, `${old} harus hidden`)
      const exportName = `${old.charAt(0).toUpperCase()}${old.slice(1)}Redirect`
      assert.match(
        routesText,
        new RegExp(
          `case '${old}':[\\s\\S]{0,200}import\\('./pages/${m.slug}'\\)\\.then\\(\\(m\\) => \\(\\{ default: m\\.${exportName} \\}\\)\\)`,
        ),
        `${old} harus di-redirect ke ${m.slug}.${exportName}`,
      )
      redirectName(old).includes('Redirect')
    }
  }
})

function redirectName(slug) {
  return `${slug.charAt(0).toUpperCase()}${slug.slice(1)}Redirect`
}

test('halaman bertab punya PageHeader, tab bar, query ?tab=, dan ekspor redirect', async () => {
  for (const m of MERGES) {
    const text = readFileSync(src(`src/pages/${m.slug}.tsx`), 'utf8')
    assert.match(text, /<PageHeader[\s\S]*title=/, `${m.slug} butuh PageHeader induk`)
    assert.match(text, /role="tablist"/, `${m.slug} butuh tab bar`)
    assert.match(text, /URLSearchParams\(window\.location\.search\)\.get\('tab'\)/, `${m.slug} harus membaca ?tab=`)
    for (const [old, label] of Object.entries(m.tabs)) {
      assert.match(text, new RegExp(`from '\\./${old}'`), `${m.slug} harus merender halaman ${old}`)
      assert.ok(text.includes(`'${label}'`), `${m.slug} butuh label tab ${label}`)
      assert.match(text, new RegExp(`export const ${redirectName(old)}`), `${m.slug} butuh ${redirectName(old)}`)
    }
    const mod = await jiti.import(src(`src/pages/${m.slug}.tsx`))
    assert.equal(typeof mod.default, 'function', `${m.slug} default export harus komponen`)
    for (const old of Object.keys(m.tabs)) {
      assert.equal(typeof mod[redirectName(old)], 'function', `${redirectName(old)} harus diekspor`)
    }
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
  assert.ok(oldSlugs.every((s) => !all.has(s)), 'slug lama tidak boleh muncul di sidebar')
  assert.ok(MERGES.every((m) => all.has(m.slug)), 'slug baru harus muncul di sidebar')
  for (const slug of all) {
    const route = ROUTES.find((r) => r.slug === slug)
    assert.ok(route, `slug ${slug} di ADMIN_SECTIONS tidak punya route`)
    assert.notEqual(route.hidden, true, `slug ${slug} tidak boleh hidden`)
  }
})

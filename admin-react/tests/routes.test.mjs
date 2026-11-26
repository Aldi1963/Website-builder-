/* TDD: kontrak navigasi admin setelah sub-halaman dikembalikan ke sidebar
   sebagai sub-menu, dan halaman induk memakai peta bagian (SectionNav).
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
const layoutText = readFileSync(src('src/layout.tsx'), 'utf8')
const cssText = readFileSync(src('src/index.css'), 'utf8')
const sectionNavText = readFileSync(src('src/components/SectionNav.tsx'), 'utf8')

const MERGES = [
  {
    slug: 'konten',
    path: '/admin/konten',
    children: { projects: 'Daftar Proyek', moderasi: 'Moderasi', domain: 'Domain' },
  },
  {
    slug: 'monetisasi',
    path: '/admin/monetisasi',
    children: { plans: 'Plan', credits: 'Kelola Credit', billing: 'Paket Credit' },
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
  {
    slug: 'ai',
    path: '/admin/ai',
    children: { providers: 'Provider', 'ai-settings': 'Pengaturan AI', biaya: 'Biaya', usage: 'Usage' },
  },
]
const parents = ['dashboard', 'users', ...MERGES.map((m) => m.slug)]
const parentOf = new Map(MERGES.flatMap((m) => Object.keys(m.children).map((old) => [old, m.slug])))
const oldSlugs = [...parentOf.keys()]

function redirectName(slug) {
  return `${slug.split('-').map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join('')}Redirect`
}
function componentName(slug) {
  return redirectName(slug).replace(/Redirect$/, 'Page')
}

test('tujuh halaman induk tetap ada, tidak punya parent, dan matchRoute ok', () => {
  assert.equal(parents.length, 7)
  for (const slug of parents) {
    const route = ROUTES.find((r) => r.slug === slug)
    assert.ok(route, `route ${slug} harus ada`)
    assert.notEqual(route.hidden, true, `${slug} tidak boleh hidden`)
    assert.equal(route.parent, undefined, `${slug} bukan sub-menu`)
    if (slug === 'dashboard') assert.equal(route.path, '/admin')
    else assert.equal(route.path, `/admin/${slug}`)
    assert.equal(matchRoute(route.path)?.route?.slug, slug)
  }
})

test('sub-halaman lama tetap ada (boleh hidden), punya parent benar, dan membuka halaman asli (bukan redirect)', () => {
  assert.equal(oldSlugs.length, 20)
  for (const [old, parent] of parentOf) {
    const route = ROUTES.find((r) => r.slug === old)
    assert.ok(route, `route lama ${old} harus tetap ada`)
    // Menu disederhanakan: sebagian sub-halaman kini hidden di sidebar,
    // tetapi URL, parent, dan komponen aslinya tetap dipertahankan.
    assert.equal(route.parent, parent, `${old} harus jadi sub-menu ${parent}`)
    assert.equal(matchRoute(`/admin/${old}`)?.route?.slug, old)
    assert.match(
      routesText,
      new RegExp(`case '${old}':[\\s\\S]{0,120}import\\('\\./pages/${old}'\\)`),
      `${old} harus lazy-import halaman asli ./pages/${old}`,
    )
  }
  assert.doesNotMatch(
    routesText,
    /\.then\(\(m\) => \(\{ default: m\.\w+Redirect \}\)\)/,
    'routes.ts tidak boleh lagi memakai komponen redirect',
  )
})

test('halaman induk benar-benar menyatu: tanpa tab bar, tanpa ?tab=, merender >=2 komponen asli', async () => {
  for (const m of MERGES) {
    const text = readFileSync(src(`src/pages/${m.slug}.tsx`), 'utf8')
    assert.match(text, /<PageHeader[\s\S]*title=/, `${m.slug} butuh satu PageHeader induk`)
    assert.doesNotMatch(text, /role="tablist"/, `${m.slug} tidak boleh punya tab bar`)
    assert.doesNotMatch(text, /\?tab=/, `${m.slug} tidak boleh memakai query ?tab=`)
    const rendered = []
    for (const old of Object.keys(m.children)) {
      const visible = ROUTES.find((r) => r.slug === old)?.hidden !== true
      assert.match(text, new RegExp(`export const ${redirectName(old)}`), `${m.slug} butuh ${redirectName(old)}`)
      if (visible) {
        assert.match(text, new RegExp(`import ${componentName(old)} from '\\./${old}'`), `${m.slug} harus import komponen ${old}`)
        assert.match(text, new RegExp(`<${componentName(old)}\\b`), `${m.slug} harus merender komponen ${old}`)
        rendered.push(old)
      }
    }
    const visibleChildren = Object.keys(m.children).filter(
      (old) => ROUTES.find((r) => r.slug === old)?.hidden !== true,
    )
    if (visibleChildren.length >= 2) {
      assert.ok(rendered.length >= 2 && new Set(rendered).size === rendered.length, `${m.slug} harus merender >=2 komponen asli`)
    }
    for (const [old, label] of Object.entries(m.children)) {
      if (ROUTES.find((r) => r.slug === old)?.hidden !== true) {
        assert.ok(text.includes(`'${label}'`), `${m.slug} butuh judul section '${label}'`)
      }
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
    assert.match(text, /!embedded\s*[\s\S]{0,400}<PageHeader/, `${old} harus menyembunyikan PageHeader saat embedded`)
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

test('ADMIN_SECTIONS: 15 entri terlihat (12 sub hidden), induk langsung diikuti anaknya', () => {
  assert.deepEqual(
    ADMIN_SECTIONS.map((s) => s.label),
    ['Utama', 'Konten', 'Layanan', 'Sistem'],
  )
  assert.deepEqual(ADMIN_SECTIONS.map((s) => s.slugs), [
    ['dashboard', 'users'],
    ['konten'],
    ['monetisasi', 'credits', 'ai', 'providers', 'ai-settings', 'biaya', 'usage'],
    ['komunikasi', 'sistem', 'health', 'cadangan', 'settings'],
  ])
  const all = ADMIN_SECTIONS.flatMap((s) => s.slugs)
  assert.equal(all.length, 15)
  assert.equal(new Set(all).size, all.length)
  assert.deepEqual([...all].sort(), [...ROUTES.filter((r) => !r.hidden).map((r) => r.slug)].sort())
  for (const slug of all) {
    const route = ROUTES.find((r) => r.slug === slug)
    assert.ok(route, `slug ${slug} di ADMIN_SECTIONS tidak punya route`)
    assert.notEqual(route.hidden, true, `slug ${slug} tidak boleh hidden`)
  }
  const hidden = ROUTES.filter((r) => r.hidden).map((r) => r.slug).sort()
  assert.equal(hidden.length, 12)
  assert.deepEqual(hidden, [
    'audit', 'billing', 'builds', 'domain', 'messages', 'moderasi',
    'pembersihan', 'pemeliharaan', 'pengumuman', 'plans', 'projects', 'sessions',
  ])
  for (const old of hidden) assert.ok(!all.includes(old), `${old} tidak boleh tampil di sidebar`)
  for (const [old, parent] of parentOf) {
    const i = all.indexOf(old)
    if (i < 0) continue // sub-menu hidden: tetap punya parent di ROUTES
    assert.ok(i > 1, `${old} harus punya induk sebelum dirinya`)
    assert.ok(
      all.slice(0, i).includes(parent),
      `${old} harus berada di bawah ${parent} di ADMIN_SECTIONS`,
    )
  }
})

test('sidebar meny render sub-menu ber-indent + badge (projects, health) tetap jalan', () => {
  assert.match(layoutText, /route\.parent/, 'layout harus menandai entri sub-menu lewat route.parent')
  assert.match(layoutText, /pl-4|ml-3/, 'sub-menu harus ber-indent')
  assert.match(layoutText, /text-xs/, 'sub-menu pakai teks lebih kecil')
  assert.match(layoutText, /badgeFor\(route\.slug\)/, 'badge dipakai di semua entri')
  assert.match(layoutText, /slug === 'projects'/, 'badge projects tetap ada')
  assert.match(layoutText, /slug === 'health'/, 'badge health tetap ada')
  // Badge tetap dipertahankan meski menu projects kini hidden di sidebar.
  assert.equal(ROUTES.find((r) => r.slug === 'projects').hidden, true)
  assert.equal(ROUTES.find((r) => r.slug === 'health').hidden, undefined)
})

test('SectionNav + SectionBlock dipakai semua halaman induk, anchor.id dan scroll halus tersedia', () => {
  assert.match(sectionNavText, /href=\{`#\$\{item\.id\}`\}/, 'SectionNav butuh anchor ke #id')
  assert.match(sectionNavText, /grid-cols-2/, 'SectionNav butuh grid kartu')
  assert.match(sectionNavText, /scroll-mt-24/, 'SectionBlock tidak boleh tertutup header sticky')
  assert.match(sectionNavText, /padStart\(2, '0'\)/, 'SectionBlock butuh nomor urut 01/02/...')
  assert.match(cssText, /scroll-behavior:\s*smooth/, 'index.css butuh scroll halus')
  assert.match(cssText, /@media\s*\(prefers-reduced-motion:\s*reduce\)/, 'scroll halus harus bisa dimatikan')
  for (const m of MERGES) {
    const text = readFileSync(src(`src/pages/${m.slug}.tsx`), 'utf8')
    assert.match(text, /<SectionNav\b/, `${m.slug} butuh peta halaman`)
    assert.match(text, /<PageSection\b/, `${m.slug} butuh section dengan kepala rapi`)
    assert.doesNotMatch(text, /gradient|backdrop-blur|role="tablist"/, `${m.slug} bebas slop UI`)
    for (const old of Object.keys(m.children)) {
      if (ROUTES.find((r) => r.slug === old)?.hidden !== true) {
        assert.match(text, new RegExp(`id: '${old}'`), `${m.slug} butuh anchor #${old}`)
      }
    }
  }
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..') + '/'
const css = readFileSync(root + 'template/src/styles.css', 'utf8')
const design = readFileSync(root + 'template/DESIGN.md', 'utf8')
const agent = readFileSync(root + 'server/src/agent.ts', 'utf8')
const prompts = readFileSync(root + 'server/src/prompts.ts', 'utf8')
const starters = ['lms', 'tiket']

test('design system: font display & UI ditentukan, bukan font generik', () => {
  assert.match(css, /--font-display:\s*"Fraunces"/)
  assert.match(css, /--font-sans:\s*"DM Sans"/)
  assert.doesNotMatch(css, /--font-display:\s*"Inter"|"Poppins"|"Roboto"/)
  assert.match(design, /Fraunces/)
  assert.match(prompts, /Fraunces/)
})

test('design system: tidak ada kelas dekoratif yang dilarang', () => {
  assert.doesNotMatch(css, /\.gradient-text/)
  assert.doesNotMatch(css, /backdrop-blur|blur-\(|\.glow/)
  for (const starter of starters) {
    const index = readFileSync(root + `starters/${starter}/src/routes/index.tsx`, 'utf8')
    assert.doesNotMatch(index, /gradient-text/, `starter ${starter} masih pakai gradient-text`)
    const rootFile = readFileSync(root + `starters/${starter}/src/routes/__root.tsx`, 'utf8')
    assert.doesNotMatch(rootFile, /family=Inter/, `starter ${starter} masih memuat Inter`)
  }
})

/* Kelas kit yang benar-benar dipakai route starter/template vs yang hanya
   didefinisikan sebagai cadangan kit untuk generasi agent berikutnya.
   Dulu tes ini hanya menegaskan kelas ADA di CSS (rasa aman palsu) — sekarang
   kelas inti harus TERBUKTI dipakai, dan kelas cadangan harus TERBUKTI
   terdokumentasi di DESIGN.md (bukan diklaim dipakai). */
/* Kumpulkan token class dari semua atribut class/className (string biasa
   maupun template literal) lalu periksa keanggotaan token — tepat, tanpa
   false positive dari substring seperti 'inputClass' atau 'card-pad'. */
function usedClasses(sources) {
  const set = new Set()
  for (const src of sources) {
    for (const re of [/(?:className|class)="([^"]*)"/g, /(?:className|class)='([^']*)'/g, /className=\{`([^`]*)`\}/g]) {
      for (const m of src.matchAll(re)) {
        for (const t of m[1].split(/\s+/)) if (t && !t.includes('$')) set.add(t)
      }
    }
  }
  return set
}

test('design system: component kit inti dipakai route starter/template', () => {
  const sources = []
  for (const base of ['template/src', 'starters/lms/src', 'starters/tiket/src']) {
    for (const f of readdirSync(root + base, { recursive: true })) {
      if (String(f).endsWith('.tsx')) sources.push(readFileSync(root + base + '/' + f, 'utf8'))
    }
  }
  assert.ok(sources.length > 5, `route starter/template tidak terbaca: ${sources.length} file`)
  const used = usedClasses(sources)
  for (const cls of ['card', 'btn-primary', 'input', 'badge']) {
    assert.match(css, new RegExp(`\\.${cls.replace('-', '\\-')}\\b`), `kelas .${cls} tidak ada di CSS`)
    assert.ok(used.has(cls), `kelas .${cls} didefinisikan tapi tidak dipakai route mana pun`)
  }
  assert.match(design, /Component kit/)
})

test('design system: kelas kit cadangan didefinisikan + terdokumentasi, bukan diklaim dipakai', () => {
  for (const cls of ['table-wrap', 'empty-state', 'notice-error', 'nav-link', 'tab-active', 'modal-panel', 'toast', 'stack-mobile']) {
    assert.match(css, new RegExp(`\\.${cls.replace('-', '\\-')}\\b`), `kelas cadangan .${cls} tidak ada di CSS`)
    assert.ok(design.includes(`.${cls}`), `kelas cadangan .${cls} tidak ada di tabel Component kit DESIGN.md`)
  }
})

test('agent menyuntik DESIGN.md ke system prompt tiap run', () => {
  assert.match(agent, /readProjectFile\(projectId, 'DESIGN\.md'\)/)
  assert.match(agent, /KONTRAK DESAIN PROYEK/)
  assert.match(agent, /designContext/)
  assert.match(prompts, /DESIGN\.md/)
})

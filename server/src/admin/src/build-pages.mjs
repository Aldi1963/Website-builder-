// Generator halaman admin: gabungkan shell template Metis (src/shell.html)
// dengan fragmen konten tiap halaman (src/pages/<id>.html) menjadi halaman
// lengkap di pages/<id>.html. Jalankan: node build-pages.mjs
// Header/sidebar/footer SAMA di semua halaman karena berasal dari satu shell.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const shell = readFileSync(join(here, 'shell.html'), 'utf8')

const pages = [
  { id: 'dashboard', title: 'Dashboard', file: 'dashboard.html' },
  { id: 'users', title: 'Pengguna', file: 'users.html' },
  { id: 'projects', title: 'Proyek', file: 'projects.html' },
  { id: 'plans', title: 'Plan', file: 'plans.html' },
  { id: 'usage', title: 'Penggunaan', file: 'usage.html' },
  { id: 'builds', title: 'Build', file: 'builds.html' },
  { id: 'biaya', title: 'Biaya LLM', file: 'cost.html' },
  { id: 'messages', title: 'Pesan', file: 'messages.html' },
  { id: 'sessions', title: 'Sesi', file: 'sessions.html' },
  { id: 'health', title: 'Kesehatan Sistem', file: 'health.html' },
  { id: 'ai-settings', title: 'Pengaturan AI', file: 'ai-settings.html' },
  { id: 'settings', title: 'Pengaturan', file: 'settings.html' },
]

mkdirSync(join(here, '..', 'pages'), { recursive: true })
for (const p of pages) {
  const content = readFileSync(join(here, 'pages', p.file), 'utf8').trim()
  let html = shell
    .replaceAll('{{PAGE_TITLE}}', p.title)
    .replaceAll('{{BODY_DATA_PAGE}}', p.id)
    .replaceAll('{{PAGE_CONTENT}}', content)
  for (const q of pages) {
    html = html.replaceAll(`{{NAV_ACTIVE:${q.id}}}`, q.id === p.id ? ' active' : '')
  }
  if (/{{[A-Z_]+}}/.test(html)) throw new Error(`placeholder tersisa di halaman ${p.id}`)
  writeFileSync(join(here, '..', 'pages', p.file), html + '\n')
  console.log(`pages/${p.file} <- ${p.id}`)
}
console.log(`${pages.length} halaman dibuat.`)

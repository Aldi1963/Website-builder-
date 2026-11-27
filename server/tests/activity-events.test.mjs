import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* Riwayat aktivitas persisten di transcript chat (redesain 27 Nov 2026):
   event file/terminal agent disimpan server ke tabel activity_events dan
   dirender kronologis di dalam transcript, jadi tetap ada saat proyek
   dibuka ulang. Root dihitung relatif dari file ini (bukan path hardcode),
   supaya test menguji repo yang sedang dijalankan. */
const root = new URL('../..', import.meta.url).pathname
const read = (rel) => readFileSync(join(root, rel), 'utf8')

test('activity_events: skema + fungsi tulis/baca + bersih saat proyek dihapus', () => {
  const db = read('server/src/db.ts')
  assert.match(db, /CREATE TABLE IF NOT EXISTS activity_events/)
  assert.match(db, /export function addActivityEvent/)
  assert.match(db, /export function listActivityEvents/)
  assert.match(db, /DELETE FROM activity_events WHERE project_id = \?/)
})

test('activity_events: round-trip tulis/baca + bersih saat proyek dihapus (DB temporer)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vb-events-'))
  process.env.VB_DB = join(dir, 'test.db')
  const mod = await import('../src/db.ts')
  try {
    mod.db
      .prepare(
        `INSERT INTO projects (id, name, prompt, status, starter, created_at, updated_at)
         VALUES ('p1', 'Uji', '', 'idle', 'blank', 1, 1)`,
      )
      .run()
    const f = mod.addActivityEvent('p1', { kind: 'file', label: 'src/App.tsx', action: 'write' })
    const t = mod.addActivityEvent('p1', { kind: 'terminal', label: 'npm run build', detail: 'ok', ok: true })
    const m = mod.addActivityEvent('p1', { kind: 'file', label: 'src/lama.ts', action: 'delete' })
    assert.equal(f.kind, 'file')
    assert.equal(f.action, 'write')
    assert.equal(t.ok, 1)
    assert.equal(m.action, 'delete')
    const rows = mod.listActivityEvents('p1')
    assert.equal(rows.length, 3)
    assert.deepEqual(
      rows.map((r) => r.label),
      ['src/App.tsx', 'npm run build', 'src/lama.ts'],
    )
    assert.ok(rows.every((r) => typeof r.created_at === 'number' && r.created_at > 0))
    mod.deleteProject('p1')
    assert.equal(mod.listActivityEvents('p1').length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('activity_events: server menulis event file/build/install di corong chat', () => {
  const app = read('server/src/app.ts')
  assert.match(app, /addActivityEvent\(id, \{ kind: 'file'/)
  assert.match(app, /addActivityEvent\(id, \{ kind: 'terminal', label: 'npm run build'/)
  assert.match(app, /addActivityEvent\(id, \{ kind: 'terminal', label: 'npm install'/)
  assert.match(app, /events: listActivityEvents\(p\.id\)/)
  assert.match(app, /events: listActivityEvents\(r\.project\.id\)/)
})

test('activity_events: klien memuat + menggabung event ke transcript + segarkan sesudah run', () => {
  const api = read('platform/src/api.ts')
  assert.match(api, /export type ActivityEvent/)
  assert.match(api, /events: ActivityEvent\[\]/)
  assert.match(api, /events: \(id: string\)/)
  const panels = read('platform/src/panels.tsx')
  assert.match(panels, /export function mergeTranscript/)
  assert.match(panels, /events\?: ActivityEvent\[\]/)
  assert.match(panels, /terminalDefaultOpen=\{false\}/)
  const app = read('platform/src/App.tsx')
  assert.match(app, /const \[events, setEvents\] = useState<ActivityEvent\[\]>/)
  assert.match(app, /setEvents\(d\.events/)
  assert.match(app, /events=\{events\}/)
  assert.match(app, /const refreshEvents = async/)
  /* Sesudah run: kartu live diganti kartu persisten (tanpa dobel). */
  assert.ok((app.match(/setInlineEvents\(\[\]\)/g) ?? []).length >= 2, 'onDone/onError harus mengosongkan inlineEvents')
})

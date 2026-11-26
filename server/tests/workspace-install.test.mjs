import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'

// Exercise installDeps through its subprocess boundary without network or a real tenant.
test('workspace dependency installation disables unnecessary CUDA download', () => {
  const root = mkdtempSync(join(tmpdir(), 'vb-install-test-'))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'npm'), '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)))\n', { mode: 0o755 })
  const id = `install-test-${process.pid}`
  const script = `
    const { installDeps, projectDir } = await import('./server/src/workspace.ts');
    const { createUser } = await import('./server/src/auth.ts');
    const { createProject } = await import('./server/src/db.ts');
    const { rmSync } = await import('node:fs');
    const user = createUser('install-test@example.test', 'Install Test', 'disposable-test-password');
    createProject(${JSON.stringify(id)}, 'Install Test', '', user.id, 'lms');
    try { console.log(JSON.stringify(await installDeps(${JSON.stringify(id)}))); }
    finally { rmSync(projectDir(${JSON.stringify(id)}), { recursive: true, force: true }); }
  `
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: new URL('../..', import.meta.url), encoding: 'utf8',
      env: { ...process.env, VB_DB: join(root, 'test.sqlite'), PATH: `${bin}:${process.env.PATH}` },
    })
    assert.equal(result.status, 0, result.stderr)
    const run = JSON.parse(result.stdout.trim())
    assert.equal(run.code, 0)
    assert.ok(JSON.parse(run.output.trim()).includes('--onnxruntime-node-install-cuda=skip'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

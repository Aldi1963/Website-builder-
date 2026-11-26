import assert from 'node:assert/strict'
import test from 'node:test'

import { validateProjectSql, splitSqlStatements, execProjectSql } from '../src/managed-db.ts'

const schemaCases = [
  ['CREATE TABLE IF NOT EXISTS users (id serial primary key, email text unique)', true],
  ['CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users (email)', true],
  ['ALTER TABLE users ADD COLUMN IF NOT EXISTS role text', true],
  ["COMMENT ON TABLE users IS 'akun aplikasi'", true],
  ['CREATE TABLE t (id int);', true],
  ['-- catatan\nCREATE TABLE t (id int)', true],
  ['/* wip */ CREATE TABLE t (id int)', true],
  ['DROP TABLE users', false],
  ['DROP DATABASE vb_demo', false],
  ['DROP ROLE vb_demo', false],
  ['CREATE ROLE attacker LOGIN', false],
  ['CREATE EXTENSION IF NOT EXISTS dblink', false],
  ['GRANT ALL ON users TO public', false],
  ['SELECT 1', false],
  ['CREATE TABLE a (id int); DROP DATABASE vb_demo', false],
  ['CREATE TABLE a (id int); /* x */ DROP ROLE vb_demo', false],
]

const queryCases = [
  ['SELECT id, email FROM users ORDER BY id DESC LIMIT 20', true],
  ['with recent as (select id from users) select * from recent', true],
  ["INSERT INTO users (email) VALUES ('a@b.c')", true],
  ["UPDATE users SET role = 'admin' WHERE id = 1", true],
  ['DELETE FROM users WHERE id = 1', true],
  ["INSERT INTO notes (body) VALUES ('pakai titik koma; lalu drop database x')", true],
  ["SELECT * FROM posts WHERE body LIKE '%drop database%'", true],
  ['SELECT id FROM users;', true],
  ['CREATE TABLE hack (id int)', false],
  ['ALTER TABLE users ADD COLUMN x int', false],
  ['DROP TABLE users', false],
  ['SELECT 1; DROP TABLE users', false],
  ["SELECT pg_read_file('/etc/passwd')", false],
  ["COPY users TO PROGRAM 'cat /etc/passwd'", false],
  ['SET ROLE postgres', false],
  ['RESET ROLE', false],
  ['GRANT ALL ON users TO public', false],
  ['TRUNCATE users', false],
  ['VACUUM FULL users', false],
  ["DO $$ BEGIN EXECUTE 'drop table users'; END $$", false],
]

test('db_schema hanya menerima DDL allowlist', () => {
  for (const [sql, expect] of schemaCases) {
    const r = validateProjectSql('schema', sql)
    assert.equal(r.ok, expect, `schema ${expect ? 'accept' : 'reject'}: ${sql} -> ${JSON.stringify(r)}`)
  }
})

test('db_query hanya menerima DML/SELECT allowlist', () => {
  for (const [sql, expect] of queryCases) {
    const r = validateProjectSql('query', sql)
    assert.equal(r.ok, expect, `query ${expect ? 'accept' : 'reject'}: ${sql} -> ${JSON.stringify(r)}`)
  }
})

test('SQL kosong dan multi-pernyataan ditolak dengan pesan jelas', () => {
  assert.equal(validateProjectSql('query', '   ').ok, false)
  const multi = validateProjectSql('schema', 'CREATE TABLE t (id int); CREATE TABLE u (id int)')
  assert.equal(multi.ok, false)
  assert.match(multi.error, /satu pernyataan/i)
})

test('splitSqlStatements menghormati string dan dollar-quote', () => {
  assert.deepEqual(splitSqlStatements("select ';'"), ["select ';'"])
  assert.equal(splitSqlStatements("select $$ a;b $$").length, 1)
  assert.equal(splitSqlStatements('select 1; select 2').length, 2)
  assert.equal(splitSqlStatements('-- a;b\nselect 1').length, 1)
})

test('execProjectSql menolak SQL terlarang sebelum menyentuh database', async () => {
  const r = await execProjectSql('demo', 'DROP DATABASE vb_demo', 'schema')
  assert.equal(r.ok, false)
  assert.match(String(r.error), /tidak diizinkan/i)
})

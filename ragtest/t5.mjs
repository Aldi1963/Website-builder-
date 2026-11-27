import { FlagEmbedding } from 'fastembed'
import { Client } from 'pg'

const embedder = await FlagEmbedding.init()
async function toVec(text) {
  for await (const emb of embedder.embed([text])) return emb
  throw new Error('no emb')
}
const base = process.env.VB_PG_URL // postgres://vibebuilder:pw@127.0.0.1:5432/vibebuilder_platform
const adminUrl = base.replace(/\/[^/]+$/, '/postgres')
const testUrl = base.replace(/\/[^/]+$/, '/rag_test')

const admin = new Client({ connectionString: adminUrl })
await admin.connect()
await admin.query('drop database if exists rag_test').catch(()=>{})
await admin.query('create database rag_test')
await admin.end()

const c = new Client({ connectionString: testUrl })
await c.connect()
await c.query('create extension if not exists vector')
await c.query('create table docs (id serial primary key, content text, embedding vector(384))')

const v1 = await toVec('kucing adalah hewan peliharaan yang lucu')
const v3 = await toVec('presiden indonesia menandatangani undang undang baru')
console.log('DIM', v1.length)
await c.query('insert into docs (content, embedding) values ($1,$2)', ['kucing adalah hewan peliharaan', '['+v1.join(',')+']'])
await c.query('insert into docs (content, embedding) values ($1,$2)', ['presiden menandatangani UU', '['+v3.join(',')+']'])

const q = await toVec('hewan peliharaan di rumah')
const r = await c.query('select content, 1 - (embedding <=> $1) as score from docs order by embedding <=> $1 limit 2', ['['+q.join(',')+']'])
console.log('SEARCH:')
r.rows.forEach(x=>console.log(' ', x.content.slice(0,40), '=>', Number(x.score).toFixed(3)))
await c.end()

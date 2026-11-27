import { FlagEmbedding } from 'fastembed'
import { Client } from 'pg'

const embedder = await FlagEmbedding.init()
async function toVec(text) {
  for await (const emb of embedder.embed([text])) return emb
  throw new Error('no emb')
}
const v1 = await toVec('kucing adalah hewan peliharaan')
const v2 = await toVec('saya punya kucing di rumah')
const v3 = await toVec('presiden indonesia menandatangani undang undang')
console.log('DIM', v1.length)

const url = process.env.VB_PG_ADMIN_URL || 'postgresql://vibebuilder:@127.0.0.1:5432/vibebuilder_platform'
// pakai DB test khusus
const admin = new Client({ connectionString: url })
await admin.connect()
await admin.query('drop database if exists rag_test').catch(()=>{})
await admin.query('create database rag_test')
const c = new Client({ connectionString: 'postgresql://vibebuilder:@127.0.0.1:5432/rag_test' })
await c.connect()
await c.query('create extension if not exists vector')
await c.query('create table docs (id serial primary key, content text, embedding vector(384))')
const ins = async (t, v) => c.query('insert into docs (content, embedding) values ($1,$2)', [t, '['+v.join(',')+']'])
await ins('kucing adalah hewan peliharaan', v1)
await ins('presiden indonesia menandatangani undang undang', v3)
const q = await toVec('hewan peliharaan di rumah')
const r = await c.query('select content, 1 - (embedding <=> $1) as score from docs order by embedding <=> $1 limit 2', ['['+q.join(',')+']'])
console.log('SEARCH_RESULT', r.rows.map(x=>x.content.slice(0,30)+'='+Number(x.score).toFixed(3)))
await c.end(); await admin.end()

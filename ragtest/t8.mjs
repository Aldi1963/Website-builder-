import { FlagEmbedding } from 'fastembed'
const embedder = await FlagEmbedding.init()
async function one(fn, text) {
  for await (const v of fn(text)) return v
}
const q = await one(embedder.queryEmbed.bind(embedder), 'hewan peliharaan di rumah')
const p = await one(embedder.passageEmbed.bind(embedder), 'kucing adalah hewan peliharaan')
console.log('queryEmbed dim', q?.length, 'first3', Array.from(q.slice(0,3)).map(n=>Number(n).toFixed(3)).join(','))
console.log('passageEmbed dim', p?.length, 'first3', Array.from(p.slice(0,3)).map(n=>Number(n).toFixed(3)).join(','))

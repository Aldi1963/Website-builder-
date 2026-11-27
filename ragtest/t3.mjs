import { FlagEmbedding } from 'fastembed'
const embedder = await FlagEmbedding.init()
const r = await embedder.embed(['halo dunia', 'kucing makan ikan'])
console.log('TYPE', typeof r, Array.isArray(r), 'isAsyncGen', typeof r?.[Symbol.asyncIterator])
if (r && typeof r[Symbol.asyncIterator] === 'function') {
  for await (const emb of r) { console.log('EMB dim', emb.length, 'sample', Array.from(emb.slice(0,3)).map(n=>n.toFixed(3)).join(',')); break }
} else {
  console.log('RAW', JSON.stringify(r)?.slice(0,300))
}

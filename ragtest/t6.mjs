import { FlagEmbedding } from 'fastembed'
const embedder = await FlagEmbedding.init()
async function toVec(text) {
  for await (const emb of embedder.embed([text])) return emb
}
const v = await toVec('halo dunia')
console.log('typeof', typeof v, 'isArray', Array.isArray(v), 'isTyped', ArrayBuffer.isView(v))
console.log('length', v?.length, 'first5', Array.from(v.slice(0,5)).map(n=>Number(n).toFixed(4)).join(','))
console.log('constructor', v?.constructor?.name)

import { FlagEmbedding } from 'fastembed'
const embedder = await FlagEmbedding.init()
const p = await embedder.passageEmbed(['kucing hewan peliharaan', 'presiden tanda tangan UU'])
console.log('isPromise', p instanceof Promise, 'keys', p ? Object.keys(p).slice(0,8) : null)
const s = JSON.stringify(p)
console.log('json head', s ? s.slice(0,120) : String(p).slice(0,120))
// mungkin Promise nested
const r = await p
console.log('after await isArray', Array.isArray(r), 'isTyped', ArrayBuffer.isView(r), 'jsonhead', JSON.stringify(r)?.slice(0,80))

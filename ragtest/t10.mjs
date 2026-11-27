import { FlagEmbedding } from 'fastembed'
const embedder = await FlagEmbedding.init()
const p = await embedder.passageEmbed(['kucing hewan peliharaan', 'presiden tanda tangan UU'])
console.log('passage typeof', typeof p, 'isArray', Array.isArray(p), 'isTyped', ArrayBuffer.isView(p))
console.log('len', p?.length, 'ctor', p?.constructor?.name)
if (ArrayBuffer.isView(p)) console.log('single vec dim', p.length, 'first3', Array.from(p.slice(0,3)).map(n=>n.toFixed(3)).join(','))
else if (Array.isArray(p)) { console.log('elem0 isTyped', ArrayBuffer.isView(p[0]), 'dim', p[0]?.length) }

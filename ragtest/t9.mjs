import { FlagEmbedding } from 'fastembed'
const embedder = await FlagEmbedding.init()

// queryEmbed / passageEmbed balik Promise -> array of vectors (satu per input)
const q = await embedder.queryEmbed('hewan peliharaan di rumah')
const p = await embedder.passageEmbed(['kucing adalah hewan peliharaan', 'presiden menandatangani UU'])
console.log('query raw isArray', Array.isArray(q), 'len', q?.length, 'inner?', Array.isArray(q?.[0]))
console.log('query vec dim', q?.[0]?.length ?? q?.length)
console.log('passage count', p?.length, 'vec dim', p?.[0]?.length)
const qv = Array.isArray(q?.[0]) ? q[0] : q
console.log('query first3', Array.from(qv.slice(0,3)).map(n=>Number(n).toFixed(3)).join(','))

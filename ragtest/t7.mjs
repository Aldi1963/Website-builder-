import { FlagEmbedding } from 'fastembed'
const embedder = await FlagEmbedding.init()
console.log('methods', Object.getOwnPropertyNames(Object.getPrototypeOf(embedder)))
// coba queryEmbed
try {
  const v = embedder.queryEmbed('halo dunia ini sebuah tes embedding')
  console.log('queryEmbed type', typeof v, Array.isArray(v), v?.length)
  console.log('queryEmbed first', Array.from(v.slice(0,5)).map(n=>Number(n).toFixed(4)).join(','))
} catch (e) { console.log('queryEmbed ERR', e.message) }

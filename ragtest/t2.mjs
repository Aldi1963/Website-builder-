import { FlagEmbedding } from 'fastembed'
const embedder = await FlagEmbedding.init()
const v = await embedder.embed(['halo dunia', 'kucing makan ikan'])
console.log('EMB_OK count', v.length, 'dim', v[0].length)
console.log('sample', Array.from(v[0].slice(0,3)).map(n=>n.toFixed(3)).join(','))

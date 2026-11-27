import { FastEmbed } from 'fastembed'
const e = new FastEmbed({ model: 'BAAI/bge-small-en-v1.5', dimensions: 384 })
await e.init()
const v = await e.embed(['halo dunia', 'kucing ikan'])
console.log('OK COUNT', v.length, 'DIM', v[0].length)

import { FlagEmbedding } from 'fastembed'
const e = await FlagEmbedding.init()
// embed dengan array
const a = await e.embed(['kucing hewan peliharaan','presiden tanda tangan UU'])
console.log('embed isArray', Array.isArray(a), 'len', a?.length, 'elem0 ctor', a?.[0]?.constructor?.name, 'dim0', a?.[0]?.length)
// passageEmbed
const b = await e.passageEmbed(['kucing hewan peliharaan','presiden tanda tangan UU'])
console.log('passage ctor', b?.constructor?.name, 'len', b?.length, 'isAsyncGen', typeof b?.[Symbol.asyncIterator])
if (typeof b?.[Symbol.asyncIterator] === 'function') {
  const arr=[]; for await (const v of b) arr.push(Array.from(v))
  console.log('passage via iter count', arr.length, 'dim', arr[0]?.length, 'first3', arr[0]?.slice(0,3).map(n=>n.toFixed(3)).join(','))
}
// queryEmbed
const q = await e.queryEmbed('hewan peliharaan di rumah')
console.log('query ctor', q?.constructor?.name, 'dim', q?.length)

import { FlagEmbedding, EmbeddingModel } from 'fastembed'

/**
 * Embedding lokal untuk RAG (384-dimensi, bge-small-en-v1.5).
 * Model di-cache di /opt/vibebuilder/ragtest/local_cache supaya tidak
 * mengunduh dari internet saat startup. Singleton: init sekali.
 */
const CACHE_DIR = process.env.VB_EMBED_CACHE || '/opt/vibebuilder/ragtest/local_cache'

let instance: FlagEmbedding | null = null
let initializing: Promise<FlagEmbedding> | null = null

async function getEmbedder(): Promise<FlagEmbedding> {
  if (instance) return instance
  if (!initializing) {
    initializing = FlagEmbedding.init({
      model: EmbeddingModel.BGESmallENV15,
      cacheDir: CACHE_DIR,
      showDownloadProgress: false,
    }).then((e) => {
      instance = e
      return e
    }).catch((err: unknown) => {
      initializing = null
      throw err
    })
  }
  return initializing
}

export async function embedTexts(inputs: string[]): Promise<number[][]> {
  if (!inputs.length) return []
  const e = await getEmbedder()
  const out: number[][] = []
  for await (const batch of e.embed(inputs)) {
    for (const v of batch) out.push(Array.from(v))
  }
  return out
}

export function embedReady(): boolean {
  return Boolean(instance)
}

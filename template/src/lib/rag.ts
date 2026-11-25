import { query } from './db'

/**
 * RAG (Retrieval-Augmented Generation) bawaan — server-side saja.
 *
 * Basis pengetahuan per aplikasi: dokumen dipecah jadi chunk, tiap chunk
 * di-embed jadi vektor (fastembed bge-small, 384 dim, lokal — tanpa API/key)
 * dan disimpan di Postgres dengan pgvector. Pencarian pakai cosine distance.
 *
 * Pemakaian di server function / route:
 *   import { ingestText, searchKnowledge, ensureRagSchema } from '~/lib/rag'
 *   await ingestText('Nama dokumen', 'teks panjang...')
 *   const hits = await searchKnowledge('pertanyaan user')
 *   // -> [{ content, score, source }]
 *
 * Lalu masukkan hits sebagai konteks ke /api/chat (helper streamChat dari
 * ~/lib/chat). JANGAN import file ini dari kode client.
 */

export const EMBED_DIM = 384
const CHUNK_SIZE = 800       // karakter per chunk
const CHUNK_OVERLAP = 120    // tumpang tindih antar chunk
const TOP_K = 4              // jumlah chunk yang diambil saat pencarian

/** Lazily buat ekstensi vector + tabel pengetahuan (idempotent). */
export async function ensureRagSchema(): Promise<void> {
  await query('create extension if not exists vector')
  await query(`
    create table if not exists knowledge_chunks (
      id serial primary key,
      source text not null,
      content text not null,
      embedding vector(${EMBED_DIM}),
      created_at timestamptz default now()
    )
  `)
  await query(`create index if not exists knowledge_chunks_source_idx on knowledge_chunks(source)`)
}

/** Pecah teks jadi chunk yang tumpang tindih. */
function chunkText(text: string): string[] {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= CHUNK_SIZE) return clean ? [clean] : []
  const chunks: string[] = []
  let start = 0
  while (start < clean.length) {
    const end = Math.min(start + CHUNK_SIZE, clean.length)
    chunks.push(clean.slice(start, end))
    if (end >= clean.length) break
    start = end - CHUNK_OVERLAP
  }
  return chunks
}

/** Ambil vektor embedding untuk satu teks lewat endpoint lokal /api/embed. */
async function embed(text: string): Promise<number[]> {
  const port = process.env.PORT ?? 3000
  const res = await fetch(`http://127.0.0.1:${port}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: text }),
  })
  if (!res.ok) throw new Error(`Embedding gagal: ${res.status}`)
  const { embedding } = await res.json()
  if (!Array.isArray(embedding)) throw new Error('Respons embedding tidak valid.')
  return embedding
}

/** Simpan dokumen (teks) ke basis pengetahuan — dipotong & di-embed per chunk. */
export async function ingestText(source: string, text: string): Promise<{ chunks: number }> {
  await ensureRagSchema()
  const pieces = chunkText(text)
  for (const piece of pieces) {
    const vector = await embed(piece)
    await query(
      `insert into knowledge_chunks (source, content, embedding) values ($1,$2,$3)`,
      [source, piece, `[${vector.join(',')}]`],
    )
  }
  return { chunks: pieces.length }
}

export type KnowledgeHit = { content: string; score: number; source: string }

/** Cari chunk paling relevan untuk sebuah pertanyaan (cosine similarity). */
export async function searchKnowledge(question: string): Promise<KnowledgeHit[]> {
  await ensureRagSchema()
  const vector = await embed(question)
  const r = await query<{ content: string; source: string; score: number }>(
    `select content, source, 1 - (embedding <=> $1) as score
       from knowledge_chunks
      order by embedding <=> $1
      limit ${TOP_K}`,
    [`[${vector.join(',')}]`],
  )
  return r.rows.map((row) => ({ content: row.content, source: row.source, score: Number(row.score) }))
}

/** Ubah hasil pencarian jadi blok konteks untuk prompt LLM. */
export function buildContext(hits: KnowledgeHit[]): string {
  if (!hits.length) return ''
  const parts = hits.map((h, i) => `[${i + 1}] (sumber: ${h.source}) ${h.content}`)
  return `Gunakan potongan pengetahuan berikut untuk menjawab. Jika jawaban tidak ada di sini, katakan tidak tahu.\n\n${parts.join('\n\n')}`
}

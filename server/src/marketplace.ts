/* Marketplace: publikasikan sebuah proyek sebagai template publik, telusuri
   galeri, dan "fork" template jadi proyek baru milik pengguna lain.
   Satu proyek hanya punya satu listing (upsert); fork menyalin seluruh file. */
import { randomBytes } from 'node:crypto'
import {
  db,
  getProject,
  createProject,
  listFiles,
  getFile,
  putFile,
  type Project,
} from './db.ts'

export type Listing = {
  id: number
  project_id: string
  title: string
  description: string
  category: string
  owner_id: string | null
  fork_count: number
  created_at: number
}

/* Tabel dibuat idempoten saat modul diimpor (SQLite, WAL). */
db.exec(`
  CREATE TABLE IF NOT EXISTS marketplace_listings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'umum',
    owner_id TEXT,
    fork_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_listing_owner ON marketplace_listings(owner_id);
`)

export function publishListing(
  projectId: string,
  ownerId: string | null,
  title: string,
  description: string,
  category: string,
): Listing {
  const clean = title.trim() || getProject(projectId)?.name || 'Tanpa nama'
  const cat = (category || 'umum').trim().toLowerCase()
  db.prepare(
    `INSERT INTO marketplace_listings (project_id, title, description, category, owner_id, fork_count, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       title = excluded.title,
       description = excluded.description,
       category = excluded.category`,
  ).run(projectId, clean, description.trim(), cat, ownerId, Date.now())
  return getListingByProject(projectId)!
}

export function unpublishListing(projectId: string): boolean {
  const r = db.prepare(`DELETE FROM marketplace_listings WHERE project_id = ?`).run(projectId)
  return Number(r.changes ?? 0) > 0
}

export function getListingByProject(projectId: string): Listing | undefined {
  return db.prepare(`SELECT * FROM marketplace_listings WHERE project_id = ?`).get(projectId) as Listing | undefined
}

export function listMarketplace(category?: string): Listing[] {
  if (category && category !== 'semua') {
    return db
      .prepare(`SELECT * FROM marketplace_listings WHERE category = ? ORDER BY fork_count DESC, created_at DESC`)
      .all(category) as Listing[]
  }
  return db.prepare(`SELECT * FROM marketplace_listings ORDER BY fork_count DESC, created_at DESC`).all() as Listing[]
}

export function listMyListings(ownerId: string): Listing[] {
  return db
    .prepare(`SELECT * FROM marketplace_listings WHERE owner_id = ? ORDER BY created_at DESC`)
    .all(ownerId) as Listing[]
}

export function marketplaceCategories(): string[] {
  const rows = db.prepare(`SELECT DISTINCT category FROM marketplace_listings ORDER BY category`).all() as {
    category: string
  }[]
  return ['semua', ...rows.map((r) => r.category)]
}

/* Fork: salin seluruh file listing ke proyek baru milik owner baru. */
export function forkListing(
  listingId: number,
  newOwnerId: string,
  newName?: string,
): { project: Project; listing: Listing } | { error: string } {
  const listing = db.prepare(`SELECT * FROM marketplace_listings WHERE id = ?`).get(listingId) as Listing | undefined
  if (!listing) return { error: 'Template tidak ditemukan.' }

  const src = getProject(listing.project_id)
  if (!src) return { error: 'Proyek sumber sudah dihapus.' }

  const newId = randomBytes(5).toString('hex')
  const name = (newName || `${listing.title} (fork)`).trim()
  const created = createProject(newId, name, src.prompt, newOwnerId)

  const files = listFiles(listing.project_id)
  for (const f of files) {
    const content = getFile(listing.project_id, f.path)
    if (content !== undefined) putFile(newId, f.path, content)
  }

  db.prepare(`UPDATE marketplace_listings SET fork_count = fork_count + 1 WHERE id = ?`).run(listingId)

  return { project: { ...created, id: newId }, listing }
}

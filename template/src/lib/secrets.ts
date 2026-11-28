/**
 * Helper integrasi untuk aplikasi hasil generate (server-only).
 *
 * Nilai secret TIDAK PERNAH ditulis ke file, database aplikasi, atau bundle
 * client. Form admin memanggil saveSecret(), yang meneruskan nilai lewat
 * server.mjs ke platform VibeBuilder. Platform menyimpannya sebagai env var
 * write-only dan me-restart preview agar process.env.NAMA_KEY tersedia.
 *
 * JANGAN mengimpor file ini dari komponen klien yang dirender langsung —
 * panggil dari createServerFn / handler server.
 */

export type SecretSaveResult = { ok: true; key: string } | { ok: false; error: string }

/** Simpan / perbarui kredensial. Hanya nama key yang dikembalikan. */
export async function saveSecret(key: string, value: string): Promise<SecretSaveResult> {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) return { ok: false, error: 'Nama kunci harus HURUF_KAPITAL_ANGKA.' }
  if (!value) return { ok: false, error: 'Nilai tidak boleh kosong.' }
  try {
    const res = await fetch('/api/integrations/secret', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ key, value }),
    })
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; key?: string; error?: string }
    return res.ok && data.ok ? { ok: true, key } : { ok: false, error: data.error ?? 'Gagal menyimpan secret.' }
  } catch {
    return { ok: false, error: 'Gagal menghubungi server.' }
  }
}

/** Daftar nama kunci yang sudah tersimpan (tanpa nilai). */
export async function listSecretKeys(): Promise<string[]> {
  try {
    const res = await fetch('/api/integrations/keys', { credentials: 'same-origin' })
    const data = (await res.json().catch(() => ({}))) as { keys?: string[] }
    return Array.isArray(data.keys) ? data.keys : []
  } catch {
    return []
  }
}

/** Status ringkas untuk kartu provider di halaman admin. */
export async function integrationStatus(keys: string[]): Promise<Record<string, boolean>> {
  const saved = new Set(await listSecretKeys())
  return Object.fromEntries(keys.map((k) => [k, saved.has(k)]))
}

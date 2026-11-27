// Adapter DB yang aman di client maupun server.
// Handler createServerFn dieksekusi di SSR (tanpa `window`), sehingga modul
// asli dimuat lewat dynamic import. Di browser modul itu tidak pernah dipanggil
// sehingga `pg`/node:util tidak pernah dievaluasi (mencegah error hidrasi).
export async function query<T = unknown>(...args: unknown[]): Promise<{ rows: T[] }> {
  if (typeof window !== 'undefined') {
    throw new Error('query() hanya bisa dipanggil dari server function')
  }
  const mod = await import('./db')
  return (mod.query as (...a: unknown[]) => Promise<{ rows: T[] }>)(...args)
}

export async function getPgPool(): Promise<any> {
  if (typeof window !== 'undefined') {
    throw new Error('getPgPool() hanya bisa dipanggil dari server function')
  }
  const mod = await import('./db')
  return mod.getPgPool()
}

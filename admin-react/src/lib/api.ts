/* Klien API admin. Semua request memakai cookie sesi (credentials:
   'include') — tidak ada token di localStorage. Bentuk error server:
   { error: 'pesan' } dengan status HTTP. */

export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

type RequestBody = globalThis.BodyInit | Record<string, unknown> | unknown[]

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: RequestBody
}

function isFormData(body: unknown): body is FormData {
  return typeof FormData !== 'undefined' && body instanceof FormData
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { body, headers, ...rest } = opts
  const form = isFormData(body)
  const res = await fetch(path, {
    credentials: 'include',
    ...rest,
    headers: {
      ...(form ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : form ? body : JSON.stringify(body),
  })

  if (res.status === 204) return null as T
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    /* bukan JSON */
  }
  if (!res.ok) {
    const message =
      (data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
        ? data.error
        : null) ??
      (data && typeof data === 'object' && 'message' in data && typeof data.message === 'string'
        ? data.message
        : null) ??
      `Permintaan gagal (${res.status}).`
    throw new ApiError(res.status, message)
  }
  return data as T
}

export const api = {
  get: <T>(path: string) => request<T>(path, { method: 'GET' }),
  post: <T>(path: string, body?: RequestBody) => request<T>(path, { method: 'POST', body }),
  put: <T>(path: string, body?: RequestBody) => request<T>(path, { method: 'PUT', body }),
  patch: <T>(path: string, body?: RequestBody) => request<T>(path, { method: 'PATCH', body }),
  del: <T>(path: string, body?: RequestBody) => request<T>(path, { method: 'DELETE', body }),
}

/** Unduh file lewat blob (dipakai mis. ekspor CSV). */
export async function downloadFile(url: string, filename: string): Promise<void> {
  const res = await fetch(url, { credentials: 'include' })
  if (!res.ok) throw new ApiError(res.status, `Unduhan gagal (${res.status}).`)
  const blob = await res.blob()
  const href = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = href
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(href), 1000)
}

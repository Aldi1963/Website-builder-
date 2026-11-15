// Penolong fetch bersama untuk hooks TanStack Query.
//
// Perilakunya sama persis dengan `req()` di lib/api.ts (prefix `/api`,
// header Authorization Bearer dari token yang sama, throw dengan pesan
// server bila respons tidak OK) — hanya saja diekspor agar bisa dipakai
// dari hooks. lib/api.ts sendiri bukan bagian partisi trek ini, jadi
// penolong ini sengaja tidak mengubah file itu; trek pemilik api.ts bisa
// menduplikasi keduanya nanti.
import { getToken } from "../api";

export async function apiFetch<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const r = await fetch("/api" + path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + getToken(),
      ...(opts.headers || {}),
    },
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.message || d.error || "Gagal");
  return d as T;
}

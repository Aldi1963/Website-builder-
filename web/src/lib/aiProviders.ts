// Pemilih provider/model per prompt (trek 1/4 adopsi Website-builder).
//
// Backend: GET /api/ai-providers mengembalikan provider aktif (tanpa key)
// {id, name, baseUrl, models, isDefault, enabled, hasKey}. Composer
// mengirim providerId + model di body POST /chat; pilihan dicatat per
// pesan/run di server, jadi riwayat konsisten walau default berubah.
// Pilihan terakhir per proyek disimpan di localStorage (kunci di bawah)
// supaya proyek yang dibuka ulang memakai provider/model yang sama.
import { getToken } from "./api";

export interface AIProviderOption {
  id: number;
  name: string;
  baseUrl: string;
  models: string[];
  isDefault: boolean;
  enabled: boolean;
  hasKey: boolean;
}

export interface AISelection {
  providerId: number;
  model: string;
}

export function aiSelectionStorageKey(projectId: string): string {
  return `wb-ai-selection:${projectId}`;
}

export async function fetchAIProviders(): Promise<AIProviderOption[]> {
  const r = await fetch("/api/ai-providers", {
    headers: { Authorization: "Bearer " + getToken() },
  });
  if (!r.ok) throw new Error(`Gagal memuat provider AI (HTTP ${r.status})`);
  const d = await r.json().catch(() => ({}));
  const list = Array.isArray(d.providers) ? d.providers : [];
  return list
    .filter((p: any) => p && typeof p.id === "number")
    .map((p: any) => ({
      id: p.id,
      name: String(p.name || `Provider #${p.id}`),
      baseUrl: String(p.baseUrl || ""),
      models: Array.isArray(p.models) ? p.models.map(String) : [],
      isDefault: !!p.isDefault,
      enabled: p.enabled !== false,
      hasKey: !!p.hasKey,
    }));
}

/** Provider default: baris isDefault, fallback pertama. Null bila kosong. */
export function defaultProvider(providers: AIProviderOption[]): AIProviderOption | null {
  if (!providers.length) return null;
  return providers.find((p) => p.isDefault) || providers[0];
}

export function providerById(providers: AIProviderOption[], id: number): AIProviderOption | null {
  return providers.find((p) => p.id === id) || null;
}

export function modelsOf(provider: AIProviderOption | null): string[] {
  return provider ? provider.models : [];
}

/**
 * Tentukan pilihan composer dari daftar provider + pilihan tersimpan
 * (localStorage per proyek). Aturan:
 * - pilihan tersimpan dipakai bila providernya masih ada; modelnya
 *   dipakai bila masih terdaftar di provider itu, kalau tidak model
 *   pertama di daftar provider itu;
 * - tanpa simpanan (atau providernya hilang): provider default +
 *   model pertamanya (atau "" bila provider belum punya daftar model —
 *   composer menampilkan input teks model).
 * Fungsi murni (tanpa fetch/storage) supaya bisa diuji unit.
 */
export function resolveComposerSelection(
  providers: AIProviderOption[],
  stored: AISelection | null,
): AISelection {
  const fallback: AISelection = { providerId: 0, model: "" };
  const def = defaultProvider(providers);
  if (!def) return fallback;
  if (!stored) {
    return { providerId: def.id, model: def.models[0] || "" };
  }
  const p = providerById(providers, stored.providerId) || def;
  const model =
    stored.model && p.models.includes(stored.model)
      ? stored.model
      : p.models[0] || "";
  return { providerId: p.id, model };
}

/** Model yang valid untuk provider itu: yang dipilih bila terdaftar, kalau tidak pertama. */
export function validModelFor(provider: AIProviderOption | null, wanted: string): string {
  if (!provider) return "";
  if (wanted && provider.models.includes(wanted)) return wanted;
  return provider.models[0] || "";
}

// Hooks data inti satu proyek: detail, simpan file, riwayat chat, versi.
// Dipakai Builder (dan pemulihan file di halaman lain bila perlu).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { apiFetch } from "./fetcher";
import { projectKeys } from "./queryKeys";

export function useProject(pid: string) {
  return useQuery({
    queryKey: projectKeys.detail(pid),
    queryFn: () => api.getProject(pid),
    enabled: !!pid,
  });
}

// PUT /projects/:id — menyimpan seluruh map file. Mengembalikan respons
// mentah; pemanggil yang memegang file terbaru di store.
export function useSaveProject(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (files: Record<string, string>) =>
      apiFetch(`/projects/${pid}`, {
        method: "PUT",
        body: JSON.stringify({ files: JSON.stringify(files) }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: projectKeys.detail(pid) });
    },
  });
}

export function useChatHistory(pid: string) {
  return useQuery({
    queryKey: projectKeys.chat(pid),
    queryFn: () => apiFetch(`/projects/${pid}/chat`),
    enabled: !!pid,
  });
}

export function fetchProjectVersions(pid: string) {
  return apiFetch(`/projects/${pid}/versions`);
}

export function useProjectVersions(pid: string, enabled = true) {
  return useQuery({
    queryKey: projectKeys.versions(pid),
    queryFn: () => fetchProjectVersions(pid),
    enabled: !!pid && enabled,
  });
}

export function fetchVersionFiles(pid: string, vid: number) {
  return apiFetch(`/projects/${pid}/versions/${vid}/files`);
}

// POST restore. Mengembalikan { files } — bila server tidak mengembalikan
// files, ambil ulang proyek agar pemanggil selalu dapat file terbaru
// (perilaku lama: fallback ke getProject).
export function useRestoreVersion(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vid: number) => {
      const d = await apiFetch<any>(`/projects/${pid}/versions/${vid}/restore`, { method: "POST" });
      if (d.files) return { files: JSON.parse(d.files) as Record<string, string> };
      const proj = await api.getProject(pid);
      return { files: JSON.parse(proj.project.files || "{}") as Record<string, string> };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: projectKeys.versions(pid) });
      qc.invalidateQueries({ queryKey: projectKeys.detail(pid) });
    },
  });
}

export function useCheckpointVersion(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (label: string) =>
      apiFetch(`/projects/${pid}/versions/checkpoint`, {
        method: "POST",
        body: JSON.stringify({ label: label || "Checkpoint" }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: projectKeys.versions(pid) });
    },
  });
}

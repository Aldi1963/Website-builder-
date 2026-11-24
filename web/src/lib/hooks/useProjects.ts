// Hooks daftar proyek + pembuatan proyek (dipakai Dashboard, App,
// dan halaman lain yang membuat proyek baru).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { projectKeys } from "./queryKeys";

export function useProjects() {
  return useQuery({ queryKey: projectKeys.lists(), queryFn: () => api.projects() });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, framework }: { name: string; framework: string }) =>
      api.createProject(name, framework),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: projectKeys.lists() });
    },
  });
}

// Clone website dari URL: server men-scrape + men-regenerasi sebagai
// proyek React, lalu meng-enqueue run agent (progres terlihat di Builder).
export function useCloneFromURL() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ url, name }: { url: string; name?: string }) =>
      api.cloneFromURL(url, name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: projectKeys.lists() });
    },
  });
}

// Bentuk respons createProject tidak konsisten di server (project.id
// atau id di root); pemanggil lama sudah menangani kedua bentuk ini.
export function projectIdFromCreateResponse(d: any): string | null {
  if (d?.project?.id) return String(d.project.id);
  if (d?.id) return String(d.id);
  return null;
}

// Hooks data Builder di luar runtime: komentar, publish, blueprint,
// tabel & policy database, CRUD file, proposal AI, pengaturan proyek,
// GitHub, AI enhance/gambar, upload, dan export ZIP.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, getToken } from "../api";
import { apiFetch } from "./fetcher";
import { githubKeys, projectKeys } from "./queryKeys";

// ---- Komentar ----
export function useComments(pid: string) {
  return useQuery({
    queryKey: projectKeys.comments(pid),
    queryFn: () => apiFetch(`/projects/${pid}/comments`),
    enabled: !!pid,
  });
}

export function useAddComment(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ filePath, body }: { filePath: string; body: string }) =>
      apiFetch(`/projects/${pid}/comments`, {
        method: "POST",
        body: JSON.stringify({ filePath, body }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: projectKeys.comments(pid) });
    },
  });
}

export function useResolveComment(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/projects/${pid}/comments/${id}/resolve`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: projectKeys.comments(pid) });
    },
  });
}

// ---- Publish ----
export function usePublishProject(pid: string) {
  return useMutation({
    mutationFn: () => apiFetch(`/projects/${pid}/publish`, { method: "POST" }),
  });
}

// ---- Blueprint ----
export function useBlueprint(pid: string, enabled = true) {
  return useQuery({
    queryKey: projectKeys.blueprint(pid),
    queryFn: () => apiFetch(`/projects/${pid}/blueprint`),
    enabled: !!pid && enabled,
  });
}

export function useSaveBlueprint(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (blueprint: string) =>
      apiFetch(`/projects/${pid}/blueprint`, {
        method: "PUT",
        body: JSON.stringify({ blueprint }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: projectKeys.blueprint(pid) });
    },
  });
}

// ---- Tabel & policy database ----
export function useTables(pid: string, enabled = true) {
  return useQuery({
    queryKey: projectKeys.tables(pid),
    queryFn: () => apiFetch(`/projects/${pid}/tables`),
    enabled: !!pid && enabled,
  });
}

export function useCreateTable(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      apiFetch(`/projects/${pid}/tables`, {
        method: "POST",
        body: JSON.stringify({ name, columns: [] }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: projectKeys.tables(pid) });
    },
  });
}

export function fetchTableDetail(pid: string, name: string) {
  return apiFetch(`/projects/${pid}/tables/${encodeURIComponent(name)}`);
}

export function usePolicies(pid: string, enabled = true) {
  return useQuery({
    queryKey: projectKeys.policies(pid),
    queryFn: () => apiFetch(`/projects/${pid}/policies`),
    enabled: !!pid && enabled,
  });
}

export function useSavePolicy(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ table, role, operation, enabled }: { table: string; role: string; operation: string; enabled: boolean }) =>
      apiFetch(`/projects/${pid}/policies`, {
        method: "POST",
        body: JSON.stringify({ table, role, operation, enabled }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: projectKeys.policies(pid) });
    },
  });
}

// ---- CRUD file proyek ----
// Setiap mutasi merangkai pemanggilan CRUD lalu getProject dan
// mengembalikan map file terbaru — sama seperti `reloadFiles()` lama,
// hanya saja lewat cache query proyek.
function refreshProjectFiles(pid: string) {
  return api.getProject(pid).then((d) => JSON.parse(d.project.files || "{}") as Record<string, string>);
}

export function useCreateProjectFile(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (path: string) => {
      await apiFetch(`/projects/${pid}/files`, {
        method: "POST",
        body: JSON.stringify({ path, content: "" }),
      });
      return refreshProjectFiles(pid);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: projectKeys.detail(pid) });
    },
  });
}

export function useDeleteProjectFile(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (path: string) => {
      await apiFetch(`/projects/${pid}/files`, {
        method: "DELETE",
        body: JSON.stringify({ path }),
      });
      return refreshProjectFiles(pid);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: projectKeys.detail(pid) });
    },
  });
}

export function useRenameProjectFile(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ from, to }: { from: string; to: string }) => {
      await apiFetch(`/projects/${pid}/files/rename`, {
        method: "POST",
        body: JSON.stringify({ from, to }),
      });
      return refreshProjectFiles(pid);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: projectKeys.detail(pid) });
    },
  });
}

// ---- Proposal AI ----
export function useApplyProposal(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (files: string[]) => {
      await apiFetch(`/projects/${pid}/proposal/apply`, {
        method: "POST",
        body: JSON.stringify({ files }),
      });
      const d = await api.getProject(pid);
      return { files: JSON.parse(d.project.files || "{}") as Record<string, string>, project: d.project };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: projectKeys.detail(pid) });
    },
  });
}

export function useRejectProposal(pid: string) {
  return useMutation({
    mutationFn: () => apiFetch(`/projects/${pid}/proposal/reject`, { method: "POST" }),
  });
}

// ---- Pengaturan proyek ----
export function useProjectSettings(pid: string, enabled = true) {
  return useQuery({
    queryKey: projectKeys.settings(pid),
    queryFn: () => apiFetch(`/projects/${pid}/settings`),
    enabled: !!pid && enabled,
  });
}

export function useSaveProjectSettings(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (s: any) =>
      apiFetch(`/projects/${pid}/settings`, {
        method: "PUT",
        body: JSON.stringify(s),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: projectKeys.settings(pid) });
    },
  });
}

// ---- GitHub ----
export function useGitHubSettings(enabled = true) {
  return useQuery({
    queryKey: githubKeys.settings,
    queryFn: () => apiFetch("/github"),
    enabled,
  });
}

export function useSaveGitHubSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ repo, token }: { repo: string; token?: string }) =>
      apiFetch("/github", {
        method: "PUT",
        body: JSON.stringify({ repo, token: token || undefined }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: githubKeys.settings });
    },
  });
}

// Push/pull GitHub. Untuk pull, file terbaru ikut dikembalikan agar
// pemanggil bisa memperbarui store (perilaku lama: getProject setelah pull).
export function useGitHubPushPull(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (action: string) => {
      const d = await apiFetch<any>(`/projects/${pid}/github/${action}`, { method: "POST" });
      if (action === "pull") {
        const files = await refreshProjectFiles(pid);
        return { message: d.message, files };
      }
      return { message: d.message, files: null as Record<string, string> | null };
    },
    onSuccess: (_d, action) => {
      if (action === "pull") qc.invalidateQueries({ queryKey: projectKeys.detail(pid) });
    },
  });
}

// ---- AI enhance / gambar / upload ----
export function useEnhancePrompt() {
  return useMutation({
    mutationFn: (prompt: string) =>
      apiFetch("/ai/enhance", {
        method: "POST",
        body: JSON.stringify({ prompt }),
      }),
  });
}

export function useGenerateImage() {
  return useMutation({
    mutationFn: (prompt: string) =>
      apiFetch("/ai/image", {
        method: "POST",
        body: JSON.stringify({ prompt }),
      }),
  });
}

// Upload memakai FormData, jadi Content-Type JSON TIDAK boleh dipasang
// (browser yang menentukan boundary). Karena itu memakai fetch mentah,
// bukan apiFetch.
export function useUploadFile() {
  return useMutation({
    mutationFn: async (f: File) => {
      const fd = new FormData();
      fd.append("file", f);
      const r = await fetch("/api/upload", {
        method: "POST",
        headers: { Authorization: "Bearer " + getToken() },
        body: fd,
      });
      return r.json();
    },
  });
}

// ---- Export ZIP ----
// Unduhan blob satu-tembak, bukan data cacheable: sengaja bukan hook,
// melainkan penolong biasa dengan endpoint yang sama seperti sebelumnya.
export async function downloadProjectExport(pid: string, slug: string) {
  const r = await fetch(`/api/projects/${pid}/export`, {
    headers: { Authorization: "Bearer " + getToken() },
  });
  const blob = await r.blob();
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${slug || "project"}.zip`;
  a.click();
}

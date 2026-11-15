// Hooks runtime proyek + agent runs (dipakai Builder).
//
// Chat AI sendiri tetap memakai fetch SSE imperatif di Builder karena
// TanStack Query tidak menangani stream incremental; yang dipindah ke
// sini adalah semua pemanggilan REST di sekitarnya.
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiFetch } from "./fetcher";
import { projectKeys } from "./queryKeys";

export function fetchAgentRuns(pid: string) {
  return apiFetch(`/projects/${pid}/agent/runs`);
}

// Polling daftar agent run. Interval mengikuti `streaming` seperti
// kode lama (1200ms saat streaming, 5000ms bila tidak).
export function useAgentRuns(pid: string, streaming: boolean) {
  return useQuery({
    queryKey: projectKeys.agentRuns(pid),
    queryFn: () => fetchAgentRuns(pid),
    enabled: !!pid,
    refetchInterval: streaming ? 1200 : 5000,
  });
}

export function useAgentRunDetail(pid: string, runId: number | undefined, streaming: boolean) {
  return useQuery({
    queryKey: projectKeys.agentRunDetail(pid, runId ?? 0),
    queryFn: () => apiFetch(`/projects/${pid}/agent/runs/${runId}`),
    enabled: !!pid && runId != null,
    refetchInterval: streaming ? 1200 : 5000,
  });
}

export function useUpdateAgentRun(pid: string) {
  return useMutation({
    mutationFn: ({ runId, phase, status, error }: { runId: number; phase: string; status?: string; error?: string }) =>
      apiFetch(`/projects/${pid}/agent/runs/${runId}`, {
        method: "PUT",
        body: JSON.stringify({ phase, status, error }),
      }),
  });
}

export function fetchRuntimeStatus(pid: string) {
  return apiFetch(`/projects/${pid}/runtime/dev/status`);
}

// Status runtime di-poll tiap 3 detik selama terminal terbuka dan
// runtime berjalan (sama seperti timer lama di Builder).
export function useRuntimeStatus(pid: string, enabled: boolean) {
  return useQuery({
    queryKey: projectKeys.runtimeStatus(pid),
    queryFn: () => fetchRuntimeStatus(pid),
    enabled: !!pid && enabled,
    refetchInterval: 3000,
  });
}

export function fetchSmokeTest(pid: string) {
  return apiFetch(`/projects/${pid}/smoke-test`);
}

// Satu hook untuk semua aksi runtime satu-tembak (start/stop, install,
// build, verifikasi, pipeline, sync). Masing-masing adalah useMutation
// agar konsisten dengan pola TanStack; tidak ada cache yang perlu
// diinvalidasi karena responsnya dipakai langsung oleh pemanggil.
export function useRuntimeActions(pid: string) {
  const sync = useMutation({
    mutationFn: () => apiFetch(`/projects/${pid}/runtime/dev/sync`, { method: "POST" }),
  });
  const start = useMutation({
    mutationFn: () => apiFetch(`/projects/${pid}/runtime/dev/start`, { method: "POST" }),
  });
  const stop = useMutation({
    mutationFn: () => apiFetch(`/projects/${pid}/runtime/dev/stop`, { method: "POST" }),
  });
  const install = useMutation({
    mutationFn: () => apiFetch(`/projects/${pid}/runtime/install`, { method: "POST" }),
  });
  const build = useMutation({
    mutationFn: () => apiFetch(`/projects/${pid}/runtime/build`, { method: "POST" }),
  });
  const dbVerify = useMutation({
    mutationFn: () => apiFetch(`/projects/${pid}/runtime/db-verify`, { method: "POST" }),
  });
  const verify = useMutation({
    mutationFn: () => apiFetch(`/projects/${pid}/runtime/verify`, { method: "POST" }),
  });
  const pipeline = useMutation({
    mutationFn: (sql: string[]) =>
      apiFetch(`/projects/${pid}/runtime/pipeline`, {
        method: "POST",
        body: JSON.stringify({ sql }),
      }),
  });
  return {
    sync: () => sync.mutateAsync(undefined),
    start: () => start.mutateAsync(undefined),
    stop: () => stop.mutateAsync(undefined),
    install: () => install.mutateAsync(undefined),
    build: () => build.mutateAsync(undefined),
    dbVerify: () => dbVerify.mutateAsync(undefined),
    verify: () => verify.mutateAsync(undefined),
    pipeline: (sql: string[]) => pipeline.mutateAsync(sql),
  };
}

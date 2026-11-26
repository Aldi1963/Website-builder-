// Hooks Dashboard: profil, notifikasi, template, deployment, domain,
// usage, billing, dan konfigurasi AI admin. Hanya endpoint yang
// benar-benar dipakai Dashboard yang dibuat hook-nya; `delTemplate`
// dan `addDomain` versi lama tidak dipakai di mana pun sehingga tidak
// dibuatkan hook.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { apiFetch } from "./fetcher";
import { dashboardKeys, projectKeys } from "./queryKeys";

export function useMe(enabled = true) {
  return useQuery({ queryKey: dashboardKeys.me, queryFn: () => api.me(), enabled });
}

export function usePublicSettings() {
  return useQuery({
    queryKey: dashboardKeys.publicSettings,
    queryFn: () => apiFetch("/public-settings"),
  });
}

export function useNotifications() {
  return useQuery({
    queryKey: dashboardKeys.notifications,
    queryFn: () => apiFetch("/notifications"),
  });
}

export function useReadNotifications() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch("/notifications/read", { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: dashboardKeys.notifications });
    },
  });
}

// ---- Templates ----
export function fetchTemplates(q = "", cat = "") {
  return apiFetch("/templates" + (q || cat ? `?q=${encodeURIComponent(q)}&category=${encodeURIComponent(cat)}` : ""));
}

export function useTemplates(q: string, cat: string, enabled = true) {
  return useQuery({
    queryKey: dashboardKeys.templates(q, cat),
    queryFn: () => fetchTemplates(q, cat),
    enabled,
  });
}

export function useUseTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      apiFetch(`/templates/${id}/use`, {
        method: "POST",
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: projectKeys.lists() });
    },
  });
}

export function usePublishTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, name, description, category }: { projectId: number; name: string; description: string; category: string }) =>
      apiFetch("/templates", {
        method: "POST",
        body: JSON.stringify({ projectId, name, description, category }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: dashboardKeys.templatesAll });
    },
  });
}

// ---- Deployments ----
export function useDeployments(enabled = true) {
  return useQuery({
    queryKey: dashboardKeys.deployments,
    queryFn: () => apiFetch("/deployments"),
    enabled,
  });
}

export function useRollbackDeployment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiFetch(`/deployments/${id}/rollback`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: dashboardKeys.deployments });
    },
  });
}

export function useDeploymentFiles(pid: string, depId: number) {
  return useQuery({
    queryKey: projectKeys.deploymentFiles(pid, depId),
    queryFn: () => apiFetch(`/projects/${pid}/deployments/${depId}/files`),
    enabled: !!pid && !!depId,
  });
}

// ---- Domains ----
export function useDomains(enabled = true) {
  return useQuery({
    queryKey: dashboardKeys.domains,
    queryFn: () => apiFetch("/domains"),
    enabled,
  });
}

export function useAddDomain() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ domain, projectId }: { domain: string; projectId: number }) =>
      apiFetch("/domains", {
        method: "POST",
        body: JSON.stringify({ domain, projectId }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: dashboardKeys.domains });
    },
  });
}

export function useDeleteDomain() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiFetch(`/domains/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: dashboardKeys.domains });
    },
  });
}

export function useVerifyDomain() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiFetch(`/domains/${id}/verify`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: dashboardKeys.domains });
    },
  });
}

export function fetchDomainDns(id: number) {
  return apiFetch(`/domains/${id}/dns`);
}

export function useDomainSsl() {
  return useMutation({
    mutationFn: (id: number) => apiFetch(`/domains/${id}/ssl`, { method: "POST" }),
  });
}

// ---- Usage & billing ----
export function useUsage(enabled = true) {
  return useQuery({
    queryKey: dashboardKeys.usage,
    queryFn: () => apiFetch("/usage"),
    enabled,
  });
}

export function useBilling(enabled = true) {
  return useQuery({
    queryKey: dashboardKeys.billing,
    queryFn: () => apiFetch("/billing"),
    enabled,
  });
}

export function useCheckout() {
  return useMutation({
    mutationFn: (plan: string) =>
      apiFetch("/billing/checkout", {
        method: "POST",
        body: JSON.stringify({ plan }),
      }),
  });
}

export function fetchPaymentStatus(orderId: string) {
  return apiFetch(`/billing/status/${orderId}`);
}

// ---- Profil, password, AI config (admin) ----
export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => apiFetch("/me", { method: "PUT", body: JSON.stringify({ name }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: dashboardKeys.me });
    },
  });
}

export function useChangePassword() {
  return useMutation({
    mutationFn: ({ oldPw, newPw }: { oldPw: string; newPw: string }) =>
      apiFetch("/me/password", {
        method: "PUT",
        body: JSON.stringify({ old: oldPw, new: newPw }),
      }),
  });
}

export function useAiConfig(enabled = true) {
  return useQuery({
    queryKey: dashboardKeys.aiConfig,
    queryFn: () => apiFetch("/admin/ai-config"),
    enabled,
  });
}

export function useSetAiConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ baseUrl, apiKey, model }: { baseUrl: string; apiKey: string; model: string }) =>
      apiFetch("/admin/ai-config", {
        method: "PUT",
        body: JSON.stringify({ baseUrl, apiKey, model }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: dashboardKeys.aiConfig });
    },
  });
}

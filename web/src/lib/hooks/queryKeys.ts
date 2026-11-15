// Query key terpusat. Semua hook memakai factory ini agar key konsisten
// dan invalidasi setelah mutasi selalu mengenai cache yang benar.

export const projectKeys = {
  all: ["projects"] as const,
  lists: () => [...projectKeys.all, "list"] as const,
  detail: (id: string) => [...projectKeys.all, "detail", id] as const,
  chat: (id: string) => [...projectKeys.detail(id), "chat"] as const,
  comments: (id: string) => [...projectKeys.detail(id), "comments"] as const,
  versions: (id: string) => [...projectKeys.detail(id), "versions"] as const,
  versionFiles: (id: string, vid: number) => [...projectKeys.versions(id), vid, "files"] as const,
  blueprint: (id: string) => [...projectKeys.detail(id), "blueprint"] as const,
  settings: (id: string) => [...projectKeys.detail(id), "settings"] as const,
  tables: (id: string) => [...projectKeys.detail(id), "tables"] as const,
  tableDetail: (id: string, name: string) => [...projectKeys.tables(id), name] as const,
  policies: (id: string) => [...projectKeys.detail(id), "policies"] as const,
  agentRuns: (id: string) => [...projectKeys.detail(id), "agent-runs"] as const,
  agentRunDetail: (id: string, runId: number) => [...projectKeys.agentRuns(id), runId] as const,
  runtimeStatus: (id: string) => [...projectKeys.detail(id), "runtime-status"] as const,
  deploymentFiles: (id: string, depId: number) =>
    [...projectKeys.detail(id), "deployments", depId, "files"] as const,
};

export const dashboardKeys = {
  me: ["me"] as const,
  notifications: ["notifications"] as const,
  templates: (q = "", cat = "") => ["templates", q, cat] as const,
  templatesAll: ["templates"] as const,
  deployments: ["deployments"] as const,
  domains: ["domains"] as const,
  domainDns: (id: number) => ["domains", id, "dns"] as const,
  usage: ["usage"] as const,
  billing: ["billing"] as const,
  aiConfig: ["admin", "ai-config"] as const,
  publicSettings: ["public-settings"] as const,
  paymentStatus: (orderId: string) => ["billing", "status", orderId] as const,
};

export const githubKeys = {
  settings: ["github"] as const,
};

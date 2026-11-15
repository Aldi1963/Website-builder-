export type AgentRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type BuildStatus = "unknown" | "queued" | "running" | "success" | "failed";

export interface ProjectSummary {
  id: number;
  name: string;
  slug: string;
  framework?: string;
  buildStatus?: BuildStatus;
  publishState?: "draft" | "stale" | "published";
}

export interface AgentRunSummary {
  id: number;
  projectId: number;
  status: AgentRunStatus;
  phase?: string;
  message?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface AgentToolCall {
  id: number;
  runId: number;
  tool: string;
  phase?: string;
  status: "queued" | "running" | "completed" | "failed" | "error";
  input?: string;
  output?: string;
  error?: string;
}

export interface ApiError {
  message: string;
  code?: string;
  requestId?: string;
}

// BEGIN GENERATED — API_ROUTES dari server/openapi.yaml (go run ./cmd/generate-openapi)
export type ApiAuthKind = "public" | "jwt-or-apikey" | "project-session";

export interface ApiRoute {
  method: string;
  path: string;
  auth: ApiAuthKind;
}

export const API_ROUTES: ApiRoute[] = [
  { method: "GET", path: "/api/admin/ai-config", auth: "jwt-or-apikey" },
  { method: "PUT", path: "/api/admin/ai-config", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/admin/ai-config/test", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/admin/ai-models", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/admin/ai-usage", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/admin/audit", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/admin/blocked", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/admin/blocked", auth: "jwt-or-apikey" },
  { method: "DELETE", path: "/api/admin/blocked/{id}", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/admin/broadcast", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/admin/export/revenue", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/admin/export/users", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/admin/maintenance", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/admin/revenue", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/admin/settings", auth: "jwt-or-apikey" },
  { method: "PUT", path: "/api/admin/settings", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/admin/stats", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/admin/templates", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/admin/templates", auth: "jwt-or-apikey" },
  { method: "PUT", path: "/api/admin/templates/{id}", auth: "jwt-or-apikey" },
  { method: "DELETE", path: "/api/admin/templates/{id}", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/admin/users", auth: "jwt-or-apikey" },
  { method: "PUT", path: "/api/admin/users/{id}", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/admin/users/{id}/impersonate", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/admin/users/{id}/plan", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/ai/enhance", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/ai/image", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/api-keys", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/api-keys", auth: "jwt-or-apikey" },
  { method: "DELETE", path: "/api/api-keys/{id}", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/app-api/{id}/auth/login", auth: "public" },
  { method: "POST", path: "/api/app-api/{id}/auth/logout", auth: "public" },
  { method: "GET", path: "/api/app-api/{id}/auth/me", auth: "public" },
  { method: "POST", path: "/api/app-api/{id}/auth/register", auth: "public" },
  { method: "POST", path: "/api/app-api/{id}/db/delete", auth: "project-session" },
  { method: "POST", path: "/api/app-api/{id}/db/insert", auth: "project-session" },
  { method: "POST", path: "/api/app-api/{id}/db/query", auth: "project-session" },
  { method: "POST", path: "/api/app-api/{id}/db/select", auth: "project-session" },
  { method: "POST", path: "/api/app-api/{id}/db/update", auth: "project-session" },
  { method: "POST", path: "/api/auth/forgot-password", auth: "public" },
  { method: "POST", path: "/api/auth/login", auth: "public" },
  { method: "GET", path: "/api/auth/oauth/status", auth: "public" },
  { method: "GET", path: "/api/auth/oauth/{provider}", auth: "public" },
  { method: "GET", path: "/api/auth/oauth/{provider}/callback", auth: "public" },
  { method: "POST", path: "/api/auth/register", auth: "public" },
  { method: "POST", path: "/api/auth/reset-password", auth: "public" },
  { method: "GET", path: "/api/billing", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/billing/checkout", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/billing/status/{orderId}", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/billing/webhook", auth: "public" },
  { method: "GET", path: "/api/deployments", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/deployments/{id}/rollback", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/domains", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/domains", auth: "jwt-or-apikey" },
  { method: "DELETE", path: "/api/domains/{id}", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/domains/{id}/dns", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/domains/{id}/ssl", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/domains/{id}/verify", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/github", auth: "jwt-or-apikey" },
  { method: "PUT", path: "/api/github", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/health", auth: "public" },
  { method: "GET", path: "/api/me", auth: "jwt-or-apikey" },
  { method: "PUT", path: "/api/me", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/me/2fa", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/me/2fa/disable", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/me/2fa/setup", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/me/2fa/verify", auth: "jwt-or-apikey" },
  { method: "PUT", path: "/api/me/password", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/notifications", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/notifications/read", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/projects", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/projects", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/projects/import-github", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/projects/{id}", auth: "jwt-or-apikey" },
  { method: "PUT", path: "/api/projects/{id}", auth: "jwt-or-apikey" },
  { method: "DELETE", path: "/api/projects/{id}", auth: "jwt-or-apikey" },
  { method: "PUT", path: "/api/projects/{id}/agent/plan", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/projects/{id}/agent/runs", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/projects/{id}/agent/runs/{runId}", auth: "jwt-or-apikey" },
  { method: "PUT", path: "/api/projects/{id}/agent/runs/{runId}", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/projects/{id}/agent/runs/{runId}/cancel", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/projects/{id}/api-docs", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/projects/{id}/app/cron", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/projects/{id}/app/cron", auth: "jwt-or-apikey" },
  { method: "PUT", path: "/api/projects/{id}/app/cron/{jobId}", auth: "jwt-or-apikey" },
  { method: "DELETE", path: "/api/projects/{id}/app/cron/{jobId}", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/projects/{id}/app/files", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/projects/{id}/app/files", auth: "jwt-or-apikey" },
  { method: "DELETE", path: "/api/projects/{id}/app/files/{name}", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/projects/{id}/blueprint", auth: "jwt-or-apikey" },
  { method: "PUT", path: "/api/projects/{id}/blueprint", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/projects/{id}/chat", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/projects/{id}/chat", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/projects/{id}/comments", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/projects/{id}/comments", auth: "jwt-or-apikey" },
  { method: "DELETE", path: "/api/projects/{id}/comments/{cid}", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/projects/{id}/comments/{cid}/resolve", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/projects/{id}/deployments", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/projects/{id}/deployments/{depId}/files", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/projects/{id}/deployments/{depId}/preview/{filepath}", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/projects/{id}/env", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/projects/{id}/env", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/projects/{id}/export", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/projects/{id}/files", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/projects/{id}/files", auth: "jwt-or-apikey" },
  { method: "DELETE", path: "/api/projects/{id}/files", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/projects/{id}/files/rename", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/projects/{id}/form-settings", auth: "jwt-or-apikey" },
  { method: "PUT", path: "/api/projects/{id}/form-settings", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/projects/{id}/forms", auth: "jwt-or-apikey" },
  { method: "DELETE", path: "/api/projects/{id}/forms/{sid}", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/projects/{id}/github/pull", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/projects/{id}/github/push", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/projects/{id}/health", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/projects/{id}/members", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/projects/{id}/members", auth: "jwt-or-apikey" },
  { method: "DELETE", path: "/api/projects/{id}/members/{mid}", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/projects/{id}/migrations", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/projects/{id}/migrations", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/projects/{id}/migrations/{mid}/rollback", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/projects/{id}/policies", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/projects/{id}/policies", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/projects/{id}/proposal", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/projects/{id}/proposal/apply", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/projects/{id}/proposal/reject", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/projects/{id}/publish", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/projects/{id}/runtime/build", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/projects/{id}/runtime/db-verify", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/projects/{id}/runtime/dev/log-stream", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/projects/{id}/runtime/dev/logs", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/projects/{id}/runtime/dev/start", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/projects/{id}/runtime/dev/status", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/projects/{id}/runtime/dev/stop", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/projects/{id}/runtime/dev/sync", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/projects/{id}/runtime/info", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/projects/{id}/runtime/install", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/projects/{id}/runtime/matrix", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/projects/{id}/runtime/pipeline", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/projects/{id}/runtime/preview/{filepath}", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/projects/{id}/runtime/preview/{filepath}", auth: "jwt-or-apikey" },
  { method: "PUT", path: "/api/projects/{id}/runtime/preview/{filepath}", auth: "jwt-or-apikey" },
  { method: "PATCH", path: "/api/projects/{id}/runtime/preview/{filepath}", auth: "jwt-or-apikey" },
  { method: "DELETE", path: "/api/projects/{id}/runtime/preview/{filepath}", auth: "jwt-or-apikey" },
  { method: "HEAD", path: "/api/projects/{id}/runtime/preview/{filepath}", auth: "jwt-or-apikey" },
  { method: "OPTIONS", path: "/api/projects/{id}/runtime/preview/{filepath}", auth: "jwt-or-apikey" },
  { method: "CONNECT", path: "/api/projects/{id}/runtime/preview/{filepath}", auth: "jwt-or-apikey" },
  { method: "TRACE", path: "/api/projects/{id}/runtime/preview/{filepath}", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/projects/{id}/runtime/screenshot", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/projects/{id}/runtime/screenshots/{name}", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/projects/{id}/runtime/verify", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/projects/{id}/seo", auth: "jwt-or-apikey" },
  { method: "PUT", path: "/api/projects/{id}/seo", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/projects/{id}/settings", auth: "jwt-or-apikey" },
  { method: "PUT", path: "/api/projects/{id}/settings", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/projects/{id}/share", auth: "jwt-or-apikey" },
  { method: "DELETE", path: "/api/projects/{id}/share", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/projects/{id}/smoke-test", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/projects/{id}/stats", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/projects/{id}/tables", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/projects/{id}/tables", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/projects/{id}/tables/{name}", auth: "jwt-or-apikey" },
  { method: "DELETE", path: "/api/projects/{id}/tables/{name}", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/projects/{id}/tables/{name}/columns", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/projects/{id}/tables/{name}/rows", auth: "jwt-or-apikey" },
  { method: "PATCH", path: "/api/projects/{id}/tables/{name}/rows/{rowId}", auth: "jwt-or-apikey" },
  { method: "DELETE", path: "/api/projects/{id}/tables/{name}/rows/{rowId}", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/projects/{id}/versions", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/projects/{id}/versions/checkpoint", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/projects/{id}/versions/{vid}/files", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/projects/{id}/versions/{vid}/restore", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/projects/{id}/webhooks", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/projects/{id}/webhooks", auth: "jwt-or-apikey" },
  { method: "DELETE", path: "/api/projects/{id}/webhooks/{wid}", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/public-settings", auth: "public" },
  { method: "GET", path: "/api/templates", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/templates", auth: "jwt-or-apikey" },
  { method: "DELETE", path: "/api/templates/{id}", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/templates/{id}/use", auth: "jwt-or-apikey" },
  { method: "POST", path: "/api/upload", auth: "jwt-or-apikey" },
  { method: "GET", path: "/api/usage", auth: "jwt-or-apikey" },
  { method: "GET", path: "/app-files/{projectID}/{name}", auth: "public" },
  { method: "POST", path: "/f/{token}", auth: "public" },
  { method: "GET", path: "/healthz", auth: "public" },
  { method: "GET", path: "/metrics", auth: "public" },
  { method: "GET", path: "/pub-assets/{slug}/{filepath}", auth: "public" },
  { method: "GET", path: "/pub/{slug}", auth: "public" },
  { method: "GET", path: "/readyz", auth: "public" },
  { method: "GET", path: "/share-assets/{token}/{filepath}", auth: "public" },
  { method: "GET", path: "/share/{token}", auth: "public" },
];

/** Ganti parameter path {id} dengan nilai, mis. apiPath("/api/projects/{id}/chat", { id: "12" }). */
export function apiPath(path: string, params: Record<string, string | number> = {}): string {
  let out = path;
  for (const [k, v] of Object.entries(params)) out = out.replace(`{${k}}`, encodeURIComponent(String(v)));
  return out;
}
// END GENERATED

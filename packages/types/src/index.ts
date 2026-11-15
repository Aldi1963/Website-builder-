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

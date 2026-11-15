# Agent worker boundary

Reserved service boundary for AI planning, generation, repair, and evaluation jobs.

The current production orchestrator remains in `server/internal/handler`. This service is intentionally scaffolded first so queue/worker extraction can happen behind an explicit contract without interrupting active projects.

Contract: consume an `AgentJob` and emit durable `AgentRun`/`AgentToolCall` events through the API-owned store. Never receive secrets through job payloads.

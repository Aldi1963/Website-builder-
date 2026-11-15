# Agent queue boundary

`server/internal/queue` defines the stable queue contract used by future agent-worker extraction.

- `Queue.Enqueue` accepts a bounded job.
- `Queue.Run` consumes jobs with a context and handler.
- `InProcess` is the current safe adapter for development and single-node deployment.
- Redis/Asynq should be added as a second adapter only after persistence, retry, idempotency, and cancellation semantics are tested.

The current chat SSE pipeline remains unchanged until the adapter is wired to durable `AgentRun` creation and event streaming end to end.

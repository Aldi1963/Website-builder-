# Architecture

## Runtime layers

- `server/`: Go HTTP API and orchestration layer.
- `server/internal/handler/`: authenticated project, agent, runtime, database, deployment, and admin handlers.
- `web/`: React + TypeScript application built with Vite.
- Generated project runtime data is stored outside the source repository.

## Agent lifecycle

```text
analyze → plan → generate → apply → sync → install/build
→ database verify → runtime → browser acceptance → publish
```

The backend owns run state, tool activity, retries, diagnostics, and permissions. The frontend subscribes to that state and renders chat, activity, code, database, preview, and version tools.

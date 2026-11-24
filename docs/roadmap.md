# Platform roadmap

## Delivered foundation

- React 19 + TypeScript + Vite dashboard
- Go API and backend-owned agent lifecycle
- Shared TypeScript contracts in `packages/types`
- Shared UI package boundary in `packages/ui`
- TanStack Query, Zustand, Zod, React Hook Form, Radix UI, and Sonner dependencies prepared
- Python worker boundary prepared under `services/agent-worker`

## Next vertical slices

1. Move API fetching into TanStack Query hooks.
2. Move builder UI state into a project-scoped Zustand store.
3. Generate OpenAPI/TypeScript contracts from the Go API.
4. Extract agent jobs behind a queue adapter with an in-process implementation first.
5. Add Redis/Asynq as an optional production queue after the adapter contract is tested.
6. Isolate generated runtimes with a container/OCI adapter.
7. Add OpenTelemetry traces and structured run correlation IDs.
8. Add generated-app profiles for Next.js, Expo, and Tauri.

Each slice must preserve the current API, preview, database, and project data contracts and pass frontend/backend/runtime verification before deployment.

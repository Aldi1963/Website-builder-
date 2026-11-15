# WebBuilder

AI-powered full-stack application builder.

WebBuilder turns natural-language requirements into production-ready web projects. It supports adaptive discovery, code generation, build verification, runtime preview, database inspection, version history, and deployment.

## Repository layout

```text
.
├── server/       Go API, agent orchestration, runtime, database handlers
├── web/          React + TypeScript frontend (Vite)
├── packages/     Shared workspace packages (ui: shared React UI, types: shared TypeScript types)
├── services/     Agent worker (Python) — see services/agent-worker/README.md
├── docs/         Architecture and development notes
├── scripts/      Backup and restore helpers (backup.sh, restore.sh)
├── .env.example  Environment variable reference
└── .gitignore    Source-control safety rules
```

## Development

### Backend

```bash
cd server
go test ./...
go build .
```

### Frontend

```bash
cd web
pnpm install
pnpm typecheck
pnpm build
```

### Backup and restore

```bash
scripts/backup.sh
scripts/restore.sh
```

See `scripts/` for usage and what each script backs up. Backups, runtime
data and databases are excluded from Git (see `.gitignore`).

## Configuration

Server configuration is documented in `.env.example` — it lists every
variable the Go server reads, which ones are required, and which settings
instead live in the database (admin panel). Copy it to `.env` locally
and never commit secrets. Startup validation for the required variables
lives in `server/internal/config/`.

## Security

Runtime data, databases, credentials, tokens, logs, generated bundles, and compiled binaries are intentionally excluded from Git. Copy `.env.example` to `.env` locally and never commit secrets.

## License

Proprietary — see [LICENSE](LICENSE). All rights reserved.

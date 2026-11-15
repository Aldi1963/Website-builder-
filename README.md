# WebBuilder

AI-powered full-stack application builder.

WebBuilder turns natural-language requirements into production-ready web projects. It supports adaptive discovery, code generation, build verification, runtime preview, database inspection, version history, and deployment.

## Repository layout

```text
.
├── server/       Go API, agent orchestration, runtime, database handlers
├── web/          React + TypeScript frontend (Vite)
├── docs/         Architecture and development notes
├── scripts/      Local development and deployment helpers
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
pnpm build
```

## Security

Runtime data, databases, credentials, tokens, logs, generated bundles, and compiled binaries are intentionally excluded from Git. Copy `.env.example` to `.env` locally and never commit secrets.

## License

Proprietary project. All rights reserved.

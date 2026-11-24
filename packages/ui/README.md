# @webbuilder/ui

Shared React UI primitives for the WebBuilder frontend (`web/`).
Small on purpose: only code that is genuinely used by more than one
place belongs here.

## What is in here

- `Button` (`src/Button.tsx`) — thin shared button wrapper.
- `cn` (`src/utils.ts`) — class-name join helper.
- Brand tokens (`src/theme.ts`) — `BRAND_ORANGE` (`#F6821F`) and
  `BRAND_ORANGE_SOFT` (`#fff7ed`). These are the only values that are
  actually duplicated across `web/src` today (the `ORANGE` constant is
  copy-pasted in `App.tsx`, `pages/AdminPanel.tsx`,
  `pages/ApiDocs.tsx` and `pages/Builder.tsx`).

## Limits — read before adding anything

- **This package is currently not imported by `web/` at all.**
  `web/src` has no `components/` directory; every component is defined
  file-locally inside its page (`web/src/pages/*`, `web/src/Rebuild.tsx`),
  and the class names are mostly one-off page styles
  (`r-*`, `wb-*`). The repeated class names found by grep (e.g.
  `wb-text-btn` ×3, `r-control-modal` ×3) are page-local CSS hooks, not
  shared components — extracting them would only move the duplication,
  not remove it.
- **Do not invent components to fill this package.** A shared component
  earns its place only when at least two consumers in `web/src` use the
  same markup/behaviour. The `theme.ts` tokens above are the only such
  case found in this audit (2026-11-15); `Button` predates the audit
  and is kept for future use.
- Migrating `web/src` to import `BRAND_ORANGE` / `Button` from here is
  a separate step (it touches `web/src`, outside this package) and has
  not been done yet.

## Checks

```bash
pnpm --filter @webbuilder/ui typecheck
```

# Phase 11 Prod Deploy Memo — Dashboard (8 Panels)

Date: 2026-07-04. Worker: `the-brain`. Rollback tag: `deploy-phase-11-prev`.
Deploy tag: `phase-11-complete`.

## Surface changes

- FIRST Workers Static Assets deploy: `[assets] ./public` (asset-first for
  matching paths, Worker fallthrough). `/dashboard/` serves the 8-panel SPA.
  CF Access gates the hostname (G5), so assets are edge-protected; every
  `/api/*` feed still runs behind authMiddleware.
- NEW CF-Access data feeds (routes/dashboard-data.ts): `/api/memory/search`,
  `/api/traces/{recent,:id}`, `/api/usage/summary`, `/api/connections`
  (presence booleans + scope names only — never token material).
- Panels: memory browser+graph (7 broker modes), live agents w/ heartbeat +
  cancel/retry, timeline, consolidation viewer (dream report + review inbox),
  automations manager, connections + compiled-pages index, usage (audit-
  derived counts; model spend lives in the AI Gateway dashboard), retrieval-
  trace inspector.

## Risks

- First [assets] deploy on this worker — watch that existing Worker routes
  (e.g. /dashboard/agents) still resolve (no asset file shadows them; the
  only asset directory is /dashboard/index.html).
- Deploy-propagation race on smokes: wait ~12s post-deploy (Phase 10 lesson).

## Smoke plan

`npx tsx scripts/mission-phase11-live-smoke.ts`: SPA serves with all 8 panel
sections → all 9 feeds 200 → a memory search leaves a broker trace visible in
the inspector feed (demo clause 7 mechanical assertion).

## OUTCOME

- pending

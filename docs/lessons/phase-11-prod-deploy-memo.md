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

- Verifier REQUEST_CHANGES (XSS sinks, no-op memory loader, config nits) ->
  all fixed: SPA rewritten to strict DOM discipline (every API value via
  textContent, delegated data-* actions, encoded URLs; the sink grep's only
  hit is a prose comment), memory panel auto-loads a recent-memories default
  feed (new /api/memory/search no-q behavior), timeline gained cancel/retry,
  assets config pinned.
- Live finding: directory-index resolution 307-looped with a user Worker
  attached (/dashboard/index.html -> /dashboard/ -> Worker 404) — served as
  an exact-file asset /dashboard.html instead (deterministic; keeps
  /dashboard/agents unshadowed).
- Deploys 25e9f5a3 -> 5a7a2b30. **Smoke GREEN 12/12**: SPA 17.5k chars w/
  8/8 panel sections; all 9 feeds 200; broker trace recorded end-to-end.
- Demo clause 7 (all 8 panels visible + functional, CF Access enforced): MET.
  Dashboard: https://haetsalos.specialdarksystems.com/dashboard.html

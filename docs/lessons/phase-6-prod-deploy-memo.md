# Phase 6 Prod Deploy Memo — Sub-Agent Spawn + Cancel/Retry

Date: 2026-07-04. Worker: `the-brain` at haetsalos.specialdarksystems.com.
Rollback tag: `deploy-phase-6-prev` (captured immediately before deploy).
Deploy tag: `phase-6-complete`.

## What this deploy changes on the exposed surface

- Two NEW CF-Access-protected route groups on the existing Worker (Law 1
  unchanged — no new hostname/port/service):
  - `GET /api/agents/runs`, `POST /api/agents/runs/:id/cancel`,
    `POST /api/agents/runs/:id/retry`
  - `GET /dashboard/agents` (minimal live-agent panel)
  Both registered after `authMiddleware()` in the Hono chain, same as
  `/api/actions`.
- Inbound Telegram/Sendblue TEXT paths gain a delegation decision in front of
  the grounded reply. Conservative default is inline; delegation failures fall
  back to the existing reply path, so worst case equals current behavior.
- New DO facet class `ExecutionAgent` exported from the worker entry. No
  wrangler binding/migration change (facets resolve via ctx.exports; verified
  against the installed SDK source). `wrangler deploy --dry-run` builds clean.
- McpAgentDO gains 5 RPC methods; `cf_agent_tool_runs` +
  `haetsal_agent_tasks` + (facet-local) `haetsal_execution_runs` tables are
  created lazily in DO SQLite on first use. No D1 migration in this phase.

## Known risk + the one knob

`ctx.facets` availability at `compatibility_date = 2026-06-01` cannot be
exercised in the vitest pool (test entry excludes the agents-SDK DO by
design). If the live smoke's dispatch fails with the SDK's explicit error
("subAgent() is not supported in this runtime — update compatibility_date"),
the fix is a one-line `compatibility_date` bump + redeploy; the delegation
path degrades to inline replies in the meantime (honest fallback, user impact
zero beyond missing the new feature). Rollback = redeploy `deploy-phase-6-prev`.

## Smoke plan (demo clause 6 mechanism, self-driven via service token)

Auth: `haetsal-brain-shell-smoke` CF Access service token
(CF-Access-Client-Id/Secret headers from the shell env — never printed). The
token maps to its own tenant/DO, so the smoke exercises the full mechanism
without touching Matt's tenant.

1. `GET /dashboard/agents` — 200 panel HTML; the route runs initTenant so the
   smoke tenant's DO holds a TMK.
2. `GET /api/agents/runs` — `[]` (DO RPC wiring proven).
3. `POST /api/agents/runs {task, profile:'research'}` — 201 `{runId}`. This
   is the facets go/no-go moment (see the knob above).
4. Poll `GET /api/agents/runs` — `running` row, tools
   `[web_search, recall_memory]`, progress phase + heartbeat age advancing.
5. `POST /api/agents/runs/:id/cancel` mid-run — row flips `aborted` within 5s
   (timestamped polling proves the demo-clause bar).
6. `POST /api/agents/runs/:id/retry` — new run with `retryOf` lineage; let it
   run to `completed` (real Brave search + gateway llama in prod). The runs
   API exposes no output field; ledger output is TMK ciphertext.
7. Matt's live channel flow (Telegram text → delegation ack → result message)
   is wired through the same dispatch seam and covered by contract tests;
   Matt can live-fire it from his phone anytime after this gate.

Telegram is the delivery channel of record (Sendblue Free Tier inbound
unreliable — Phase 4 finding).

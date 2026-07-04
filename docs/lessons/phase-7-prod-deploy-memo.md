# Phase 7 Prod Deploy Memo — User Automations

Date: 2026-07-04. Worker: `the-brain`. Rollback tag: `deploy-phase-7-prev`.
Deploy tag: `phase-7-complete`.

## Surface changes

- NEW CF-Access-protected routes: `/api/automations` (GET list, POST create,
  POST :id/toggle, DELETE :id). Registered after `authMiddleware()`.
- NEW MCP tools on the DO server: `create_automation`, `list_automations`,
  `toggle_automation`, `delete_automation`.
- Channel text paths gain an automation-intent check ahead of the delegation
  decider; unparseable text falls through unchanged (worst case = Phase 6
  behavior).
- McpAgentDO gains the `fireAutomation` schedule callback + automation RPCs.
  New DO SQLite tables `haetsal_automations` / `haetsal_automation_events`
  (lazy DDL). `haetsal_agent_tasks` gains an `origin` column via a guarded
  forward `ALTER TABLE` (created-by-Phase-6 tables in prod lack it).
- No wrangler config change, no D1 migration, no new binding.

## Risks

- The `fireAutomation` alarm fires on the tenant DO via the SDK scheduler —
  same machinery as Phase 5 reminders (proven live). TMK at fire time comes
  from the persisted jwt_sub hydration; a cold DO with no persisted session
  records `skipped_no_session` and re-arms (honest, no retry).
- Sendblue-delivered automations outside the 24h reply window log
  `skipped_outside_reply_window` and never retry (mission rule). Telegram is
  the default delivery route.

## Smoke plan (demo clause 5 mechanism, self-driven)

`npx tsx scripts/mission-phase7-live-smoke.ts`:
create (daily slot ~2 min out) → armed → FIRES (lastStatus=dispatched, event
row with run id, re-armed for tomorrow) → the spawned run reaches terminal →
delivery event recorded (smoke tenant has no chat; delivery_failed expected)
→ toggle-off disarms → delete removes. Matt's real chat flow ("every weekday
at 8am, brief me on my day" over Telegram) rides the same seam and is
contract-tested; he can create one from his phone any time.

## OUTCOME (filled post-deploy)

- pending

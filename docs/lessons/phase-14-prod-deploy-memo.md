# Phase 14 Prod Deploy Memo

Date: 2026-07-05. Worker: `the-brain` (haetsalos.specialdarksystems.com).

## What shipped

1. **System panel** (dashboard panel #9): every agent + its live prompt,
   models per role, sub-agent tool profiles, action-tool gates, the cron
   clock, scheduled-job toggles, and capability-class approval preferences.
2. **User-editable prompts with git-grade governance**: registry of
   editable (chat persona, grounded-reply persona, sub-agent preamble) and
   read-only (dream extract, write-policy classifier, dormant personas)
   prompts; per-tenant overrides sealed `KEK1:` in D1
   (`system_prompt_overrides`, migration 1027 + runtime ensure-DDL),
   versioned on every save, rollback/reset with history retained,
   content-free audit rows. Resolution fails open to code defaults.
3. **Prompt-duplication fix**: the chat persona previously lived as two
   drifting copies (ingest.ts / inbound-message.ts) — now one registry
   default with `{channel}` substitution.
4. **scheduled_tasks.enabled enforced** (was seeded, never read): morning
   brief, dream cron, and heartbeat now honor per-tenant toggles; manual
   dream runs bypass deliberately; weekly_synthesis surfaced as dormant.
5. Law 3 hardening: prompt writes reachable only via CF-Access user routes;
   no MCP/agent tool exposes the surface (contract-tested).

## Deploy record

- Rollback tag: `deploy-phase-14-prev` (Phase 13 closeout HEAD, version
  `716cb21f` + chat-retry `7f1ea4a0`).
- Phase 14 deploy version: PENDING (filled post-deploy).
- D1 migration 1027: table also runtime-ensured (`CREATE IF NOT EXISTS`,
  same pattern as canary/decay), so prod correctness does not depend on a
  separate `d1 migrations apply` step.

## Verification at this gate

- `npm run checkout` green: 489 passed / 1 skipped / 79 files (two
  first-run failures — missing `resolveSystemPrompt` imports in
  messaging-helpers.ts and ingest.ts — caught by mission-4.x channel
  contracts and fixed before commit).
- `tests/mission-14.0-system-panel.test.ts`: 7 contracts (sealed rows,
  content-free audit, version history/rollback/reset, KEK-loss fail-open,
  non-editable rejection, Law 3 tool-surface guard, task-toggle
  round-trip + audit).
- Fresh-context verifier: **PASS-WITH-NOTES, 0 blockers, APPROVE** — all 10
  audit areas verified (sealed rows, fail-open on every chat site, Law 3
  write-surface isolation incl. mount-order check, defaults string-identical
  to the removed literals, no import cycles, file hygiene). Notes: versions
  endpoint returns plaintext to the authenticated browser only (by design);
  ingest-route resolve is a Telnyx-gated fail-open read (by design);
  weekly_synthesis toggle awaits a real handler; el() href branch flagged
  for future panel authors.
- Live smoke `scripts/mission-phase14-live-smoke.ts`: PENDING.

## Rollback

`npx wrangler rollback` to `7f1ea4a0`, or redeploy tag
`deploy-phase-14-prev`. Overrides are additive data — rolling back code
leaves them inert (old code never reads the table), and the registry
defaults keep all surfaces working.

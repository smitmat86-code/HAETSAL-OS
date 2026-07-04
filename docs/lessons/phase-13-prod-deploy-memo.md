# Phase 13 Prod Deploy Memo

Date: 2026-07-04. Worker: `the-brain` (haetsalos.specialdarksystems.com).

## What shipped

1. **Approved-action cold-DO fix (root cause of the Phase 5 gap)**: the action
   queue consumer resolved the session DO by RAW tenant id instead of
   `getMcpAgentObjectName(tenant)` — the TMK could never be found on a cold
   path. Fixed identity + key-family-tagged payload sealing (`TMK1:` warm /
   `KEK1:` Cron-KEK fallback / legacy untagged = TMK) with family-aware
   decrypt in `approved-execution.ts` that fails loudly cross-family
   (KEK ≠ TMK, Phase 8 proof applied structurally).
2. **Compiled R2 artifacts actually encrypted** (`sealArtifacts`; the
   `contentEncrypted` metadata field is now true).
3. **GATEWAY_CHAT_EMPTY** log reduced to shape metadata only.
4. **Hourly canary sweep** (6 probes: capture/recall/graph/contradiction-
   surface/compiled-regen/session-evidence) on the cron + on-demand routes
   `/api/dream/canary/{run,latest}`; content-free `canary_runs` rows.
5. **Clause-10 closeout**: `tenant.ts` stale Hindsight narrative replaced
   with an explicit REMOVAL SHIM; legacy column fields annotated inert.
6. Ops runbook + closeout ADRs: `docs/lessons/phase-13-ops-runbook.md`.

## Deploy record

- Rollback tag: `deploy-phase-13-prev` (pre-Phase-13 HEAD).
- Hardening deploy: version `a0e9291b-d4f2-4061-a65c-478536815933`
  (commit tagged `phase-13-complete`).
- Closeout deploy (clause-10 fix + demo/docs): delta vs `phase-13-complete`
  is the tenant.ts rename/comments + docs/scripts — no behavior change.
- Final closeout deploy version: PENDING (filled in post-deploy).

## Verification at this gate

- `npm run checkout` green (postflight → 479 tests passed / 77 files →
  postflight).
- Fresh-context verifier: **PASS-WITH-NOTES, 0 blockers, APPROVE** — all 8
  audit areas verified at code level (DO identity, family-tagged sealing +
  dual decrypt, sealed artifacts, shape-only gateway log, content-free
  canaries, clause-10 classification, G2 hygiene). Notes (all low-risk):
  canary `note` field annotated as content-free (done); approve-route null-TMK
  path fails loudly via WebCrypto rather than a family-specific message;
  sealed-artifact reader gap already recorded as runbook ADR #5.
- Full-demo sweep: `scripts/mission-phase13-full-demo.ts` — final-run counts
  PENDING (filled in post-deploy; details in
  `docs/lessons/phase-13-demo-verification.md`).

## Rollback

`npx wrangler rollback` to `a0e9291b` (hardening) or the Phase 12 version
`2ffcccf6` (tag `deploy-phase-13-prev`); both verified paths.

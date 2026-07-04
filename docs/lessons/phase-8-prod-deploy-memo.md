# Phase 8 Prod Deploy Memo — Dream/Janitor Consolidation Loop

Date: 2026-07-04. Worker: `the-brain`. Rollback tag: `deploy-phase-8-prev`.
Deploy tag: `phase-8-complete`.

## Surface changes

- NEW Workflow `brain-dream-cycle` (binding `DREAM_WORKFLOW`, class
  `DreamCycleWorkflow`) — first deploy registers it.
- 2am cron now starts the dream cycle (replaces the parked pass-1..4
  consolidation invocation; the old module stays on disk, unwired).
- NEW CF-Access routes: `POST /api/dream/run`, `GET /api/dream/latest`,
  `GET /api/dream/reviews`.
- Morning brief gains a "While You Slept" section (26h freshness window;
  silently absent when no completed run).
- D1: `dream_runs` table (content-free counts/ids; migration 1024 + lazy DDL
  fallback per Phase 5 precedent).

## Law notes

- Law 2 / Workflows: step results are persisted by the Workflows engine, so
  the content-bearing stage runs inside ONE step and returns counts/ids only.
  Report body lives in canonical (governed retain, source `cron:dream`);
  proposals live in canonical `reviews`.
- Law 3: report-only — promotion-grade findings wait in the review inbox;
  nothing auto-promotes; no hard deletes anywhere in the cycle.

## Smoke plan

`npx tsx scripts/mission-phase8-live-smoke.ts`: manual trigger (202) →
workflow completes → run row carries counts + report ids → report body reads
back with the report-only guarantee line → review inbox lists pending dream
proposals. Demo clause 9's overnight assertion (dream section in Matt's 8am
brief) completes naturally after tonight's 2am cron + tomorrow's 7:00 brief.

## OUTCOME

- Deploys: `334daebd` (initial) → `37b1fa90` (Cron-KEK fix after the live run
  failed with "retainContent requires TMK" — cron context needs the KEK, and
  missing KEK now DEFERS honestly) → `303c5648` (report read path uses the
  KEK: **proven that KEK ≠ TMK**, settling the Phase 5 follow-up — see
  phase-8-dream-cycle.md).
- **Smoke GREEN 6/6**: trigger 202 → workflow completed (both steps green,
  step output `[REDACTED]` by sensitive flag) → 18-memory window read →
  report persisted + read back with the report-only guarantee line → review
  inbox serving pending dream proposals.
- Verifier+Law-2 combined agent: PASS/APPROVE (9 criteria; 4 low gaps all
  fixed same-session: fixed-vocab workflow errors, sensitive:'output',
  decided-proposal dedup, test typing).
- Demo clause 9 overnight leg: tonight's 2am cron + tomorrow's 7:00 brief
  ("While You Slept" section) complete the assertion for Matt's tenant.

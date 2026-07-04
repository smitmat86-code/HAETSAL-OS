# Phase 12 Prod Deploy Memo — Memory Decay + Multimodal Confirmation

Date: 2026-07-04. Worker: `the-brain`. Rollback tag: `deploy-phase-12-prev`.
Deploy tag: `phase-12-complete`.

## Surface changes

- Metadata-only decay pass (services/decay/pass.ts): half-life recency +
  broker-trace access reinforcement + user-source boost; soft states in the
  content-free D1 `memory_decay` table (migration 1026 + lazy DDL). The
  module takes NO key material — Law 2 by construction (verifier-confirmed).
- Dream workflow gains an independent `dream-decay-pass` step (own try/catch:
  a decay failure is an audit note, never a cycle-stopper; runs on
  KEK-deferred nights too).
- NEW CF-Access routes: `POST /api/dream/decay/run`, `GET /api/dream/decay/summary`.
- Multimodal (clause 8): unchanged since Phase 4; mission-4.0/4.1 contracts
  re-asserted green at this gate (15/15).

## Follow-up (verifier, medium)

- CANDIDATE_LIMIT=200 recency window: items beyond the most recent 200 are
  never re-scored. Phase 13: page candidates by scoring staleness.

## Smoke plan

POST /api/dream/decay/run → 202 with counts; GET summary reflects states.

## OUTCOME

- pending

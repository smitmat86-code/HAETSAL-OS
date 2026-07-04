# Phase 10 Prod Deploy Memo — Compiled Markdown Pages

Date: 2026-07-04. Worker: `the-brain`. Rollback tag: `deploy-phase-10-prev`.
Deploy tag: `phase-10-complete`.

## Surface changes

- NEW CF-Access routes `/api/compiled`: list, GET page (text/markdown with
  frontmatter), POST rebuild, DELETE (deregister).
- Compiler subject gains an optional `kind` (person|project|topic) — default
  'project' preserved for all existing callers (11.x regression suites at
  the gate). Kind-embedded subject keys prevent cross-kind slug collisions.
- D1 `compiled_pages` registry (content-free; migration 1025 + lazy DDL).

## Notes

- Pages re-render from persisted canonical views — regenerable from canonical
  by construction; delete = deregistration (canonical compiled rows overwritten
  on rebuild; full deletion = Phase 13 store item).
- FLAGGED pre-existing (11.x, untouched): compiled ARTIFACTS (R2) store
  plaintext markdown in a field named `contentEncrypted`. Phase 13 ADR:
  encrypt or accept-as-raw-media. Pages do not read artifacts.

## Smoke plan

`npx tsx scripts/mission-phase10-live-smoke.ts`: rebuild person:matt +
project:haetsal + topic:serverless-postgres from the smoke tenant's canonical
→ GET all three as markdown with frontmatter → list ≥3 → delete → 404 →
rebuild → 200 (gate: ≥3 pages generated and readable).

## OUTCOME

- pending

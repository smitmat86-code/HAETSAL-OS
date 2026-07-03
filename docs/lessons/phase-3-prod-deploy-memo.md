# Phase 3 Prod Deploy Readiness Memo

Date: 2026-07-03
Worker: `the-brain` (haetsalos.specialdarksystems.com)

## Current prod state
- Last CODE upload: 2026-06-02T04:50Z, version `4209df4d-6471-4e42-8434-70c6b91d09ff`
  (the 10.14 post-upgrade deploy; Hindsight-era code, containers bound).
- Later deployment records today (2026-07-03T06:21Z) are `Source: Secret Change`
  only (Sendblue secret provisioning) — no code change.
- CF Access verified Phase 0 (identity + service-token policies; Sendblue
  webhook bypass app). Secrets present per Phase 0 gate.

## What deploys (two steps)

**Step A — intermediate deploy (export enabler).** Phases 1+2 code (canonical
governed writes, 7-mode broker, engines unwired) PLUS `/api/mission/hindsight-export/*`
(CF-Access-authenticated admin surface). wrangler config UNCHANGED — containers
and DO classes still declared, deployed with `--containers-rollout=none` so
container images do not roll (pattern proven in the 10.14 deploy). Effect on
prod behavior: the hard cutover goes live — writes stop flowing to Hindsight,
reads/searches run on canonical Postgres via Hyperdrive, embeddings start
flowing via Workers AI. pgvector provisions lazily on Neon at first use
(CREATE EXTENSION verified available on Neon, CF-docs pass Phase 2).

**Step B — removal deploy (after export verified).** Deletes Hindsight/Graphiti
code, containers, DO bindings, vars; adds wrangler migration v5 with
`deleted_classes = [HindsightContainer, HindsightWorkerContainer, GraphitiContainer]`;
removes the temporary export route.

## G7 export (between A and B)
- `POST /api/mission/hindsight-export/{scan,table,finalize}` driven via the
  `haetsal-brain-shell-smoke` CF Access service token.
- Reads Hindsight's own Postgres tables (same Neon `neondb`, non-canonical
  schemas) generically, plus `canonical_graph_identity_mappings`.
- Parts encrypted AES-GCM under the tenant Cron KEK (= TMK raw bytes, per
  `src/cron/kek.ts`), written to `brain-artifacts/hindsight-export-<UTC>/`
  with a metadata-only manifest. No hard-delete of the export (G7).
- KEK dependency: if Matt's tenant Cron KEK is expired, export blocks until he
  authenticates once (dashboard) to refresh it. Surfaced if hit.
- Note: Hindsight's Neon TABLES are not dropped in this phase — removal is
  code/config only, so S7 residual risk is low even beyond the export.

## Rollback
- Primary: `npx wrangler rollback` to version `4209df4d-6471-4e42-8434-70c6b91d09ff`.
- Secondary: git tag `deploy-phase-3-prev` (= `ed6d6cd`, pre-mission code
  lineage) → `wrangler deploy` from that tag.
- CAVEAT (S8): after Step B applies DO migration v5 (deleted_classes), rolling
  back to a version that still exports those classes conflicts with migration
  history; restoring container classes would need a NEW forward migration
  re-adding them. Step A carries no such risk. Mitigation: verify Step A +
  export fully before Step B; Step B smoke immediately after deploy.
- `deploy-phase-3` tag applied to the removal commit after Step B verifies.

## Pre-deploy gate checks (Step A)
- `npm run postflight` + full suite green at Phase 2 commit `c20df76`.
- `npx wrangler deploy --dry-run` bundle build passes.
- Secrets: unchanged set; new code uses only existing bindings.
- Custom domain/Access unaffected (attached to worker, not version).

# Phase 2 — Retrieval Broker Lessons

Date: 2026-07-03

1. **The 9.8 broker skeleton was the right seam.** Phase 2 did not build a new
   broker: `decideCanonicalMemoryRoute` (intent routing + explicit override),
   `executeCanonicalMemoryMode` (dispatch), and the trace-persisting
   `searchCanonicalMemoryWithBroker` all predated the mission. The cutover was:
   extend the mode union to 7, swap semantic (Hindsight recall → pgvector),
   swap graph (Graphiti mappings → canonical_edges), add lexical/temporal/
   compiled, rewrite composed as a dedup bundle.

2. **Graphiti writes were severed here, not Phase 3.** `CANONICAL_PROJECTION_KINDS`
   is now `[]`; requesting either engine kind throws; captures create zero
   projection jobs; `dispatch.status` is 'skipped' and no queue message is sent.
   The projection framework (jobs/results tables + consumer seam) survives for
   future projections (AI Search). Historical engine rows remain readable.

3. **pgvector is provisioned lazily by the store** (`vectorSearchAvailable()`:
   CREATE EXTENSION IF NOT EXISTS vector + ALTER chunks ADD embedding
   vector(768), guarded). Environments without the extension degrade semantic
   to lexical with status 'partial' — captures never fail on embedding issues.
   Embeddings: `@cf/baai/bge-base-en-v1.5` via `env.AI.run` with
   `gateway: { id, collectLog: false }` (G4). CF-docs verification of the model
   id/dims and the binding gateway option shape happens at the phase gate.

4. **Local dev substrate moved to Docker on port 5433.** When Docker Desktop is
   up, Matt's `fold-postgres` container auto-binds 5432, so the brain dev DB is
   `brain-dev-pg` (pgvector/pgvector:pg17, db brain_dev, creds matching
   .dev.vars) on **5433**. The phase-2 smoke rewrites the .dev.vars connection
   string to 5433. If Matt wants wrangler dev against local Postgres he should
   point CANONICAL_POSTGRES_CONNECTION_STRING at 5433 or stop fold-postgres.
   The Phase 1 embedded-postgres fallback in the session scratchpad is stopped.

5. **Governance store must be installed in the vitest setup file.** The broker
   writes canonical recall traces through `getCanonicalGovernanceStore`; without
   an installed InMemory store the Postgres fallback tries to load `pg` inside
   workerd (unresolvable) and surfaces unhandled rejections that fail the run
   even when all tests pass. `tests/apply-migrations.ts` now installs it.

6. **Consolidation passes are parked, not broken.** pass1 (contradiction) and
   pass4 (gaps) + weekly-synthesis reflect were Hindsight-history/reflect
   consumers; they now no-op with logged markers
   (`*_PENDING_PHASE8` / `*_RETIRED_PENDING_PHASE8`) until the Phase 8 dream
   cycle replaces them over canonical claims/edges. pass2 (bridges) already
   runs on canonical edges. Do not "fix" the no-ops before Phase 8.

7. **Graph data is sparse until Phase 8 by design.** Nothing extracts
   entities/edges at capture time anymore (Graphiti did). Graph mode reads
   whatever canonical_entities/canonical_edges contain — eval fixtures and the
   smoke seed them directly; the dream cycle populates them for real. Demo
   clause 1 (morning summary) does not depend on graph mode.

8. **The Hindsight tenant-id indirection is gone from reads.** memory_search /
   recallViaService / agents now use the canonical tenant id. `hindsight_tenant_id`
   remains only as a D1 column + DO getter until Phase 3 cleanup.

9. **`collectLog: false` suppresses the ENTIRE AI Gateway log entry** (metrics
   included), per the worker-binding-methods docs — the binding API has no
   payload-only equivalent of the REST header `cf-aig-collect-log-payload`.
   Decision: keep `collectLog: false` on content-bearing calls (stronger
   privacy than G4's minimum). Consequence: those calls contribute no per-call
   cost/token metrics to the gateway log. Revisit at Phase 11 (usage/cost
   panel) / Phase 13 — either accept aggregate-only cost data or move
   content-bearing calls to the REST endpoint with the payload-only header.

10. **Repo-hygiene advisory (pre-existing, for Matt / Phase 13):** `.dev.vars`
    is tracked in git despite the `.gitignore` entry (committed before the rule
    existed) and contains local dev credentials. Not modified this run.
    Recommendation: rotate any real values it holds and purge it from history
    as part of Phase 13 secrets hardening.

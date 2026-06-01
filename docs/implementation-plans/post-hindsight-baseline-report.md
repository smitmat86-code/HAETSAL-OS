# Post-Hindsight Baseline Report

Date: 2026-06-01 UTC
Spec: `specs/active/10.0-post-hindsight-cloudflare-baseline.md`
Scope: Inventory only. No runtime code, dependency, migration, or Cloudflare config changes were made.

## 1. Executive Baseline

Active planning tree for this session:

- `C:\Users\matth\Documents\HAETSAL OS`
- Branch: `master`
- Git state at inventory time: `master...origin/master [ahead 2, behind 6]`
- Latest local commits:
  - `34734b5 docs: add post-hindsight baseline spec`
  - `64eb362 docs: add post-hindsight open brain roadmap`
  - `ce77869 Implement brain-memory external client rollout`

Recommended implementation baseline:

- Do not begin Phase 1 from `master` as-is.
- Use the newer runtime lineage on `codex/11-4-deploy-candidate` / `C:\Users\matth\Documents\HAETSAL OS 11.4 deploy` as the implementation candidate, then merge or cherry-pick the post-Hindsight roadmap/spec commits onto it.
- Evidence: the 11.4 worktree HEAD is `d6cc009 Implement 11.4 compilation triggers`; its history includes canonical Postgres cutover and compiled synthesis commits such as `4ff1cc5 Cut canonical memory truth over to Postgres`, `bf92c38 Retire canonical D1 compatibility mirror`, and `2605f16 Implement Session 11.0 compiled synthesis foundation`.
- The roadmap explicitly anticipated this reconciliation point: if `HAETSAL OS` is active, port newer canonical Postgres and compiled-synthesis work from `HAETSAL OS 11.4 deploy` before destructive Hindsight removal (`docs/implementation-plans/post-hindsight-cloudflare-open-brain-roadmap.md:121`).

Dirty/local reference state:

- Existing dirty workflow files were present under `.omx/state/*` and `.omx/metrics.json`.
- Local reference directories are present in this worktree and are not part of the tracked active app: `gbrain/`, `OB1/`, `Second-Brain/`, `.codegraph/`.
- Additional untracked docs were present before this report: `docs/implementation-plans/cloudflare-modernization-plan.md`, `docs/implementation-plans/boop-parity-plan.md`, and `docs/second-brain-comparison-haetsal.md`.
- `C:\Users\matth\Documents\HAETSAL OS 11.4 deploy` exists, is on `codex/11-4-deploy-candidate`, and is dirty.

High-level Phase 1 readiness:

- Not ready for Cloudflare package/config upgrade until the active tree decision is made.
- Not ready for Hindsight removal until runtime paths, D1 schema dependencies, tests, and docs listed below have their own removal/replacement spec.
- Baseline active-suite tests pass when constrained to the app's `tests/` directory.
- Plain `npm test` is currently polluted by the untracked `gbrain/` checkout and is not a reliable active-tree signal.

## 2. Hindsight Inventory

### Runtime Dependency

| Finding | Why It Exists | Removal Risk | Recommended Disposition |
|---|---|---:|---|
| `hindsight/Dockerfile:6` pins `ghcr.io/vectorize-io/hindsight-api:0.5.2`. | Runs the Hindsight API and worker containers. | High | Delete after the canonical Neon/Postgres service and retrieval broker replace active Hindsight paths. |
| `package.json:14` depends on `@cloudflare/containers`. | Supports the Hindsight container classes. | Medium | Keep only if future Graphiti/sandbox/container use remains; otherwise remove after Hindsight removal. |
| `src/workers/mcpagent/do/HindsightContainer.ts:104` and `:127` define Hindsight API and worker container classes. | Cloudflare Container DO runtime for Hindsight. | High | Delete after all `env.HINDSIGHT` and `env.HINDSIGHT_WORKER` call sites are gone. |
| `package-lock.json:13` lists `@neondatabase/serverless`, but `package.json` does not. | Lockfile appears ahead/stale relative to active `master` package manifest. | Medium | Reconcile package lock during the active-tree decision before dependency upgrades. |

### Runtime Code Path

| Finding | Why It Exists | Removal Risk | Recommended Disposition |
|---|---|---:|---|
| `wrangler.toml:15`, `:21`, `:32`, `:36`, `:46`, `:50`, `:177` configure Hindsight containers, DO bindings, migrations, and dedicated-worker vars. | Active Cloudflare runtime still binds Hindsight. | High | Remove only in the Hindsight removal phase after replacements are live. |
| `src/types/env.ts:6`, `:7`, `:50`, `:54`, `:58`, `:59` expose Hindsight bindings/secrets/vars. | Runtime types match `wrangler.toml`. | High | Replace with canonical DB/Hyperdrive/retrieval broker env types. |
| `src/workers/mcpagent/index.ts:99` exports `HindsightContainer` and `HindsightWorkerContainer`. | Makes container DO classes deployable. | High | Delete with container bindings. |
| `src/workers/mcpagent/do/McpAgent.ts:6`, `:83`, `:84` prewarm Hindsight and ensure workers are running on tenant init. | Keeps Hindsight warm for interactive memory writes. | High | Replace with canonical session/retrieval warmup, if any. |
| `src/services/hindsight.ts:16`, `:24`, `:87`, `:97`, `:121`, `:130`, `:138` wraps retain/recall/reflect/operation/list/history/graph calls. | Hindsight client facade. | High | Replace with Neon-backed service/retrieval broker interfaces. |
| `src/services/hindsight-transport.ts:29`, `:55`, `:76`, `:126` resolves container stubs and starts Hindsight workers. | Container transport. | High | Delete after all service facade calls are removed. |
| `src/services/canonical-capture-pipeline.ts:53`, `:74` materializes Hindsight projection payloads and runs the compatibility retain bridge. | Canonical writes still fan out to Hindsight. | High | Replace with HAETSAL-owned projection jobs and direct Neon write/read path. |
| `src/services/canonical-semantic-recall.ts:9`, `:100`, `:107` routes semantic search through Hindsight recall. | Semantic mode is Hindsight-backed today. | High | Replace with Phase 5 retrieval broker using Postgres FTS/pgvector and optional AI Search. |
| `src/tools/recall.ts:2`, `:8`, `:28` keeps legacy recall on Hindsight. | `brain_v1_recall` compatibility. | High | Replace legacy recall with canonical `search_memory` or retire legacy tool. |
| `src/tools/retain.ts:48` requests `hindsightAsync: true`. | Interactive retain remains compatible with current Hindsight async behavior. | High | Replace with canonical async projection semantics. |
| `src/workers/mcpagent/public-webhooks.ts:54` registers `/hindsight/webhook`. | Receives Hindsight consolidation webhooks. | Medium | Replace with HAETSAL dream/janitor workflow events or remove. |
| `src/workers/mcpagent/runtime.ts:3`, `:34` schedules Hindsight operation polling every minute. | Tracks async retain lifecycle. | Medium | Convert to generic projection-job polling only if still needed. |

### Runtime Schema / State

| Finding | Why It Exists | Removal Risk | Recommended Disposition |
|---|---|---:|---|
| `migrations/1001_brain_tenants.sql:12` stores `hindsight_tenant_id`. | Tenant-to-Hindsight bank identity. | High | Keep as historical/migration source, add new canonical identity fields instead of editing old migrations. |
| `migrations/1009_hindsight_operations.sql:4` creates `hindsight_operations`. | D1 lifecycle state for async Hindsight retain. | Medium | Replace with generic `projection_jobs`/`projection_results` status or leave as historical migration. |
| `migrations/1010_hindsight_operation_availability.sql:1`, `1011_hindsight_operation_alerts.sql:1` mutate `hindsight_operations`. | Availability and alert fields. | Medium | Historical migration only after runtime no longer reads it. |
| `migrations/1012_hindsight_bank_config.sql:5` creates `hindsight_bank_config`. | Drift-aware bank provisioning ledger. | Medium | Remove runtime use; keep migration history unless a migration-squash strategy is chosen. |
| `migrations/1014_hindsight_projection_adapter.sql:1` adds Hindsight engine columns to canonical projection results. | Links canonical jobs to Hindsight engine refs. | Medium | Replace with engine-neutral or Neon-native projection metadata. |

### Test Fixture / Mock

| Finding | Why It Exists | Removal Risk | Recommended Disposition |
|---|---|---:|---|
| `vitest.config.ts:66` stubs Hindsight service binding because the container is not running locally. | Test harness safety. | Medium | Remove after Hindsight bindings leave production config. |
| `tests/support/hindsight-test-env.ts:26` builds Hindsight test env stubs. | Shared Hindsight projection/recall fixture. | Medium | Replace with retrieval broker and projection-job fixtures. |
| `tests/2.4b-hindsight-container-runtime.test.ts:9` verifies Hindsight container env contract. | Container runtime regression coverage. | Low after removal, high before removal. | Delete when container classes are deleted. |
| `tests/7.1-hindsight-projection-adapter.test.ts:99`, `tests/7.2-semantic-recall-through-canonical-interface.test.ts:14`, `tests/7.3-reflection-consolidation-alignment.test.ts:5` encode Hindsight projection, semantic recall, and reflection behavior. | Current product behavior is still Hindsight-backed. | High | Rewrite around canonical Neon/retrieval broker behavior before deleting runtime code. |

### Documentation / Planning Reference

| Finding | Why It Exists | Removal Risk | Recommended Disposition |
|---|---|---:|---|
| `README.md:54`, `README.md:69`, `ARCHITECTURE.md:19`, `ARCHITECTURE.md:205` describe Hindsight as current runtime. | Current live topology docs. | Medium | Update during Hindsight removal, not in this baseline session. |
| `MANIFEST.md:238`, `MANIFEST.md:264`, `MANIFEST.md:286` pins and summarizes Hindsight platform status. | Session truth file. | Medium | Update via manifest/docs pass after runtime changes. |
| `LESSONS.md:220`, `LESSONS.md:442`, `LESSONS.md:572` document Hindsight upgrade/container lessons. | Useful migration safety memory. | Low | Keep as historical lessons unless contradicted by new post-Hindsight rules. |
| `docs/hindsight-ops-runbook.md:1`, `docs/hindsight-rollout-backfill.md:1`, `docs/hindsight_postmortem.md:1` are Hindsight-specific operational/history docs. | Runbooks and incident history. | Low | Keep under historical docs, or mark superseded after removal. |
| `docs/advanced-open-brain-architecture.md:98`, `:164`, `:288`, `:310` still treat Hindsight as semantic engine. | Superseded by post-Hindsight roadmap. | Low | Keep only as superseded planning context. |
| `docs/implementation-plans/advanced-open-brain-implementation-plan.md:3` already marks itself superseded by the post-Hindsight roadmap. | Historical plan. | Low | Keep as historical reference. |

### Environment / Config Reference

| Finding | Why It Exists | Removal Risk | Recommended Disposition |
|---|---|---:|---|
| `.dev.vars.example:5` documents `NEON_CONNECTION_STRING` for the Hindsight container. | Direct Neon connection is currently owned by Hindsight. | Medium | Replace with Hyperdrive/Neon canonical env guidance. |
| `hindsight/hindsight.toml:10` notes Hindsight-managed migrations. | Container-side Hindsight config. | Low after removal, high before removal. | Delete with `hindsight/` directory after runtime removal. |
| `wrangler.toml:177`, `:178` set Hindsight dedicated worker vars. | Dedicated-worker topology. | Medium | Delete with Hindsight container config. |

### Dead Or Historical Reference

| Finding | Why It Exists | Removal Risk | Recommended Disposition |
|---|---|---:|---|
| `specs/completed/*`, `SESSION_LOG.md`, and older `docs/implementation-plans/completed/*` contain many Hindsight references. | Audit history. | Low | Keep as historical docs unless they confuse active docs. |
| `docs/implementation-plans/cloudflare-modernization-plan.md` exists untracked and overlaps with the new roadmap. | Local planning reference. | Low | Reconcile or archive in a docs cleanup spec. |

## 3. Cloudflare Inventory

| Primitive | Current Evidence | Planned Disposition | Notes |
|---|---|---|---|
| Workers | `wrangler.toml:2` main is `src/workers/mcpagent/index.ts`; `src/workers/mcpagent/index.ts:101` exports fetch/queue/scheduled handlers. | keep/upgrade | Current compatibility date is `2025-01-01` with `nodejs_compat` (`wrangler.toml:3`, `:4`). |
| Durable Objects | `wrangler.toml:28`, `:32`, `:36` bind `MCPAGENT`, `HINDSIGHT`, `HINDSIGHT_WORKER`. | keep/upgrade | Keep `MCPAGENT`; remove Hindsight DO classes in Phase 3. |
| Agents SDK | `package.json:16` uses `agents@0.7.5`; `src/workers/mcpagent/do/McpAgent.ts:1` imports `agents/mcp`. | adopt/upgrade | Roadmap says controlled upgrade plus Sessions/Think evaluation. |
| Sessions API | Current session state is manual DO SQLite in `src/workers/mcpagent/do/session-store.ts:16`. | adopt/evaluate | No Agents Sessions API implementation in active `master`. |
| Workflows | `wrangler.toml:156` binds `BOOTSTRAP_WORKFLOW`; `src/workflows/bootstrap.ts:8` extends `WorkflowEntrypoint`. | keep/evaluate | Current workflow is bootstrap import plus Hindsight bank config. |
| Queues | Producers/consumers in `wrangler.toml:84` through `:129`; runtime handler at `src/workers/mcpagent/runtime.ts:14`. | keep/evaluate | `QUEUE_BULK` carries canonical projection dispatch (`src/services/canonical-projection-dispatch.ts:31`). |
| Hyperdrive | No active `[[hyperdrive]]` binding in `wrangler.toml`; only historical/spec docs and `hindsight/hindsight.toml:6` comments mention it. | adopt for Neon | Phase 2 should add canonical Hyperdrive bindings after tree reconciliation. |
| AI Search | No runtime package/config found in `package.json`, `wrangler.toml`, or `src`. | adopt/evaluate | Roadmap positions AI Search as rebuildable document retrieval projection, not truth. |
| Vectorize | `wrangler.toml:132` binding `VECTORIZE`, index `brain-memory` at `:134`; `src/types/env.ts:22` exposes `VECTORIZE`. | keep/evaluate | Configured, but active read path uses Hindsight semantic recall rather than Vectorize. |
| D1 | `wrangler.toml:53` and `:62` bind `D1_US` and `D1_EU`; canonical D1 schema starts at `migrations/1013_canonical_open_brain_foundation.sql:5`. | avoid for canonical memory | Active `master` still stores canonical memory metadata in D1. Roadmap wants Neon/Postgres canonical. |
| R2 | `wrangler.toml:68`, `:72` bind artifacts and observability buckets; canonical bodies use R2 in `migrations/1013...:12`, `:50`. | keep for artifacts | Fits roadmap as artifact/raw-body shelf. |
| KV | `wrangler.toml:77` binds `KV_SESSION`; used for cron KEK and tokens. | ephemeral/config only | Keep non-canonical and avoid raw memory content. |
| Containers | `wrangler.toml:15`, `:21` configure Hindsight API and worker containers. | defer unless sandboxing needs return | Remove Hindsight containers; do not replace Hindsight with containers by default. |
| Sandboxes | No current runtime/config evidence. | defer/evaluate | Only adopt if secure code execution becomes concrete. |
| Workers Mesh | No current runtime/config evidence. | evaluate only if service topology needs it | Not needed for baseline. |
| Browser Rendering | `wrangler.toml:151` binds `BROWSER`; browse tool uses Cloudflare Browser Rendering. | keep/evaluate | Peripheral to memory migration. |
| Analytics/Observability | `[observability]` enabled in `wrangler.toml:6`; Analytics Engine binding at `wrangler.toml:140`. | keep/evaluate | Must not store raw memory content. |

Package baseline:

- `wrangler`: `package.json:29` has `^4.83.0`.
- `@cloudflare/workers-types`: `package.json:23` has `^4.20250303.0`; lock resolves `4.20260416.2`.
- `@cloudflare/vitest-pool-workers`: `package.json:22` has `^0.14.7`.
- `agents`: `package.json:16` has `^0.7.5`.
- `ai`: `package.json:17` has `^6.0.116`.
- `@cloudflare/ai-chat` appears only as an optional/transitive peer in `package-lock.json:2073`, not as a direct dependency.
- No direct `@cloudflare/think`, AI Search package, `pg`, or `postgres` package is configured in active `master`.
- `@neondatabase/serverless` appears in `package-lock.json:13` but not `package.json`; reconcile before any package upgrade.

## 4. Canonical Data and Memory Flow

| Area | Current State | Evidence | Notes |
|---|---|---|---|
| Chat/session capture | Present but partial | `src/agents/base-agent.ts:125` writes a session summary; `src/workers/mcpagent/do/session-store.ts:16` persists tenant/JWT/interview state only. | No Agents Sessions API yet. Sessions are not canonical truth. |
| Explicit memory capture | Present and active | `src/tools/canonical-memory.ts:75` registers `capture_memory`; `src/services/external-client-memory-write.ts:10` routes to `retainViaService`; `src/services/ingestion/retain.ts:54` enters canonical pipeline. | Active writes still include Hindsight compatibility. |
| Artifact-linked capture | Present and active | `src/tools/canonical-memory.ts:34` accepts `artifact_ref`; `src/services/external-client-memory.ts:83` normalizes artifact refs; `migrations/1013...:26` creates `canonical_artifacts`. | R2 is used for encrypted bodies/artifacts. |
| Document/source ingestion | Present and active | `src/workers/ingestion/handlers.ts:37`, `:54`, `:71` handle Gmail, Calendar, Obsidian; historical import queues Gmail/Calendar/Drive in `src/services/bootstrap/historical-import.ts:25`, `:61`, `:100`. | Ingested artifacts end at `retainContent`. |
| Retrieval | Present and partial | `src/services/canonical-memory-query.ts:64` routes modes; raw reads D1/R2, semantic calls Hindsight at `src/services/canonical-semantic-recall.ts:107`, graph reads Graphiti mappings at `src/services/canonical-graph-query.ts:59`. | Needs post-Hindsight broker. |
| Graph/timeline queries | Present and partial | `src/tools/canonical-memory.ts:98`, `:103`; `src/services/canonical-graph-query.ts:78`, `:107`; schema in `migrations/1018_graphiti_ingestion_projection.sql:1`. | Graphiti remains a projection, not canonical. |
| Reflection/consolidation | Present but Hindsight-coupled | `src/cron/consolidation.ts:68`; passes at `src/cron/passes/pass1-contradiction.ts:14`, `pass2-bridges.ts:18`, `pass3-patterns.ts:30`, `pass4-gaps.ts:14`. | Phase 6 should replace this with HAETSAL dream/janitor workflows. |
| Contradiction handling | Present but partial | `src/cron/passes/pass1-contradiction.ts:2`, `:51`; `migrations/1008_brain_consolidation.sql:26` stores gaps, not contradictions as first-class canonical claims. | Current contradiction detection depends on Hindsight memory history. |
| Markdown-authored truth | Present but partial | Obsidian note handler stores wikilinks metadata at `src/workers/ingestion/handlers.ts:71`, `:90`; Drive utilities parse wikilinks at `src/services/google/drive.ts:67`. | No active compiled wiki output in `master`. |
| Compiled wiki/context output | Planned in active `master`; present in 11.4 branch | Roadmap calls for compiled Markdown/AI Search rebuilds; sibling branch has `src/services/compiled-synthesis*.ts`. | Reconcile before Phase 1 or choose 11.4 as baseline. |
| Neon/Postgres canonical store | Historical/current Hindsight-owned in active `master`; HAETSAL-owned in 11.4 branch | Active `master` uses `NEON_CONNECTION_STRING` for Hindsight (`src/types/env.ts:54`, `.dev.vars.example:5`) and D1/R2 for canonical metadata; 11.4 branch has `src/services/canonical-postgres-repository.ts`. | This is the biggest tree reconciliation issue. |

Current write flow in active `master`:

1. `capture_memory`, `brain_v1_retain`, `memory_write`, ingests, and agent close summaries call `retainViaService` / `retainContent`.
2. `retainContent` validates write policy, encrypts archival body, and calls `captureThroughCanonicalPipeline`.
3. `captureCanonicalMemory` writes D1 metadata to `canonical_captures`, `canonical_documents`, `canonical_chunks`, `canonical_memory_operations`, and `canonical_projection_jobs`, while encrypted bodies go to R2.
4. Projection dispatch is sent to `QUEUE_BULK`.
5. Hindsight and Graphiti payloads are materialized; Hindsight compatibility bridge keeps current behavior.

Current read flow in active `master`:

1. `search_memory` calls `searchCanonicalMemory`.
2. Router selects `raw`, `semantic`, `graph`, or `composed`.
3. Raw mode searches D1 metadata and decrypts R2 body with the session TMK when present.
4. Semantic mode calls Hindsight recall and then resolves canonical linkback.
5. Graph/composed modes read completed Graphiti projection mappings from D1.

## 5. Test and Verification Baseline

| Command | Result | Notes |
|---|---|---|
| `npm test` | Not a reliable active-tree signal; stopped after several minutes. | Vitest picked up the untracked `gbrain/` reference checkout and imported many Bun-based `gbrain/test/**` files as zero-test suites, e.g. warnings for `bun:test` imports. This is test discovery contamination from local reference directories, not an active app failure. |
| `npx vitest run "tests/**/*.test.ts"` | Failed with "No test files found". | Windows/Vitest filter mismatch; recorded as an attempted static fallback. |
| `npx vitest run tests` | Not reliable; stopped. | Still matched nested reference paths such as `gbrain/recipes/agent-voice/tests/...`. |
| `npx vitest run --dir tests` | Passed. | `59` test files passed, `342` tests passed, `1` skipped, duration `68.44s`. This is the useful active-suite baseline. |
| `npm run postflight` | Passed. | `All checks passed - no violations found.` |

No live Cloudflare or Neon resources were created. No live credential-dependent verification was attempted beyond the local test/postflight commands.

## 6. Phase 1 Readiness

Blockers before Cloudflare package/config upgrade:

- Pick the active implementation tree: current `master` has roadmap/spec commits; `codex/11-4-deploy-candidate` has newer runtime code.
- Merge or cherry-pick `64eb362` and `34734b5` onto the chosen implementation branch, or port 11.4 runtime work back into this worktree.
- Fix test discovery so `npm test` ignores untracked local reference checkouts such as `gbrain/`, `OB1/`, and `Second-Brain/`.
- Reconcile `package.json` and `package-lock.json` before dependency upgrades, especially the lock-only `@neondatabase/serverless` entry.
- Decide whether Phase 1 runs before or after the 11.4 canonical Postgres/compiled-synthesis lineage is accepted as the base.

Safe first edits for the next spec:

- Create a reconciliation branch from `codex/11-4-deploy-candidate`.
- Bring in the post-Hindsight roadmap and baseline spec/report docs.
- Add or adjust test include/exclude configuration so active tests do not scan local reference clones.
- Document the chosen baseline branch in `MANIFEST.md` and `SESSION_LOG.md` after the branch decision.

Risky areas needing separate specs:

- Removing `HindsightContainer`, `HINDSIGHT` bindings, and Hindsight env types.
- Replacing `canonical-semantic-recall.ts` with a retrieval broker.
- Migrating/retiring `hindsight_operations`, `hindsight_bank_config`, and `tenants.hindsight_tenant_id` runtime reads.
- Replacing consolidation/contradiction behavior that currently depends on Hindsight history, graph, and reflect APIs.
- Deciding how much Graphiti projection code remains before AI Search/Postgres graph traversal is introduced.
- Moving canonical memory truth from active-master D1/R2 metadata to HAETSAL-owned Neon/Postgres, if the 11.4 branch is not adopted directly.

Recommended next spec:

- `10.1-active-tree-reconciliation-and-test-hygiene.md`

Recommended acceptance for that next spec:

- One branch/worktree is named as the implementation baseline.
- Post-Hindsight docs are present on that branch.
- `npm test` runs only active HAETSAL tests, without scanning local reference directories.
- Package manifest and lockfile are reconciled.
- No Hindsight removal or Cloudflare package upgrade happens until that baseline is clean.

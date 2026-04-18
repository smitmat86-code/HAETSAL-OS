# Session Log — THE Brain

> Append-only. AI reads the last 3 entries at session start.
> AI appends a new entry at session end.

---

## Session 6.2 - 2026-04-18

**Spec:** Phase 6.2 - Canonical MCP Memory Surface
**Built:**
- `src/types/canonical-memory-query.ts` - canonical search/recent/document/status/stats contracts
- `src/services/canonical-memory-read-model.ts`, `canonical-memory-query.ts`, `canonical-memory-status.ts`, `canonical-memory-stats.ts` - canonical read, decrypt, status, and stats services over the Session 6.1 bridge layer
- `src/tools/canonical-memory.ts` - canonical MCP tools: `capture_memory`, `search_memory`, `get_recent_memories`, `get_document`, `memory_status`, `memory_stats`
- `src/workers/mcpagent/do/McpAgent.ts` - canonical tools registered through the existing McpAgent surface, version `6.2.0`
- `tests/6.2-canonical-mcp-memory-surface.test.ts` + new canonical-memory query fixtures - tenant-scoped search/recent/document/status/stats coverage plus capture alias presence
**Decisions:**
- **Session 6.2 keeps the public surface canonical while leaving the production Hindsight path intact.** The new canonical tools are additive and do not replace `brain_v1_*` or `memory_*` yet.
- **Canonical reads stay foundation-first.** Search and recent reads use Session 6.1 D1 metadata and, when a session TMK is present, decrypt canonical R2 document bodies to build previews and matches.
- **`capture_memory` is a bridge, not the 6.3 pipeline.** It maps canonical `scope` onto the current retain `domain` field so write policy and live retain behavior remain unchanged until canonical capture-first writes land.
**Verification:**
- `npx vitest run tests/6.2-canonical-mcp-memory-surface.test.ts` - passed
- `npm test` - passed (`291 passed`, `1 skipped`)
- `npm run postflight` - passed
- `npm run manifest` - passed
**Hindsight Pin:** unchanged (`ghcr.io/vectorize-io/hindsight-api:0.5.2`)
**Fixture Data:** `tests/fixtures/canonical-memory/note-search-query.json`, `recent-query.json`, `document-query.json`, `status-query.json`
**Blockers:** None for Session 6.2; 6.3 still owns canonical capture-first writes and projection fan-out
**Next:** Session 6.3 - move the canonical contract from bridge reads into the canonical capture-first write pipeline

---

## Session 6.1 - 2026-04-18

**Spec:** Phase 6.1 - Canonical Open Brain Foundation
**Built:**
- `migrations/1013_canonical_open_brain_foundation.sql` - canonical capture/artifact/document/chunk/operation/projection tables in the bridge-layer substrate
- `src/types/canonical-memory.ts` - canonical capture/artifact/result contracts
- `src/services/canonical-memory.ts` plus schema/type/artifact/audit helpers - service-layer canonical capture with atomic D1 writes and encrypted R2 payload persistence
- `src/services/ingestion/retain.ts` - off-by-default canonical shadow-write hook guarded by `CANONICAL_MEMORY_SHADOW_WRITES`
- `tests/fixtures/canonical-memory/*.json` + `tests/6.1-canonical-open-brain-foundation.test.ts` - note, conversation, and artifact fixture coverage for canonical capture acceptance
**Decisions:**
- **Session 6.1 lands a bridge layer first.** Canonical metadata now lives in D1 and canonical payloads live encrypted in R2, shaped to map cleanly to the long-term Postgres + R2 target without adding a new Worker-to-Neon write path yet.
- **The production Hindsight path remains authoritative today.** Shadow writes are best-effort and feature-flagged off by default so current interactive and queued retain behavior is unchanged unless explicitly enabled.
- **Canonical chunk truth is offset/hash based.** Raw chunk text is derived from the encrypted canonical document body in R2 rather than duplicated into D1.
**Verification:**
- `npx vitest run tests/6.1-canonical-open-brain-foundation.test.ts` - passed
- `npm test` - passed (`284 passed`, `1 skipped`)
- `npm run postflight` - passed
- `npm run manifest` - passed
**Hindsight Pin:** unchanged (`ghcr.io/vectorize-io/hindsight-api:0.5.2`)
**Fixture Data:** `tests/fixtures/canonical-memory/note-capture.json`, `conversation-capture.json`, `artifact-capture.json`
**Blockers:** None for Session 6.1; later sessions still need the real Postgres landing and projection worker fan-out
**Next:** Session 6.2 - define the stable canonical MCP memory surface on top of the new foundation

---

## Session OPS.4 - 2026-04-17

**Spec:** Operational - drift-aware Hindsight provisioning + service-layer cleanup
**Built:**
- `migrations/1012_hindsight_bank_config.sql` - D1 ledger for applied Hindsight config hashes per bank
- `src/services/bootstrap/hindsight-bank-spec.ts` - canonical Hindsight bank provisioning spec + deterministic config hash
- `src/services/bootstrap/hindsight-config.ts` - drift-aware `ensureHindsightBankConfigured()` plus idempotent bank/model/webhook re-apply
- `src/services/hindsight-client.ts` + `src/services/hindsight.ts` - thinner raw Hindsight client under the richer HAETSAL orchestration layer
- `src/workers/ingestion/retain-consumer.ts` + `src/workers/ingestion/consumer.ts` - retain-artifact queue path split into its own consumer seam
- `src/services/ingestion/retain.ts` + `src/workflows/bootstrap.ts` - both write-time retain and bootstrap now run through the same bank-config ensure path
- `tests/2.4a-hindsight-config.test.ts`, `tests/2.1c-ingestion-consumer.test.ts`, `tests/2.1d-ingestion-consumer-integration.test.ts`, `tests/2.1-retain.test.ts` - updated for Request-based Hindsight transport and the new queue seam
**Decisions:**
- **Bank config is no longer "bootstrap once and trust forever."** HAETSAL now stores a config hash per Hindsight bank and re-applies when missions, mental models, or webhook shape drift.
- **The raw Hindsight API client is separate from orchestration.** Transport-level calls live in `hindsight-client.ts`; D1-aware lifecycle and runtime concerns stay above it.
- **Non-interactive retain artifacts get their own queue seam.** `retain_artifact` dispatch no longer piggybacks on the TMK-backed handler module.
- **Write-time retain can safely self-heal config drift.** Interactive writes and queued retains both converge on the same `ensureHindsightBankConfigured()` path.
**Verification:**
- `npx vitest run tests/2.4a-hindsight-config.test.ts tests/2.1c-ingestion-consumer.test.ts tests/2.1d-ingestion-consumer-integration.test.ts tests/2.1-retain.test.ts` - passed (32 tests)
**Hindsight Pin:** unchanged (`ghcr.io/vectorize-io/hindsight-api:0.5.2`)
**Fixture Data:** Test tenants `test-tenant-retain`, `test-tenant-queue`; Request-based Hindsight service-binding stubs
**Blockers:** None in this slice; full checkout verification still required after truth-file regeneration
**Next:** Run repo-wide checkout (`postflight`, `npm test`, `manifest`) and decide whether to backfill existing bank-config rows in live environments

---

## Session OPS.3 â€” 2026-04-17

**Spec:** Operational â€” Checkout protocol closeout
**Built:**
- src/cron/hindsight-operations.ts + `src/cron/hindsight-operation-*.ts` â€” split the ops poller/reconcile path into smaller modules so postflight line enforcement passes cleanly
- src/services/hindsight.ts + helper transport/formatter modules â€” extracted transport and formatting helpers to keep the public Hindsight service under the global 150-line boundary
- src/services/ingestion/retain.ts + retain-request / retain-persistence helpers â€” separated request construction and persistence side-effects from the retain orchestrator
- src/workers/mcpagent/do/McpAgent.ts + tool/session/inbound helpers â€” trimmed the DO runtime back under postflight while keeping the dedicated-worker Hindsight topology intact
- tests/2.1-retain.test.ts path stabilized indirectly via `src/services/ingestion/retain-persistence.ts` â€” detached async reconcile work no longer outlives the test when no `ExecutionContext` exists
- MANIFEST.md â€” regenerated after the checkout cleanup
**Decisions:**
- The checkout protocol is authoritative: `npm run postflight`, `npm test`, and `npm run manifest` must all pass before calling the Hindsight work truly closed out.
- Detached async follow-up work is only safe when a real `ctx.waitUntil()` exists; test and pure service-call paths should not spawn background D1 reconciliation promises.
- Postflight line enforcement is best handled by extracting focused helper modules, not by squeezing more branching into already-hot files.
**Verification:**
- `npm run postflight` â€” passed
- `npm test` â€” passed
- `npm run manifest` â€” passed
- `npx vitest run tests/2.1-retain.test.ts` â€” passed after the retain follow-up fix
**Hindsight Pin:** `ghcr.io/vectorize-io/hindsight-api:0.5.2`
**Fixture Data:** Test-only async retain path without `ExecutionContext` now exits cleanly; no extra live fixture changes
**Blockers:** None for checkout completion; remaining repo warnings are non-fatal harness/platform noise
**Next:** Move to non-Hindsight platform work, or do broader repo-health cleanup as a separate lane

---

<!-- Template for new entries:

## Session [N.N] — [YYYY-MM-DD]

**Spec:** [Phase N.N — Name]
**Built:**
- [file] ([lines] lines) — [purpose]
- [file] ([lines] lines) — [purpose]
**Decisions:**
- [key decision and why]
**Hindsight Pin:** [commit hash if changed, or "unchanged"]
**Fixture Data:** [which fixture files consumed, or "N/A — infrastructure only"]
**Blockers:** [any blockers, or "None"]
**Next:** [what comes next]

---

-->

## Session 0.0 — 2026-03-10

**Spec:** Scaffold — project initialization
**Built:**
- ARCHITECTURE.md — constitutional law (three laws, state tiers, compute continuum, action authorization)
- CONVENTIONS.md — file limits, naming, Hono patterns, service layer, encryption, action layer, async, DB, anti-patterns
- .agent/rules/governance.md — AI agent check-in/check-out protocol with Brain-specific guardrails
- LESSONS.md — pre-populated with known gotchas from architecture design sessions
- MANIFEST.md — module registry template + binding status tracker
- SESSION_LOG.md — this file
- specs/SPEC_TEMPLATE.md — spec template with Brain-specific sections (Law Check, Action Layer wiring)
- README.md — project overview and getting started
- docs/build-sequence.md — Phase 1–5 spec roadmap
**Decisions:**
- Scaffold produced from dark-factory-scaffold template + Schema execution plan + THE_BRAIN_ARCHITECTURE.md
- Spec template adds three Brain-specific sections not in generic template: Laws Check, Action Layer wiring, Cron KEK wiring
- LESSONS.md pre-populated with 15+ known gotchas from architecture design rather than starting empty
- MANIFEST.md includes Binding Status tracker to track Phase 1–5 infrastructure build-out
**Hindsight Pin:** Not set — set this at Phase 1.1 start
**Fixture Data:** N/A — scaffold only
**Blockers:** None
**Next:** Phase 1.1 — Hindsight Container + Neon + Hyperdrive + D1 schema + McpAgent stub

---

## Session 1.1 — 2026-03-10

**Spec:** Phase 1.1 — Infrastructure Bedrock
**Built:**
- wrangler.toml (~105 lines) — all Cloudflare bindings: D1, R2, KV, 5 queues, Vectorize, Analytics, Browser, Hyperdrive, Container
- migrations/1001_brain_tenants.sql (~37 lines) — tenants, tenant_members
- migrations/1002_brain_observability.sql (~95 lines) — memory_audit, agent_traces, agent_cost_summary, ingestion_events, cron_executions
- migrations/1003_brain_cognitive.sql (~78 lines) — anomaly_signals, graph_health_snapshots, mental_model_history, predictions
- migrations/1004_brain_action_layer.sql (~119 lines) — tenant_action_preferences, pending_actions, action_audit, scheduled_tasks, action_templates
- hindsight/Dockerfile (~8 lines) — Distroless container build (commit hash placeholder)
- hindsight/hindsight.toml (~12 lines) — Hyperdrive URL, auto-migrate
- src/workers/health/index.ts (~60 lines) — Health check Worker: D1, R2, KV, Container
- tests/1.1-infrastructure.test.ts (~96 lines) — 7 integration tests via vitest-pool-workers
- vitest.config.ts (~22 lines) — workerd pool with stubbed HINDSIGHT service binding
- package.json — Hono, wrangler, vitest, CF workers-types
- tsconfig.json — strict, ES2022, bundler resolution
- .dev.vars.example — local dev secrets template
**Decisions:**
- **Structural: postflight/manifest scripts now scan src/ alongside packages/.** The spec defines a flat `src/workers/` layout. The scaffold's scripts originally only scanned `packages/`. Both scripts were updated to scan both directories. This keeps future monorepo flexibility while honoring the spec's flat structure. Session 1.2 agent: this is intentional.
- Hindsight commit hash is a placeholder (SET_COMMIT_HASH_BEFORE_DEPLOY). This is a manual gate — spec cannot be marked COMPLETE until a real hash is pinned.
- D1_EU binding stubs to same DB as D1_US with explicit TODO for Phase 5+.
**Hindsight Pin:** v0.4.16 (vectorize-io/hindsight @ 58fdac4) — pinned 2026-03-10
**Fixture Data:** N/A — infrastructure only
**Blockers:** None
**Next:** Phase 1.2 — McpAgent Worker + auth + TMK derivation

---

## Session 1.2 — 2026-03-10

**Spec:** Phase 1.2 — McpAgent + Auth + AI Gateway
**Built:**
- src/types/env.ts (~46 lines) — full Env interface: all bindings + MCPAGENT DO
- src/types/tenant.ts (~30 lines) — TenantContext, TenantRow matching D1 DDL
- src/types/tools.ts (~52 lines) — retain/recall types + Zod schemas for MCP SDK
- src/middleware/auth.ts (~130 lines) — CF Access JWT validation, HKDF tenant ID, TMK derivation
- src/middleware/audit.ts (~46 lines) — writeAuditLog + auditMiddleware (trace ID stamp)
- src/middleware/dlp.ts (~16 lines) — DLP stub passthrough
- src/services/tenant.ts (~120 lines) — atomic tenant bootstrap, KEK provision/renewal
- src/tools/retain.ts (~22 lines) — brain_v1_retain stub
- src/tools/recall.ts (~18 lines) — brain_v1_recall stub
- src/workers/mcpagent/do/McpAgent.ts (~98 lines) — DO: TMK in memory, MCP tools, WebSocket
- src/workers/mcpagent/index.ts (~70 lines) — Hono Worker: middleware chain + route handlers
- tests/1.2-auth.test.ts (~110 lines) — 9 tests: tenant ID, TMK, bootstrap, KEK, audit
- tests/1.2-tools.test.ts (~53 lines) — 4 tests: retain/recall schema shapes
- tests/1.2-websocket.test.ts (~36 lines) — 3 tests: 401 rejection, security headers
- tests/test-entry.ts (~42 lines) — minimal worker entry for vitest
- tests/env.d.ts (~11 lines) — cloudflare:test ProvidedEnv type augmentation
**Decisions:**
- **Deviation: McpAgent.serve() not used.** The SDK's `serve()` bypasses Hono middleware. Kept Hono as entry, route /mcp to DO via `stub.fetch(c.req.raw)`. DO receives pre-authenticated requests.
- **Deviation: initTenant() RPC added.** SDK's abstract `init()` runs at DO creation before JWT auth occurs. Added `initTenant(jwtSub, tenantId)` called by Worker after auth.
- **Deviation: Zod schemas required.** `McpServer.tool()` needs `ZodRawShapeCompat`, not plain JSON Schema. Installed `zod@3.25.1`.
- **Deviation: Test entry split.** agents@0.7.5 transitive deps (partyserver, @modelcontextprotocol/sdk) fail to bundle in miniflare. `wrangler.test.toml` uses `tests/test-entry.ts`.
- **Middleware pattern: `createMiddleware` from `hono/factory`.** Required for proper Variables typing on `c.set()`/`c.get()`.
- **Checkin workflow updated:** Added Step 2 "Cloudflare Platform Verification" — checks official docs, `cloudflare/agents`, `cloudflare/workers-sdk`, `cloudflare/workerd`, npm registry.
**Hindsight Pin:** unchanged (v0.4.16 @ 58fdac4)
**Fixture Data:** N/A — auth + infrastructure only
**Blockers:** None
**Next:** Phase 1.3 — Action Worker + approval flow + WebSocket push for action events

---

## Session 1.3 — 2026-03-10

**Spec:** Phase 1.3 — Action Layer Foundation
**Built:**
- src/types/action.ts (~86 lines) — CapabilityClass, AuthorizationLevel, HARD_FLOORS, queue message schema
- src/services/action/toctou.ts (~22 lines) — hashPayload + verifyPayloadHash (timingSafeEqual)
- src/services/action/authorization.ts (~130 lines) — auth gate, HMAC verify, preference lookup
- src/services/action/executor.ts (~46 lines) — stub execution + WebSocket broadcast
- src/services/action/router.ts (~110 lines) — routeGreen/Yellow/Red + writeAnomalyAndAudit
- src/workers/action/index.ts (~90 lines) — queue consumer pipeline (no HTTP surface)
- src/tools/act/send-message.ts (~33 lines) — WRITE_EXTERNAL_IRREVERSIBLE stub
- src/tools/act/create-event.ts (~35 lines) — WRITE_EXTERNAL_REVERSIBLE stub
- src/tools/act/modify-event.ts (~35 lines) — WRITE_EXTERNAL_REVERSIBLE stub
- src/tools/act/draft.ts (~33 lines) — WRITE_INTERNAL stub
- src/tools/act/search.ts (~33 lines) — READ stub
- src/tools/act/browse.ts (~33 lines) — READ stub
- src/tools/act/remind.ts (~33 lines) — WRITE_INTERNAL stub
- src/tools/act/run-playbook.ts (~33 lines) — WRITE_EXTERNAL_IRREVERSIBLE stub
- src/workers/mcpagent/do/McpAgent.ts (~120 lines) — registered 8 act tools via registerActTools()
- src/workers/mcpagent/index.ts (~82 lines) — added queue() handler alongside fetch()
- tests/1.3-action-layer.test.ts (~210 lines) — 12 integration tests (auth gate, TOCTOU, pipeline)
**Decisions:**
- **Deviation: Queue consumer on main Worker, not separate.** Cloudflare Queues consumers export queue() alongside fetch() from the same entry point. No separate wrangler file needed. Action logic isolated in src/workers/action/ module with zero HTTP surface. Added to LESSONS.md.
- **Deviation: Router extracted to separate file.** Postflight caught action/index.ts at 207 lines (limit 150). Extracted routeGreen/Yellow/Red + writeAnomalyAndAudit to src/services/action/router.ts.
- **Platform max_retries vs app max_retries documented.** wrangler.toml max_retries=3 (platform DLQ routing) is independent from pending_actions.max_retries=3 (application-level budget). Added to LESSONS.md.
**Hindsight Pin:** unchanged (v0.4.16 @ 58fdac4)
**Fixture Data:** N/A — behavioral wiring only
**Blockers:** None
**Next:** Phase 1.4 — Pages UI + approval flow + settings

---

## Session 2.1 — 2026-03-10

**Spec:** Phase 2.1 — Queue Topology + Ingestion Foundation
**Built:**
- src/types/ingestion.ts (~47 lines) — IngestionArtifact, SalienceResult, RetainResult, queue message types
- src/types/hindsight.ts (~38 lines) — HindsightRetainRequest/Response, HindsightRecallRequest/Response
- migrations/1005_brain_ingestion.sql (~18 lines) — tenant_phone_numbers table
- src/services/ingestion/dedup.ts (~40 lines) — SHA-256 dedup hash + D1 check
- src/services/ingestion/salience.ts (~77 lines) — Tier 1/2/3 classification + queue routing
- src/services/ingestion/domain.ts (~57 lines) — keyword domain inference + memory type
- src/services/ingestion/write-policy.ts (~73 lines) — heuristic + Workers AI classifier
- src/services/ingestion/retain.ts (~115 lines) — retainContent() single path for all memory writes
- src/workers/mcpagent/routes/ingest.ts (~96 lines) — POST /ingest/sms (Telnyx Ed25519)
- src/workers/mcpagent/routes/auth.ts (~12 lines) — placeholder for Phase 2.2
- src/workers/ingestion/consumer.ts (~78 lines) — queue consumer for QUEUE_HIGH/NORMAL/BULK
- src/workers/mcpagent/index.ts (~97 lines) — route extraction + multi-queue dispatch
- src/workers/mcpagent/do/McpAgent.ts (~148 lines) — getTmk/getHindsightTenantId RPC + real retain
- src/tools/retain.ts (~53 lines) — retainViaService replaces retainStub
- src/tools/recall.ts (~15 lines) — updated TODO comment for Phase 2.2
- tests/2.1-salience.test.ts (~80 lines) — 9 tests for tier classification + queue routing
- tests/2.1-write-policy.test.ts (~64 lines) — 6 tests for heuristic + classifier
- tests/2.1-retain.test.ts (~172 lines) — 14 tests for pipeline, dedup, encryption, R2 STONE
- tests/2.1-sms.test.ts (~134 lines) — 6 tests for webhook, tenant lookup, phone uniqueness
**Decisions:**
- **Route extraction completed:** /ingest/* and /auth/* in separate route modules. Main index.ts mounts via Hono route groups. Prevents 2.2 restructuring.
- **SMS route bypasses CF Access:** Mounted BEFORE auth middleware in Hono chain. Telnyx Ed25519 validation replaces JWT auth on this route.
- **Multi-queue dispatch:** queue() handler dispatches by `batch.queue` name — actions vs ingestion.
- **retainStub replaced:** retainViaService calls real retainContent() pipeline. Old 1.2 tests updated.
- **Hindsight stub enhanced:** vitest config returns plausible retain/recall responses by URL path.
**Hindsight Pin:** unchanged (v0.4.16 @ 58fdac4)
**Fixture Data:** N/A — infrastructure only
**Blockers:** None
**Next:** Phase 2.2 — Gmail + Calendar Ingestion

---

## Session 2.2 — 2026-03-10

**Spec:** Phase 2.2 — Gmail + Calendar Ingestion
**Built:**
- src/types/google.ts (~50 lines) — GoogleOAuthTokens, GoogleThread, GoogleMessage, GoogleCalendarEvent, GoogleDriveFile
- migrations/1006_brain_google.sql (~33 lines) — google_webhook_channels, google_oauth_tokens tables
- src/services/google/oauth.ts (~115 lines) — token encrypt/decrypt, store, refresh, revoke
- src/services/google/gmail.ts (~83 lines) — thread fetch, 2+ reply filter, 2000 char trim
- src/services/google/calendar.ts (~60 lines) — event fetch, 15min filter, PII reduction
- src/services/google/drive.ts (~78 lines) — Drive polling, frontmatter parsing, wikilinks
- src/services/google/webhook.ts (~42 lines) — channel token verification, registration
- src/services/telnyx.ts (~37 lines) — Ed25519 verification extracted from ingest.ts
- src/workers/ingestion/handlers.ts (~93 lines) — extracted handler functions from consumer.ts
- src/workers/mcpagent/routes/ingest.ts (~120 lines) — Gmail/Calendar webhook routes added
- src/workers/mcpagent/routes/auth.ts (~55 lines) — Google OAuth callback + revoke
- src/tools/recall.ts (~58 lines) — real Hindsight recall via recallViaService
- tests/2.2-gmail.test.ts (~77 lines) — 6 tests: thread extraction, filtering, trimming
- tests/2.2-calendar.test.ts (~80 lines) — 5 tests: event extraction, duration, PII
- tests/2.2-obsidian.test.ts (~100 lines) — 11 tests: frontmatter, wikilinks, anti-circular
- tests/2.2-oauth.test.ts (~117 lines) — 4 tests: encryption, D1 metadata, revocation
**Decisions:**
- **KV key pattern `google_tokens:{tenantId}:{scope}`** instead of spec's `oauth:{tenantId}:google:{scope}`. Simpler, consistent with google_ prefix convention.
- **Handlers extracted to `src/workers/ingestion/handlers.ts`** when postflight caught consumer.ts at 165 lines. Clean separation of dispatch logic vs handler implementations.
- **Telnyx verification extracted to `src/services/telnyx.ts`** when postflight caught ingest.ts at 158 lines.
- **vitest-pool-workers isolated storage confirmed:** OAuth tests required self-contained setup per test case (not shared across describe block).
- **recallViaService pattern:** Encrypt query → Hindsight service binding → decrypt results. Mirrors retainViaService from 2.1.
**Hindsight Pin:** unchanged (v0.4.16 @ 58fdac4)
**Fixture Data:** N/A — infrastructure only
**Blockers:** None
**Next:** Phase 2.3 — Browser Rendering + Write Surfaces

---

## Session 2.3 — 2026-03-10

**Spec:** Phase 2.3 — Browser Rendering + First Write Surfaces
**Built:**
- src/services/action/integrations/browser.ts (36 lines) — executeBrowse via @cloudflare/puppeteer + BROWSER binding
- src/services/action/integrations/calendar.ts (97 lines) — executeCreateEvent, executeModifyEvent, executeDeleteEvent (undo)
- src/services/action/integrations/episodic.ts (44 lines) — writeActionEpisodicMemory via retainContent
- src/services/action/executor.ts (113 lines) — executeAction dispatch by tool_name; stub fallback for unwired tools
- src/services/action/router.ts (111 lines) — routeGreen now passes TMK + ctx to executeAction
- src/workers/action/index.ts (104 lines) — TMK fetch from DO, optional ctx, no-op ExecutionContext for tests
- src/workers/mcpagent/routes/actions.ts (76 lines) — POST /:id/undo route (5-min window, calendar delete)
- src/workers/mcpagent/index.ts (144 lines) — mounted /actions route, ctx passed to handleActionBatch
- src/types/action.ts (97 lines) — ActionState union type, UNDO_WINDOW_MS constant
- tests/2.3-browse.test.ts (78 lines) — 5 tests: routing, capability class, Law 1
- tests/2.3-calendar.test.ts (100 lines) — 6 tests: routing, state, audit records
- tests/2.3-undo.test.ts (119 lines) — 6 tests: window check, state transitions, result_summary
**Decisions:**
- **TMK made nullable in executeAction:** browse (READ) doesn't need TMK for execution — only for episodic memory (non-fatal skip). Calendar tools require TMK (throw if null). This maintains backward compatibility with 1.3 tests.
- **ctx made optional in processAction:** Existing 1.3 tests call `processAction(msg, env)` without ctx. Added noopCtx fallback with no-op waitUntil/passThroughOnException.
- **Episodic memory extracted to integrations/episodic.ts:** executor.ts hit 157 lines (limit 150). writeActionEpisodicMemory is logically cohesive and extracted cleanly.
- **@vitest/snapshot added as devDependency:** `@cloudflare/puppeteer` install with `--legacy-peer-deps` broke vitest module hoisting. Explicit devDependency fixes.
- **BROWSER binding not testable in vitest-pool-workers:** Tests verify routing and state transitions, not actual browser navigation. Real browse validated manually with `wrangler dev`.
**Hindsight Pin:** unchanged (v0.4.16 @ 58fdac4)
**Fixture Data:** N/A — integration wiring only
**Blockers:** None
**Next:** Phase 2.4 — Bootstrap Import

---

## Session 2.4 — 2026-03-10

**Spec:** Phase 2.4 — Bootstrap Import
**Built:**
- src/types/bootstrap.ts (75 lines) — BootstrapParams, InterviewState, INTERVIEW_DOMAINS (5 domains, 12 questions)
- src/services/bootstrap/interview.ts (79 lines) — question flow, answer retention as semantic/user_authored
- src/services/bootstrap/historical-import.ts (139 lines) — Gmail/Calendar/Drive batch to QUEUE_BULK, date weighting
- src/workflows/bootstrap.ts (104 lines) — BootstrapWorkflow: 3-phase durable import via step.do()
- src/tools/bootstrap.ts (103 lines) — MCP tools: brain_v1_bootstrap_start + brain_v1_bootstrap_interview_next
- src/workers/ingestion/bootstrap-handlers.ts (90 lines) — QUEUE_BULK consumer handlers for bootstrap imports
- migrations/1007_brain_bootstrap.sql (12 lines) — ALTER TABLE tenants: bootstrap_status, workflow_id, items_imported
- src/types/env.ts (49 lines) — Added BOOTSTRAP_WORKFLOW: Workflow binding
- src/workers/mcpagent/do/McpAgent.ts (150 lines) — bootstrap tool registration via extracted module
- src/workers/mcpagent/index.ts (146 lines) — re-export BootstrapWorkflow
- src/workers/ingestion/consumer.ts (90 lines) — bootstrap message type dispatch
- src/workers/ingestion/handlers.ts (102 lines) — re-export bootstrap handlers
- wrangler.toml (142 lines) — [[workflows]] binding: brain-bootstrap
- tests/2.4-interview.test.ts (105 lines) — 6 tests
- tests/2.4-import.test.ts (113 lines) — 10 tests
**Decisions:**
- **Bootstrap tools extracted to src/tools/bootstrap.ts:** McpAgent.ts hit 241 lines. Context-injection pattern via `BootstrapContext` interface cleanly separates DO state from tool logic.
- **Bootstrap handlers extracted to bootstrap-handlers.ts:** handlers.ts hit 179 lines. Re-exported via handlers.ts for backward-compatible imports from consumer.ts.
- **Functional InterviewState over class:** Serializable state object for DO SQLite persistence. Pure functions are easier to test and persist than class instances.
- **step.do() polling for interview vs step.waitForEvent():** Polling D1 for `interview_completed_at` with retry config is simpler than coordinating external `instance.sendEvent()` calls. Interview completes in minutes.
- **Workflow type is global:** `Workflow` type doesn't need importing — it's a global Workers type like `D1Database`.
- **Miniflare doesn't support Workflows:** Tests exercise service functions directly. Workflow orchestration validated manually.
**Hindsight Pin:** unchanged (v0.4.16 @ 58fdac4)
**Fixture Data:** N/A — infrastructure only
**Blockers:** None
**Next:** Phase 3.1 or next build sequence phase

---

## Session 1.4 â€” 2026-03-10

**Spec:** Phase 1.4 â€” Pages UI + Approval Queue + Settings
**Built:**
- `pages/` Vite React SPA â€” Queue, Activity Log, Settings, typed API client, countdown hook, styling, Pages Function proxy
- `src/services/action/approval-api.ts` (149 lines) â€” list/approve/reject action route logic
- `src/services/action/preference-model.ts` (88 lines) â€” preference DTO + HMAC-backed mapping
- `src/services/action/preferences.ts` (130 lines) â€” tenant settings read + preference upsert + audit batch
- `src/workers/mcpagent/routes/approval.ts` (66 lines) â€” `GET /api/actions`, `POST /api/actions/:id/approve`, `POST /api/actions/:id/reject`
- `src/workers/mcpagent/routes/settings.ts` (64 lines) â€” `GET /api/settings`, `POST /api/settings/preferences`
- `src/workers/mcpagent/routes/audit.ts` (51 lines) â€” `GET /api/audit`
- `src/workers/mcpagent/index.ts` + `tests/test-entry.ts` â€” mounted `/api/actions`, `/api/settings`, `/api/audit`; mounted undo router at `/api/actions/:id/undo`
- `tests/1.4-approval-queue.test.ts` + `tests/1.4-settings.test.ts` + `tests/support/cf-access.ts` â€” 9 protected-route tests via `SELF.fetch()`
- `scripts/generate-manifest.ts` + `scripts/postflight-check.ts` â€” now scan `pages/src/` and `pages/functions/`
**Decisions:**
- **WebSocket uses Worker `/ws` + `VITE_WORKER_URL`.** The existing DO upgrade path already lives on `/ws`; the browser connects directly to the Worker while normal API traffic stays same-origin through Pages Functions.
- **Pages-first sessions bootstrap tenants in API routes.** `getOrCreateTenant()` now runs on the new protected Pages APIs so a user doesn't need to hit `/mcp` or `/ws` first.
- **Undo exposed under `/api/actions/:id/undo` without removing `/actions/:id/undo`.** This keeps the Pages proxy surface uniform while preserving the original Worker route.
- **Postflight caught line-limit regressions immediately.** Approval logic and preference-model helpers were extracted into service modules instead of waiving limits.
**Verification:**
- `npm test` â€” 138 passed
- `npm run postflight` â€” passed after refactor
- `npm run manifest` â€” regenerated
- `cd pages && npm install && npm run build` â€” passed
**Hindsight Pin:** unchanged (v0.4.16 @ 58fdac4)
**Fixture Data:** Protected-route tests seed `pending_actions`, `tenant_action_preferences`, and `tenants` rows per test case
**Blockers:** Manual deployment steps remain â€” attach the Pages project to CF Access, set `WORKER_URL`, and set `VITE_WORKER_URL`
**Next:** Phase 3.1 or next reviewed active spec

---

## Session 3.1 — 2026-03-10

**Spec:** Phase 3.1 — BaseAgent + Chief of Staff + Layer 1 Router
**Built:**
- src/agents/types.ts (60 lines) — EpistemicMemoryType, AgentType, AgentContext, DoomLoopState, ReasoningTrace, DelegationSignal
- src/agents/base-agent.ts (149 lines) — Abstract BaseAgent: open/run/close lifecycle, agent loop, Law 3 retain()
- src/agents/helpers.ts (49 lines) — checkDoomLoop, encryptForR2, writeAnomalySignal, budget constants
- src/agents/chief-of-staff.ts (66 lines) — ChiefOfStaff extends BaseAgent, delegation signal parsing
- src/services/agents/router.ts (55 lines) — Layer 1 Router: pattern-first, Workers AI 8B classifier fallback
- tests/3.1-base-agent.test.ts (109 lines) — 10 tests: Law 3, doom loop, context, budget
- tests/3.1-chief-of-staff.test.ts (63 lines) — 6 tests: delegation, trace chaining
- tests/3.1-router.test.ts (42 lines) — 6 tests: pattern matching, fallback
- tests/3.1-cron-kek.test.ts (72 lines) — 4 tests: KEK columns, TTL, idempotency
**Decisions:**
- **BaseAgent split into two files:** Postflight 150-line limit forced extraction of doom loop, encryption, and anomaly helpers to `src/agents/helpers.ts`. Re-exported from base-agent.ts.
- **McpAgent.ts not modified:** Agent classes are standalone; DO wiring deferred to Phase 3.2 delegation protocol.
- **Cron KEK raw KV entry deferred:** Spec 3.1 confirms existing encrypted KEK path only. Raw KV entry for cron access is Phase 3.3.
- **Doom loop push-on-warn fix:** Initial implementation didn't push to calls array on 'warn', preventing escalation to 'break'. Fixed by pushing before checking warn threshold.
**Hindsight Pin:** unchanged (v0.4.16 @ 58fdac4)
**Fixture Data:** KEK tests seed tenants rows per test case
**Blockers:** None
**Next:** Phase 3.2 — Career Coach (First Domain Agent)

---

## Session 3.2 — 2026-03-10

**Spec:** Phase 3.2 — Career Coach (First Domain Agent)
**Built:**
- src/agents/career-coach.ts (100 lines) — CareerCoach extends BaseAgent, career-specific open/close/synthesis
- src/agents/types.ts (73 lines) — Added CareerContext interface
- src/tools/memory.ts (64 lines) — memory_search + memory_write MCP tools (Zod excludes procedural+world)
- src/workers/mcpagent/do/McpAgent.ts (148 lines) — wired registerMemoryTools, version 3.2.0
- tests/3.2-career-coach.test.ts (92 lines) — 10 tests
- tests/3.2-memory-interface.test.ts (85 lines) — 9 tests
**Decisions:**
- **Memory tools extracted to src/tools/memory.ts:** McpAgent.ts at 150-line ceiling. Same context-injection pattern as bootstrap tools.
- **career_context + career_note session-scoped tools deferred:** Requires DO lifecycle wiring; Career Coach works as standalone class without session-scoped tools.
- **memory_write excludes both procedural AND world:** Law 3 blocks procedural; world enters via ingestion pipeline only, not MCP callers.
- **recallViaService reused in CareerCoach open():** Instead of raw Hindsight calls with encryptQuery, uses existing pattern from tools/recall.ts.
**Hindsight Pin:** unchanged (v0.4.16 @ 58fdac4)
**Fixture Data:** N/A — type-level and schema-level tests
**Blockers:** None
**Next:** Phase 3.3 — Nightly Consolidation Cron

---

## Session 3.4 — 2026-03-10

**Spec:** Phase 3.4 — Morning Brief + Predictive Heartbeat
**Built:**
- src/cron/morning-brief.ts (93 lines) — brief assembly + 3-channel delivery (Telegram, DO broadcast, Obsidian)
- src/cron/brief-sections.ts (91 lines) — 7 section fetchers extracted for postflight limit
- src/cron/heartbeat.ts (61 lines) — 30-min predictive heartbeat, 8AM-8PM UTC, alert-only sends
- src/cron/weekly-synthesis.ts (81 lines) — Friday 5PM synthesis via Workers AI + Telegram + Obsidian
- src/cron/kek.ts (42 lines) — KEK fetch, validate, derive CryptoKey for cron jobs
- src/cron/obsidian-poll.ts (40 lines) — extracted obsidian poll from index.ts
- src/services/delivery/telegram.ts (30 lines) — Telegram bot sendMessage
- src/services/delivery/obsidian-write.ts (51 lines) — Google Drive /from-brain/ write
- migrations/1008_brain_consolidation.sql (37 lines) — consolidation_runs + consolidation_gaps
- tests/3.4-morning-brief.test.ts — 9 tests
- tests/3.4-heartbeat.test.ts — 7 tests
- tests/3.4-weekly-synthesis.test.ts — 6 tests
- tests/3.4-telegram.test.ts — 6 tests
- Modified: env.ts, index.ts, settings.ts, tenant.ts, wrangler.toml
**Decisions:**
- **Phase 3.3 skipped (user redesigning).** 3.4's prerequisites (consolidation tables, kek.ts, raw KEK KV write) built as part of 3.4.
- **Raw KEK bytes stored in KV** via `provisionOrRenewKek()` with 24h TTL — accepted tradeoff for cron access.
- **morning-brief.ts split into two files** when postflight caught 175-line violation. Section fetchers extracted to brief-sections.ts.
- **Obsidian poll extracted to separate module** to keep index.ts under 150 lines after adding cron dispatch switch.
- **Column name mismatches discovered:** spec's `tool_name` → actual `action_type`, `payload_encrypted` → `payload_r2_key`, missing `proposed_by`. Added to LESSONS.md.
**Verification:**
- `npm test` — 212 passed (30 files, 0 failures)
- `npm run postflight` — passed
- `npm run manifest` — regenerated
**Hindsight Pin:** unchanged (v0.4.16 @ 58fdac4)
**Fixture Data:** Tests seed tenants, pending_actions, consolidation_runs, consolidation_gaps
**Blockers:** None — Telegram secrets and Brave API key must be set before deploy
**Next:** Phase 3.3 (redesigned) or Phase 4.1

---

## Session 3.3 — 2026-03-10

**Spec:** Phase 3.3 — Nightly Consolidation v2
**Built:**
- src/cron/consolidation.ts (80 lines) — orchestrator: webhook + cron entry, dedup, 4-pass sequential
- src/cron/passes/pass1-contradiction.ts (69 lines) — /memories/list + /history structural signal + LLM
- src/cron/passes/pass2-bridges.ts (81 lines) — /graph structural hole detection, max 5 bridges
- src/cron/passes/pass3-patterns.ts (63 lines) — sole procedural write path, confidence > 0.6, max 3
- src/cron/passes/pass4-gaps.ts (62 lines) — /reflect with response_schema, D1 only, max 3
- src/cron/kek.ts (57 lines) — added encryptWithKek/decryptWithKek (AES-256-GCM)
- src/agents/base-agent.ts (148 lines) — mental model load via Hindsight /mental-models API
- src/types/env.ts (54 lines) — added HINDSIGHT_WEBHOOK_SECRET
- src/workers/mcpagent/index.ts (149 lines) — /hindsight/webhook route + 0 2 cron dispatch
- migrations/1008_brain_consolidation.sql (38 lines) — rewritten v1→v2 (4 passes, trigger, dedup index)
- 7 test files, 30 tests
**Decisions:**
- **Migration 1008 rewritten from v1 to v2:** 6-pass columns replaced with 4-pass + trigger + dedup unique index.
- **KV key kept as `cron_kek:{tenantId}`** (not spec's `cron_kek_raw:{tenantId}`): consistency with existing 3.4 implementation.
- **Pass 1 uses subquery for tenant_id in anomaly_signals:** Pass receives bankId (Hindsight), not tenantId — subquery from consolidation_runs resolves it.
- **2.4 bootstrap addendum deferred:** observations_mission, mental models, webhook registration need manual 2.4 update since 2.4 is already completed.
- **Postflight counts trailing newline:** `split('\n').length` counts +1 vs `wc -l`. Files need 149 content lines, not 150.
**Verification:**
- `npm test` — 242 passed (37 files, 0 failures)
- `npm run postflight` — passed
- `npm run manifest` — regenerated
**Hindsight Pin:** unchanged (v0.4.16 @ 58fdac4)
**Fixture Data:** Tests seed tenants, anomaly_signals, consolidation_runs, consolidation_gaps
**Blockers:** 2.4 bootstrap addendum (observations_mission, mental models, webhook) needs manual update
**Next:** Phase 4.1 or next reviewed active spec

---

## Session 2.4a — 2026-03-10

**Spec:** Phase 2.4a — Bootstrap Hindsight Configuration Addendum
**Built:**
- src/services/bootstrap/hindsight-config.ts (100 lines) — configureHindsightBank, createMentalModels, registerConsolidationWebhook
- src/workflows/bootstrap.ts (128 lines) — added 4 step.do() (lookup-bank, config, models, webhook) before bootstrap-complete
- src/types/env.ts (55 lines) — added WORKER_DOMAIN
- scripts/backfill-hindsight-config.ts (91 lines) — one-time backfill for existing tenant
- wrangler.toml — added WORKER_DOMAIN var
- tests/2.4a-hindsight-config.test.ts (119 lines) — 9 tests
**Decisions:**
- **Extracted to service module:** 3 Hindsight config functions in `hindsight-config.ts` to keep bootstrap.ts under 150 lines.
- **Added lookup-hindsight-bank step:** BootstrapParams has tenantId but not hindsightBankId — D1 lookup needed.
- **Partial mental model failure non-blocking:** Promise.allSettled + console.error. Brain works without perfect mental models.
- **Backfill manual:** Script created but deferred to when live Hindsight instance is available.
**Verification:**
- `npm test` — 251 passed (38 files, 0 failures)
- `npm run postflight` — passed
- `npm run manifest` — regenerated
**Hindsight Pin:** unchanged (v0.4.16 @ 58fdac4)
**Fixture Data:** Tests use mock env objects (no D1 needed — service function unit tests)
**Blockers:** Backfill script needs live Hindsight to execute; 3 pre-finalization items deferred to deploy
**Next:** Phase 4.1 or next reviewed active spec

---

## Session OPS.1 — 2026-03-15

**Spec:** Operational — CF Access Configuration & Dashboard Deployment Fix
**Built:**
- pages/functions/api/[[catchall]].ts (57 lines) — Pages-to-Worker proxy with JWT forwarding via `X-Forwarded-Access-Jwt`
- src/middleware/auth.ts — added `X-Forwarded-Access-Jwt` fallback header read, multi-AUD support
**Decisions:**
- **Custom JWT header for bypass routes:** CF Access strips `CF-Access-Jwt-Assertion` on bypass policies. Proxy copies JWT to `X-Forwarded-Access-Jwt` which CF Access doesn't touch.
- **Pages deploy from subdirectory:** `wrangler pages deploy dist` must run from `pages/` CWD — Functions discovery is relative to CWD, not the dist path.
- **7 CF Access apps total:** 3 auth gates (Pages custom domain, Pages.dev, Worker) + 4 bypass policies (API proxy, 3 webhooks). All bypass policies verified needed.
- **Multi-AUD in CF_ACCESS_AUD secret:** Worker accepts JWTs from both Worker direct (CF Access AUD) and Pages proxy (`X-Forwarded-Access-Jwt`) using comma-separated AUDs.
**Verification:**
- Tenant created in D1: `f51239...fcc2e6`, hindsight_tenant_id: `71e465df-...`
- Dashboard loads "Loading approval queue..." with zero console errors
- Worker tail confirms requests reaching Worker via proxy
**Hindsight Pin:** unchanged (v0.4.16 @ 58fdac4)
**Fixture Data:** N/A — operational deployment session
**Blockers:** None
**Next:** MCP/WS bypass policies when those are ready to integrate

---

## Session OPS.2 — 2026-04-17

**Spec:** Operational — Hindsight full completion closeout
**Built:**
- src/services/hindsight.ts — shared Hindsight transport finalized around API-only runtime, fresh shared identities, and dedicated worker prewarm
- src/workers/mcpagent/do/HindsightContainer.ts — dedicated worker entrypoint restored on the container class; API + worker topology locked in
- src/cron/hindsight-operations.ts — async retain polling/reconciliation became the durable source of truth for completion
- docs/hindsight-ops-runbook.md — operator truth, legacy-pending guidance, and dedicated-worker diagnostics documented
- docs/fold-hindsight-handoff.md — direct lessons for Fold from HAETSAL’s live repair
- README.md / ARCHITECTURE.md / docs/full_system_walkthrough.md / MANIFEST.md — top-level truth files updated to the actual production topology
**Decisions:**
- Hindsight’s production shape for HAETSAL is now canonical: API-only container + dedicated Hindsight worker containers + direct Neon + direct interactive `async=true` retain.
- Interactive writes stay on Hindsight’s native async path; HAETSAL queues remain for external/bulk ingestion, not as a second front-door queue for every MCP write.
- Fresh container identities were worth keeping during rollout because they flushed wedged shared instances without changing the public interface.
- Cloudflare container health counters are informative but subordinate to operation completion and delayed fact recall when judging Hindsight health.
**Verification:**
- `npx vitest run tests/2.4b-hindsight-container-runtime.test.ts tests/3.3-hindsight-operations.test.ts` — passed
- live deploy: `c0fd595f-a94a-4737-bf35-070e4ef63810`
- fresh writes completed live under dedicated-worker topology:
  - `73f148c2-47a4-46f1-8665-e0f90ef0afbb`
  - `fa885f41-87af-4dba-9af1-c3c8ba3df801`
- previously lingering pending op `ec4b1247-2704-4234-bda8-a2683579628c` drained to `completed`
**Hindsight Pin:** `ghcr.io/vectorize-io/hindsight-api:0.5.2`
**Fixture Data:** Live synthetic users `test-user-smoke-v4-api-*` with fact-style retain/recall smoke
**Blockers:** None for the Hindsight brain itself; remaining repo debt is outside the Hindsight completion scope
**Next:** Separate release-doc / repo-health cleanup, not more Hindsight surgery

---

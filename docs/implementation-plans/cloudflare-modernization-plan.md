# Cloudflare-Native Modernization Plan (Plan A)

> Superseded by `docs/implementation-plans/post-hindsight-cloudflare-open-brain-roadmap.md`.
> This plan assumed Hindsight stayed in the foundation. The current direction is
> post-Hindsight: Neon/Postgres canonical, Hyperdrive for Worker-to-Neon access,
> AI Search as a rebuildable document retrieval projection, and HAETSAL-owned
> retrieval/consolidation.

Date: 2026-05-31
Current status: Superseded by `post-hindsight-cloudflare-open-brain-roadmap.md`
Status: Planning — awaiting approval
Research basis: Cloudflare Docs MCP + changelog, verified 2026-05-31. Companion: `docs/implementation-plans/boop-parity-plan.md` (Plan B).

## Purpose

Bring HAETSAL's **infrastructure substrate** up to the Cloudflare primitives we
would choose **if we were building this system from scratch today**, and retire
hand-rolled code that the platform now provides natively.

This plan deliberately changes **how** things run, not **what** the product does.

- **In scope:** platform currency, SDK upgrade, replacing hand-rolled
  infrastructure with native primitives, data-plane modernization, observability
  and cost wiring.
- **Out of scope:** any new user-facing capability. New behavior (reasoning
  quality, integration breadth, new channels, memory features, dashboards) lives
  in **Plan B (boop parity)**.

## Separation Principle (A vs B)

| | Plan A (this doc) | Plan B (parity) |
|---|---|---|
| Question | "Rebuild the foundation on today's primitives" | "Match/exceed boop's features" |
| Delivers | Same behavior, modern substrate, less custom code | New user-facing capability |
| Risk if skipped | Tech debt, deprecation breakage, fragile custom code | Feature gaps vs boop |

Plan B depends on several Plan A primitives but is specified independently; this
plan never assumes a Plan B feature.

## Strategic Stance

1. **No behavior change, no regression.** Every workstream must preserve current
   product behavior and pass the existing vitest suite.
2. **Law 2 is non-negotiable.** Encryption, per-tenant TMK/KEK derivation, and
   zero-knowledge storage stay exactly as they are. Managed primitives that
   require plaintext are rejected where they would touch encrypted memory.
3. **Adopt native, delete custom.** Where the Agents SDK / platform now provides
   a primitive we hand-rolled, migrate to it and delete the bespoke code.
4. **Incremental, not big-bang.** Each workstream lands and is verified before
   the next.

## Target Architecture (if built today)

| Concern | Today (hand-rolled / dated) | Target primitive |
|---|---|---|
| Agents SDK | `agents@0.7.5` | `agents@0.13.x` family (+ `@cloudflare/ai-chat`, `@cloudflare/think` as needed) |
| Agent loop | 10-turn text-parse loop (`base-agent.ts`) | AI SDK v6 tool loop (`ai@6` already installed) |
| Session context | manual token count + `messages.splice()` flush | Sessions API (compaction, FTS) |
| State + sockets | `Set<WebSocket>` + manual SQLite session row | SDK `setState()`/`onStateChanged()` |
| Scheduling | 6 fixed wrangler crons | `this.schedule()`/`scheduleEvery()` (per-tenant) + a few account crons |
| Action delay/approval | stubbed send-delay + manual state machine | Workflows `waitForApproval`/`needsApproval`/fibers |
| Ops telemetry | manual anomaly signals | `diagnostics_channel` (8 channels) → Tail Workers |
| Cost ledger | schema only, no writes | AI Gateway logs / Unified Billing |
| LLM routing model | `llama-3.1-8b-instruct` (**RETIRED 2026-05-30**) | `glm-4.7-flash` |
| LLM agent model | `llama-3.3-70b-fp8-fast` (24k ctx, retained but weak) | `gpt-oss-120b` (128k, reasoning) |
| Secrets | `wrangler.toml [vars]` + env | Secrets Store bindings |
| Vectorize | 768-dim (verify V1/V2) | Vectorize V2 + metadata indexes |
| D1 reads | `prepare()` (primary only) | Sessions API `withSession()` read replication |
| Neon (Hindsight backing) | public Postgres | Workers VPC + Hyperdrive (private, pooled) |
| Browser | Puppeteer text-extract only | Browser Run (CDP, Live View, HITL) |
| compatibility_date | `2025-01-01` | current (`2026-05-30`) |

## Guardrails (Laws preserved)

- **Law 1:** still one public face (McpAgentDO). No new public brain.
- **Law 2:** KEEP hand-rolled — encrypted memory content store (Hindsight),
  reasoning-trace AES-GCM encryption, per-tenant TMK/KEK. No managed memory/RAG
  over encrypted content.
- **Law 3:** agent write policy unchanged; `EpistemicMemoryType` structural block stays.

---

## WS0 — Urgent currency (do now, independent)

> [!WARNING]
> `@cf/meta/llama-3.1-8b-instruct` was **retired 2026-05-30** and is called by the
> Layer 1 router, inbound SMS/Telegram inline replies, and the write-policy
> stage-2 classifier. These calls fail today.

- **[MODIFY]** `src/services/agents/router.ts`, inbound SMS reply, inbound
  Telegram reply, write-policy classifier: `@cf/meta/llama-3.1-8b-instruct` →
  `@cf/zai-org/glm-4.7-flash`.
- **[MODIFY]** `wrangler.toml` + `wrangler.test.toml`: `compatibility_date`
  `2025-01-01` → `2026-05-30`. Re-test `rpc_params_dup_stubs` (DO/Container RPC)
  and `require()` default-export behavior.
- **Acceptance:** router + inbound channels respond; `npm test` green.
- **Risk:** low. Model swap is near-drop-in; compat bump needs a test pass.

## WS1 — Agents SDK 0.7.5 → 0.13.x (foundation)

The lever the rest of the plan stands on.

- **[NEW]** `docs/implementation-plans/agents-sdk-migration-impact.md` — every
  breaking change mapped to our code: package split (`McpAgent` stays in
  `agents/mcp`; `AIChatAgent` → `@cloudflare/ai-chat`), **Zod 3→4** (`zod@3.25`),
  AI SDK v6 (`ai@6` already ✓), `onStateUpdate`→`onStateChanged`, observability
  rewrite, idempotent scheduling defaults.
- **[MODIFY]** `package.json` deps; incremental upgrade behind the test suite.
- **Dependencies:** none (WS0 can precede or merge).
- **Acceptance:** full suite green on 0.13.x; MCP session + DO lifecycle intact.
- **Risk:** medium (breaking minors). Mitigation: migration map first, land in a branch, test each step.

## WS2 — Retire hand-rolled with SDK primitives

- **[MODIFY]** `src/agents/base-agent.ts`: replace `agentLoop()` text-parse loop
  with AI SDK v6 `generateText`/`streamText` + `tools` + `stopWhen`. Replace
  `flushContext()` manual token slicing with Sessions API compaction.
- **[MODIFY]** `src/workers/mcpagent/do/McpAgent.ts` + `session-store.ts`:
  replace `Set<WebSocket>` + manual `broadcast()` + `mcp_agent_session` table with
  SDK `setState()`/`onStateChanged()` + built-in WS hibernation.
- **[MODIFY]** ops telemetry: subscribe to `diagnostics_channel` (rpc / tool /
  schedule / mcp / lifecycle) for operational events; drive anomaly detection off it.
- **KEEP:** `helpers.ts` doom-loop guard (no primitive); `encryptForR2` reasoning-trace
  encryption (Law 2). These stay hand-rolled by design.
- **Dependencies:** WS1.
- **Acceptance:** identical behavior, fewer lines; doom-loop + encrypted traces still pass tests.
- **Risk:** medium. This is the largest deletion of custom code — gate on behavior parity tests.

## WS3 — AI Gateway + model substrate

- **[MODIFY]** introduce `selectModel(task, stakes)` indirection (today
  `base-agent.callModel()` hard-codes one ID). Cheap tier `glm-4.7-flash`; mid
  tier `gpt-oss-120b`. (Frontier tier is Plan B WS1 — this WS only builds the
  routing seam + upgrades the open-model defaults.)
- **[MODIFY]** route 100% of LLM calls through `haetsal-brain-gateway` (already
  configured); enable **Dynamic Routing** + provider fallback + **budget limits**
  wired to existing `ai_ceiling_*` columns.
- **[NEW]** Secrets Store bindings; move `HMAC_SECRET`, channel creds, Google
  OAuth secrets, Neon connection string out of `wrangler.toml [vars]`.
- **[NEW]** cost read path: read per-request token/cost from AI Gateway logs
  (tag with tenant via `cf-aig-metadata`) → populate the empty cost ledger.
- **Dependencies:** WS0 (model IDs).
- **Acceptance:** all inference gateway-routed; budgets enforce; cost rows populate.
- **Risk:** low–medium.

## WS4 — Data plane modernization

- **Verify** Vectorize index is **V2**; create per-tenant **metadata indexes**
  (vectors upserted before an index exists are not filterable).
- **[MODIFY]** D1 read paths → `env.D1_US.withSession(bookmark)` to unlock free
  **global read replication**. Watch the immovable 10 GB/DB cap (shard per-tenant if near).
- **[NEW]** put **Neon behind Workers VPC + Hyperdrive** (private TCP, pooled) —
  stop exposing public Postgres; keeps Hindsight where it is while de-risking it.
- **Optional:** evaluate **one DO instance per tenant** (`getAgentByName(env, tenantId)`)
  for stronger blast-radius isolation (the per-tenant TMK stays regardless).
- **Dependencies:** none hard; WS1 helps for DO-per-tenant.
- **Acceptance:** replica reads served; Neon reachable only privately; Vectorize filtering verified.
- **Risk:** low (Vectorize/D1) to medium (VPC/Hyperdrive networking).

## WS5 — Scheduling primitive

- **[MODIFY]** move per-tenant cadence jobs (heartbeat, morning brief, weekly
  synthesis) into `this.schedule()`/`scheduleEvery()` (SQLite-backed, cancellable,
  survives restarts). Keep genuinely account-wide jobs as wrangler crons.
- **Dependencies:** WS1.
- **Acceptance:** per-tenant schedules fire correctly; no double-fire on DO restart.
- **Risk:** low.

## WS6 — Action mechanism durability (substrate only)

Modernize the **mechanism**, not the executors (wiring real sends = Plan B WS2).

- **[MODIFY]** replace the **stubbed send-delay** and manual awaiting-approval
  state with Workflows `waitForApproval` / `step.sleep` + Agents SDK `needsApproval`.
- **KEEP:** HMAC-signed preference rows, RED/YELLOW/GREEN hard floors, TOCTOU
  re-check, 5-min undo — these encode HAETSAL policy, not generic HITL.
- **Dependencies:** WS1.
- **Acceptance:** durable delay + approval survive restarts; policy + TOCTOU unchanged.
- **Risk:** medium.

## WS7 — Modernize existing platform usage

- **[MODIFY]** `src/services/action/integrations/browser.ts`: migrate to
  **Browser Run** (CDP) where interactive browsing/screenshots are needed; keep
  Puppeteer for trivial scrapes.
- **Optional [NEW]** Pipelines + R2 SQL for analytics: stream `action_audit` /
  `anomaly_signals` / ingestion events into R2 Iceberg for serverless SQL
  (replaces ad-hoc Analytics Engine usage).
- **Dependencies:** none.
- **Acceptance:** browse path on Browser Run; analytics queryable (if adopted).
- **Risk:** low.

---

## KEEP hand-rolled (Law 2 — do NOT replace)

- Hindsight encrypted memory content store (no managed primitive offers
  zero-knowledge; Agent Memory/AI Search require plaintext).
- Reasoning-trace AES-GCM encryption to R2.
- Per-tenant TMK/KEK derivation and isolation.
- Doom-loop guard (no CF primitive exists).

## Sequencing

WS0 (now) → WS1 (foundation) → WS2 + WS3 (parallel) → WS4 + WS5 + WS6 (parallel)
→ WS7 (opportunistic). Each gated by the vitest suite + postflight.

## Verification

- Behavior-parity tests before/after each WS (no product change is the success
  criterion for A).
- Law 2 audit after WS2/WS4 (confirm no plaintext leaked into managed services).
- Live-account verification (if Cloudflare API/observability MCP enabled):
  confirm retired-model errors cleared, Vectorize V2, deployed bindings.

## Out of Scope (→ Plan B)

Reasoning-quality uplift (frontier tier), real action executors, integration
breadth, Sendblue channel, user automations, sub-agent spawning as a feature,
memory decay, multimodal input, dashboard panels.

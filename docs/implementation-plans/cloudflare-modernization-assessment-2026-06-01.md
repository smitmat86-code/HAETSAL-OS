# Cloudflare Modernization Assessment

Date: 2026-06-01
Status: research and planning
Target workspace: `C:\Users\matth\Documents\HAETSAL OS 11.4 deploy`

## Executive Take

HAETSAL is not built on the wrong Cloudflare primitives. It is already using the
right broad substrate: Workers, Durable Objects, Containers, Queues, Workflows,
D1, R2, KV, Vectorize, Browser Rendering, AI Gateway, and Smart Placement.

The dated part is the integration layer:

- compatibility date is pinned to `2025-01-01`
- installed SDKs lag current releases
- some Workers AI model IDs are now deprecated/retired
- the Pages UI is still separate from the Worker rather than using Workers Static
  Assets / the Cloudflare Vite plugin
- the McpAgent state, sockets, sessions, schedules, and approvals are more
  hand-rolled than current Agents SDK patterns
- D1, Vectorize, Secrets, Browser automation, observability, and Postgres access
  are not using the newest platform capabilities

The right plan is therefore not a rebuild. It is a substrate modernization that
keeps HAETSAL's Open Brain architecture intact: canonical Postgres/R2 remains
the source of truth; Hindsight and Graphiti remain projection engines; compiled
synthesis remains the agent-facing understanding layer.

## Evidence From Current HAETSAL

Current latest worktree:

- `wrangler.toml` uses `compatibility_date = "2025-01-01"`.
- `wrangler.toml` has Containers for Hindsight and Graphiti.
- `wrangler.toml` has D1, R2, KV, Queues, Vectorize, Analytics Engine, AI,
  Browser, Workflows, Smart Placement, and basic observability.
- `package-lock.json` currently installs:
  - `agents@0.7.9` while latest npm is `0.13.3`
  - `@cloudflare/containers@0.3.3` while latest npm is `0.3.5`
  - `@cloudflare/vitest-pool-workers@0.14.9` while latest npm is `0.16.10`
  - `@cloudflare/workers-types@4.20260423.1` while latest npm is
    `4.20260601.1`
  - `wrangler@4.84.1` while latest npm is `4.95.0`
  - `zod@3.25.76` while latest npm is `4.4.3`
- `src/workers/mcpagent/do/McpAgent.ts` extends `agents/mcp`, but manually
  manages a SQLite session row and a `Set<WebSocket>`.
- `src/agents/base-agent.ts` has a custom 10-turn loop and manual context
  flushing.
- `src/services/action/router.ts` still has a TODO to replace send delay with
  Workflow `step.sleep()`.
- `src/workers/mcpagent/do/HindsightContainer.ts` uses Cloudflare Containers,
  and the dirty deploy-candidate diff is already moving toward `getContainer`.
- D1 reads use `env.D1_US.prepare(...)`, not D1 Sessions API.
- Canonical and compiled Postgres paths use direct Neon connection strings via
  `@neondatabase/serverless`, not Hyperdrive / Workers VPC.
- `src/services/action/integrations/browser.ts` uses `@cloudflare/puppeteer`
  against `env.BROWSER`, but does not use Browser Run Live View, HITL, or
  session recordings.
- No `secrets_store_secrets` bindings exist in `wrangler.toml`.
- `src/services/agents/router.ts`, inbound SMS/Telegram paths, and write-policy
  still reference `@cf/meta/llama-3.1-8b-instruct`, which Cloudflare listed for
  May 30, 2026 deprecation.

## Current Cloudflare Baseline

Verified against official Cloudflare docs and npm on 2026-06-01.

- Workers best practices now recommend Workers Static Assets for new static,
  SPA, and full-stack apps; Pages continues to work, but new features and
  optimizations are focused on Workers.
- The Cloudflare Vite plugin supports full-stack Workers, assets, standalone
  Workers, multi-Worker apps, and production-like local dev via workerd.
- Agents SDK current docs expose `Agent`, `MCPAgent`, `AIChatAgent` from
  `@cloudflare/ai-chat`, current context helpers, server-side routing, state
  sync, schedules, Sessions, and long-running agent patterns.
- Agent Sessions exist under `agents/experimental/memory/session` and support
  SQLite/Postgres providers, compaction, FTS, context providers, and cached
  system prompts.
- Workflows are GA and support durable steps, `step.sleep()`, `step.sleepUntil()`,
  and `step.waitForEvent()`. Agent docs also describe Workflow approval and
  AI chat tool `needsApproval` patterns.
- D1 read replication is used through `env.DB.withSession(bookmark)`; without
  Sessions API, reads continue to hit the primary.
- Vectorize V2 supports larger indexes, async mutations, metadata indexes, and
  improved metadata/namespace filtering. Metadata indexes must exist before
  vectors are upserted, otherwise older vectors need re-upsert.
- AI Gateway supports dynamic routing, caching, rate limiting, retries/fallbacks,
  request metadata, and `cf-aig-collect-log-payload: false` so HAETSAL can log
  token/cost metadata without storing sensitive prompts.
- Workers AI deprecated several older Llama 3/3.1 8B IDs on May 30, 2026 and
  recommends current alternatives such as `@cf/zai-org/glm-4.7-flash`.
- Browser Run has Live View, Human in the Loop, session recordings, and WebMCP.
- Hyperdrive can connect to private databases through Workers VPC; this is the
  recommended path for private database connectivity.
- Secrets Store bindings can put account-level secrets into Workers through
  `[[secrets_store_secrets]]`.
- Workers observability now separates logs/traces and supports head sampling;
  automatic tracing can expose binding and fetch operations.
- Containers current docs use `@cloudflare/containers` and `getContainer`.
  Recent changelog entries add placement constraints and outbound Worker access.

## What Is Actually Dated

### P0: Immediate Breakage / Currency

1. Retired Workers AI model IDs
   - Replace `@cf/meta/llama-3.1-8b-instruct`.
   - Suggested safe replacement: `@cf/zai-org/glm-4.7-flash` for cheap routing,
     inline replies, and classifiers.
   - Keep `llama-3.3-70b-instruct-fp8-fast` only after confirming it is still
     available and desirable for those workloads.

2. Compatibility date
   - Move from `2025-01-01` to a current date after a compatibility audit.
   - This also unlocks newer runtime defaults, including newer WebSocket close
     behavior.

3. SDK and type drift
   - Upgrade `wrangler`, `@cloudflare/workers-types`,
     `@cloudflare/vitest-pool-workers`, `@cloudflare/containers`, and `agents`.
   - Add package-split dependencies only where used:
     `@cloudflare/ai-chat`, `@cloudflare/think`, `@cloudflare/voice`.
   - Do not jump from Zod 3 to Zod 4 until the Agents/AI SDK migration map is
     explicit.

### P1: Platform Shape Drift

4. Pages should move behind Workers Static Assets
   - Current `pages/` app can stay React/Vite, but the deploy target should
     become the Worker with an `assets` binding.
   - Benefit: one public Cloudflare Worker surface, one Access/MCP/API boundary,
     and access to newer Worker-only features.

5. Wrangler config should probably move to `wrangler.jsonc`
   - TOML still works, but newer examples and programmatic tooling are centered
     on JSONC.
   - This is not urgent, but it will reduce drift with current Cloudflare docs
     and schema validation.

6. Observability is under-specified
   - `[observability] enabled = true` is too blunt for HAETSAL.
   - Add explicit `[observability.logs]` and `[observability.traces]` sampling.
   - Pair this with AI Gateway metadata-only logging so Law 2 is preserved.

### P2: Agent Runtime Drift

7. McpAgent is using current-ish foundations but old ergonomics
   - It extends `agents/mcp`, which is good.
   - But state persistence and WebSocket broadcast are manually managed.
   - Upgrade Agents SDK first, then decide how much to adopt:
     `setState()`, `onStateChanged()`, current context helpers, hibernatable
     WebSocket patterns, and schedule APIs.

8. BaseAgent is hand-rolled
   - The custom 10-turn loop is useful but should move toward AI SDK v6 tools,
     `stopWhen`, and structured tool calls.
   - Preserve HAETSAL's custom parts: doom-loop guard, Law 3 write rules,
     encrypted trace persistence, canonical memory interfaces.

9. Per-tenant schedules are cron-shaped
   - Fixed account-level crons should remain only for account-wide sweeps.
   - Tenant-specific heartbeat, weekly synthesis, reminders, and maintenance
     should move to Agent schedules or Think-style tasks when the SDK is upgraded.

10. Action delays / approvals should become Workflow-backed
    - Existing approval policy is HAETSAL-specific and should stay.
    - The durable mechanism should use Workflows `step.sleep()` /
      `waitForEvent()` / approval helpers instead of ad hoc state.

### P3: Data Plane Drift

11. D1 read replication is unused
    - Wrap tenant UI/status/audit read paths with D1 `withSession()`.
    - Use bookmarks where a user expects read-your-writes.
    - Leave write-heavy/control-plane paths on normal D1 writes.

12. Vectorize needs an explicit V2 / metadata-index audit
    - Confirm the `brain-memory` index is V2.
    - Create metadata indexes before re-upserting vectors:
      `tenant_id`, `scope`, `source_system`, `capture_mode`, `occurred_at`,
      and any query-critical project/entity fields.
    - Re-upsert vectors after metadata index creation.

13. Neon should move behind Hyperdrive plus Workers VPC where feasible
    - Direct public Neon connection strings are the dated part.
    - Target: Workers -> Hyperdrive -> Workers VPC -> private database.
    - Caveat: Hindsight container direct Postgres access may still need its own
      connection model; do not break the working container path casually.

14. Secrets should move to Secrets Store
    - Keep local `.dev.vars.example`.
    - Move deploy-time secrets to `[[secrets_store_secrets]]`:
      HMAC, Telnyx, Telegram, Brave, AI Gateway token, Neon/Canonical Postgres,
      Hindsight webhook, Google OAuth.

### P4: Tooling / UX Drift

15. Browser Rendering should become Browser Run where humans need visibility
    - Keep Puppeteer for simple extraction.
    - Use Browser Run Live View, HITL, and recordings for agentic browsing,
      debugging, purchase flows, auth walls, and high-stakes browsing.

16. AI Gateway should become the cost/control spine
    - Route all LLM calls through the gateway with explicit model-selection
      metadata.
    - Set `cf-aig-collect-log-payload: false`.
    - Populate HAETSAL's cost ledger from token/cost metadata, not prompt logs.
    - Configure dynamic routing/fallbacks for cheap, mid, and frontier tiers.

## What Not To Adopt Blindly

- Do not replace HAETSAL canonical memory with managed AI Search, managed RAG,
  or any plaintext managed memory surface. Law 2 still wins.
- Do not replace Hindsight simply because it is "old" if it is serving semantic
  projection correctly. Treat it as a swappable projection engine behind the
  canonical Open Brain contract.
- Do not move every cron to Agent schedules. Account-wide maintenance is still
  better as account-level cron or Workflow orchestration.
- Do not migrate to Zod 4 until the Agents SDK and test harness are ready for
  it. Zod 3 is old but stable; this should be a controlled dependency wave.
- Do not make Browser Run the default for trivial scrapes. Use it where
  observability or human handoff matters.

## Recommended Workstreams

### WS0 - Stop The Bleeding

Goal: remove current breakage and unlock new runtime defaults.

- Replace retired `@cf/meta/llama-3.1-8b-instruct` references.
- Bump `compatibility_date` in `wrangler.toml` and `wrangler.test.toml`.
- Upgrade Wrangler/workers-types/vitest pool/containers patch versions.
- Add explicit observability sampling.
- Run focused tests plus full suite.

Acceptance:

- No retired model IDs remain in `src/`.
- `npm test`, `npm run postflight`, and `npm run manifest` pass.
- Deployed smoke confirms inbound SMS/Telegram, write policy, memory capture,
  Hindsight projection, Graphiti projection, and compiled refresh still work.

### WS1 - Agents SDK Upgrade Map

Goal: move from `agents@0.7.x` to current `0.13.x` without changing behavior.

- Write an impact map for `agents/mcp`, `getAgentByName`, client helpers,
  package splits, Zod expectations, and Miniflare test behavior.
- Upgrade the SDK behind existing tests.
- Add packages only as used: `@cloudflare/ai-chat`, `@cloudflare/think`,
  `@cloudflare/voice`.

Acceptance:

- MCP surface still serves `/mcp`.
- `/ws` and `/inbound` behavior remains unchanged.
- Test harness no longer relies on stale agents bundling assumptions if the
  upgrade fixes them.

### WS2 - Worker-Native UI Deployment

Goal: retire the separate Pages deployment shape.

- Move `pages/` build output behind Workers Static Assets.
- Add `assets` config with SPA fallback.
- Evaluate Cloudflare Vite plugin for local dev and preview parity.
- Keep Cloudflare Access as the single auth boundary.

Acceptance:

- Dashboard, API, MCP, and websocket routes are served by the Worker boundary.
- No UI behavior changes.

### WS3 - Agent Runtime Modernization

Goal: reduce hand-rolled agent runtime code while preserving HAETSAL policies.

- Replace manual WebSocket/session state with current Agent state patterns where
  compatible.
- Move BaseAgent loop to AI SDK v6 structured tools and stop conditions.
- Use Sessions/compaction only for active conversation/session memory, not as
  canonical brain truth.
- Keep doom-loop guard, encrypted traces, canonical Open Brain APIs, and Law 3.

Acceptance:

- Fewer custom runtime lines.
- Equivalent reasoning traces and memory writes.
- No plaintext memory leak into managed Agent Session storage.

### WS4 - Data Plane Modernization

Goal: make the existing brain substrate faster, safer, and more platform-native.

- Add D1 read sessions/bookmarks for read-heavy UI/status/audit surfaces.
- Verify Vectorize V2 and metadata indexes; re-upsert as needed.
- Move deploy secrets to Secrets Store.
- Pilot Hyperdrive + Workers VPC for canonical Postgres first; evaluate Hindsight
  container constraints separately.

Acceptance:

- Tenant reads preserve read-your-writes.
- Vector filtering works by tenant/source/scope.
- Secrets no longer live as deploy-visible variables.
- Canonical Postgres connectivity path is privately reachable or has a documented
  blocker.

### WS5 - Workflow-Backed Actions And Schedules

Goal: make long-running human-in-the-loop behavior durable.

- Replace send-delay TODO with Workflow `step.sleep()`.
- Replace manual approval waiting with `waitForEvent()` / approval helper pattern.
- Move tenant-specific repeated work to Agent schedules only after SDK upgrade.

Acceptance:

- Approval/delay survives Worker restart.
- RED/YELLOW/GREEN action policy and HMAC preference checks remain unchanged.

### WS6 - Browser Run And Observability

Goal: make agent browsing and operations inspectable.

- Keep simple Puppeteer extraction.
- Add Browser Run Live View / HITL / recordings for high-stakes browser actions.
- Send structured Workers logs/traces to an OTLP destination or dashboard flow.
- Use AI Gateway metadata-only logs for cost/routing analysis.

Acceptance:

- Browser sessions can be replayed/inspected when needed.
- Cost ledger populates without prompt/response payload retention.

## Suggested Sequencing

1. WS0 immediately.
2. WS1 next because most later work is easier on the current Agents SDK.
3. WS2 and WS4 can run in parallel after WS0.
4. WS3 after WS1.
5. WS5 after WS1 and after the action policy tests are strong.
6. WS6 opportunistically after Browser Run credentials/account features are
   confirmed.

## Source Links

- Workers best practices:
  https://developers.cloudflare.com/workers/best-practices/workers-best-practices/
- Workers Static Assets / Pages migration:
  https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/
- Cloudflare Vite plugin:
  https://developers.cloudflare.com/workers/vite-plugin/
- Agents API:
  https://developers.cloudflare.com/agents/api-reference/agents-api/
- Agents Sessions:
  https://developers.cloudflare.com/agents/api-reference/sessions/
- Agents schedules:
  https://developers.cloudflare.com/agents/api-reference/schedule-tasks/
- Long-running agents:
  https://developers.cloudflare.com/agents/concepts/long-running-agents/
- Human in the loop:
  https://developers.cloudflare.com/agents/concepts/human-in-the-loop/
- Workflows:
  https://developers.cloudflare.com/workflows/
- Workflows Workers API:
  https://developers.cloudflare.com/workflows/build/workers-api/
- D1 read replication:
  https://developers.cloudflare.com/d1/best-practices/read-replication/
- Vectorize metadata filtering:
  https://developers.cloudflare.com/vectorize/reference/metadata-filtering/
- Vectorize V2 transition:
  https://developers.cloudflare.com/vectorize/reference/transition-vectorize-legacy/
- AI Gateway features:
  https://developers.cloudflare.com/ai-gateway/features/
- AI Gateway metadata-only payload logging:
  https://developers.cloudflare.com/changelog/post/2026-03-17-collect-log-payload-header/
- Workers AI model deprecations:
  https://developers.cloudflare.com/changelog/post/2026-05-08-planned-model-deprecations/
- Browser Run changelog:
  https://developers.cloudflare.com/browser-run/changelog/
- Hyperdrive + Workers VPC:
  https://developers.cloudflare.com/hyperdrive/configuration/connect-to-private-database-vpc/
- Secrets Store bindings:
  https://developers.cloudflare.com/secrets-store/integrations/workers/
- Containers:
  https://developers.cloudflare.com/containers/
- Durable Object rules:
  https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- Workers traces:
  https://developers.cloudflare.com/workers/observability/traces/

# Cloudflare Modernization Execution Plan

Date: 2026-06-01
Status: proposed execution plan
Scope: Cloudflare platform currency only
Workspace: `C:\Users\matth\Documents\HAETSAL OS 11.4 deploy`

## Boundary

This plan deliberately does not solve the post-Hindsight knowledge architecture.
The desired direction is to remove Hindsight completely, but that should be a
separate memory-plane migration. This Cloudflare wave should avoid adding new
Hindsight dependency and should not deepen the Hindsight integration.

The goal here is to bring HAETSAL onto current Cloudflare platform capabilities
while preserving behavior:

- Worker remains the only public face.
- Neon/R2 remain canonical brain truth for now.
- D1 remains operational metadata and hot UI/control-plane state.
- No plaintext memory content is added to D1, KV, Analytics Engine, logs, or AI
  Gateway logs.

## Execution Principles

- Upgrade substrate before architecture: compatibility date, SDKs, config, and
  tests come first.
- Use current Worker-native deployment patterns, but do not rewrite the product
  UI.
- Prefer additive bindings and side-by-side paths before cutover.
- Keep each workstream independently shippable.
- Every phase ends with deploy smoke tests for MCP, inbound messages, action
  proposals, memory capture, projection dispatch, and UI/API access.

## Phase 0 - Baseline And Guardrails

Purpose: establish a known-good deploy candidate before changing primitives.

Tasks:

1. Freeze the latest worktree as the baseline:
   - branch: `codex/11-4-deploy-candidate`
   - record current `wrangler.toml`, `package-lock.json`, deploy ID, and smoke
     result.
2. Add a Cloudflare currency checklist to the repo:
   - compatibility date
   - Wrangler version
   - Workers types version
   - Agents SDK version
   - Containers package version
   - deprecated Workers AI model scan
   - Pages vs Workers Static Assets status
   - Secrets Store status
   - D1 Sessions status
   - observability sampling status
3. Add automated scans:
   - fail if retired model IDs appear in `src/`
   - fail if `compatibility_date` is older than the chosen current date window
   - fail if new plaintext memory fields appear in D1 migrations.

Acceptance:

- Existing tests pass before modernization.
- Postflight/manifest pass.
- The old deployment remains rollback-ready.

## Phase 1 - Stop Current Platform Drift

Purpose: remove things most likely to break soon.

Tasks:

1. Replace retired Workers AI model IDs:
   - replace `@cf/meta/llama-3.1-8b-instruct`
   - default replacement for cheap classification/routing: `@cf/zai-org/glm-4.7-flash`
   - keep `@cf/meta/llama-3.3-70b-instruct-fp8-fast` only after verifying
     availability and role.
2. Move model IDs into a single model registry module:
   - `MODEL_ROUTER_FAST`
   - `MODEL_ROUTER_DEEP`
   - `MODEL_WRITE_POLICY`
   - `MODEL_CONSOLIDATION`
   - `MODEL_FALLBACK`
3. Update compatibility dates in `wrangler.toml` and `wrangler.test.toml`.
4. Upgrade low-risk Cloudflare packages first:
   - `wrangler`
   - `@cloudflare/workers-types`
   - `@cloudflare/vitest-pool-workers`
   - `@cloudflare/containers`
5. Run the full local test suite and Cloudflare Worker test pool.

Acceptance:

- No deprecated model IDs remain in runtime code.
- Local and Worker-pool tests pass.
- Inbound SMS/Telegram and MCP smoke continue to work.

## Phase 2 - Wrangler Config Modernization

Purpose: make configuration match current Cloudflare examples and reduce drift.

Tasks:

1. Decide whether to keep TOML or move to `wrangler.jsonc`.
   - Recommended: move to `wrangler.jsonc` after Phase 1, because current docs
     and schema examples increasingly use JSONC.
2. Add schema validation.
3. Normalize all bindings:
   - Durable Objects
   - Containers
   - Queues
   - D1
   - R2
   - KV
   - Vectorize
   - Browser
   - Analytics Engine
   - AI Gateway
   - Workflows
4. Make local/test/production environments explicit.
5. Add explicit observability config:
   - logs enabled
   - traces enabled with intentional head sampling
   - no memory content in logs.

Acceptance:

- `wrangler deploy --dry-run` or equivalent config validation succeeds.
- Type generation matches bindings.
- Local dev still starts with test bindings.

## Phase 3 - Agents SDK Currency Without Behavior Change

Purpose: upgrade the Cloudflare Agents foundation before adopting new agent
features.

Tasks:

1. Map the current `agents@0.7.x` usage:
   - `agents/mcp`
   - MCP route mounting
   - `getAgentByName`
   - Durable Object storage assumptions
   - WebSocket assumptions
   - test harness assumptions.
2. Upgrade to current `agents`.
3. Add split packages only when actually used:
   - `@cloudflare/ai-chat`
   - `@cloudflare/think`
   - `@cloudflare/voice`
4. Do not adopt Agent Sessions as canonical memory.
   - Agent Sessions may be used later for active conversation/session state.
   - They must not store plaintext canonical memory.
5. Keep the current MCP behavior stable.

Acceptance:

- `/mcp`, `/ws`, and inbound routes behave the same.
- Existing Durable Object state survives or has a documented migration.
- No plaintext memory leaks into Agent Session storage.

## Phase 4 - Worker-Native UI Deployment

Purpose: move from Pages-era deployment to Workers Static Assets.

Tasks:

1. Keep the existing React/Vite UI, but serve it from the Worker using Workers
   Static Assets.
2. Add an `ASSETS` binding with SPA fallback.
3. Remove the Pages Function proxy once Worker assets are serving correctly.
4. Evaluate the Cloudflare Vite plugin after the simple Static Assets path is
   proven.
5. Preserve CF Access behavior and auth header semantics.

Acceptance:

- One public Worker surface serves UI and API.
- Deep links in the SPA work.
- CF Access/auth behavior is unchanged.
- Pages deploy is no longer required for the primary app.

## Phase 5 - Secrets And Private Connectivity

Purpose: remove dated public-secret and public-database assumptions.

Tasks:

1. Inventory all secrets:
   - Neon / canonical Postgres
   - AI Gateway
   - Telnyx
   - Telegram
   - Google OAuth
   - webhook HMACs
   - Brave/search keys
   - any Hindsight leftovers.
2. Move account-level deploy secrets to Cloudflare Secrets Store bindings.
3. Keep local `.dev.vars.example` for development only.
4. Pilot Hyperdrive plus Workers VPC for canonical Neon/Postgres.
5. Keep direct connection fallback until a deploy smoke proves private path.

Acceptance:

- Production Worker receives deploy secrets from Secrets Store.
- Canonical Postgres has either a private Hyperdrive path or a documented
  blocker.
- No public connection string is required by the Worker path after cutover.

## Phase 6 - D1 As Operational Read Model

Purpose: modernize D1 without letting it become the brain.

Tasks:

1. Audit D1 tables and classify each as:
   - operational metadata
   - audit
   - action state
   - hot UI read model
   - illegal memory content.
2. Move any sensitive plaintext operational text to encrypted R2/Neon and leave
   D1 pointers.
3. Add D1 Sessions API/read replication to read-heavy UI/status paths.
4. Use bookmarks where users need read-your-writes behavior after approvals or
   settings updates.
5. Keep write-heavy mutation paths on normal prepared statements/batches.

Acceptance:

- D1 has no memory bodies or sensitive reflection text.
- UI/status reads can use read replicas.
- Action/audit atomic batch behavior remains intact.

## Phase 7 - Workflows And Queues

Purpose: use durable orchestration for waits, approvals, and long operations.

Tasks:

1. Replace ad hoc send-delay logic with Workflow `step.sleep()`.
2. Use Workflow event waits for approval/cancel/timeout flows where appropriate.
3. Keep Queues for simple fire-and-forget fanout.
4. Keep Workflows for multi-step, long-running, retryable operations:
   - bootstrap import
   - full export
   - large source sync
   - long synthesis
   - irreversible action delay.
5. Make workflow IDs idempotent by tenant/action/job key.

Acceptance:

- Irreversible action delay survives Worker restarts.
- Approval/cancel race behavior is deterministic.
- No >30s synchronous MCP path remains.

## Phase 8 - Browser Platform Update

Purpose: keep cheap automation cheap while adding modern debugging/HITL.

Tasks:

1. Keep current Browser Rendering/Puppeteer for simple extraction.
2. Add Browser Run options for high-stakes flows:
   - Live View
   - Human in the Loop
   - session recording
3. Add policy routing:
   - read-only scrape: normal Browser Rendering
   - auth wall, purchase, external write, unknown UI: Browser Run with optional
     HITL/recording
4. Store only metadata/recording references, not secrets or memory content.

Acceptance:

- Simple browse actions still work.
- A high-risk browser action can surface a Live View URL for human intervention.
- Recording is opt-in and redacted by policy.

## Phase 9 - AI Gateway And Observability Spine

Purpose: make model routing, cost, fallback, and traces inspectable without
logging private memory content.

Tasks:

1. Route all LLM calls through AI Gateway.
2. Set metadata on every call:
   - tenant hash, not tenant content
   - agent identity
   - workload class
   - model tier
   - trace ID
3. Use `cf-aig-collect-log-payload: false` for sensitive paths.
4. Centralize retries/fallbacks/dynamic routing.
5. Populate HAETSAL cost summaries from token/cost metadata.
6. Add trace sampling config for Workers observability.

Acceptance:

- Cost ledger matches gateway usage.
- No prompt/response payloads are collected by default.
- Failed provider calls have traceable metadata.

## Phase 10 - Containers And Hindsight Containment

Purpose: update Cloudflare Containers while avoiding renewed Hindsight lock-in.

Tasks:

1. Upgrade `@cloudflare/containers` and align container usage with current
   `Container` / `getContainer` patterns.
2. Keep Hindsight container alive only as legacy compatibility until the
   memory-plane removal plan lands.
3. Do not add new features that depend on Hindsight-only semantics.
4. Apply the same container modernization to any non-Hindsight container.
5. Document container placement, health, restart, and outbound access behavior.

Acceptance:

- Container deploy still works.
- No new Hindsight-only dependency is added.
- The future removal boundary is explicit.

## Phase 11 - Vectorize Audit

Purpose: update retrieval infrastructure without redesigning memory.

Tasks:

1. Confirm Vectorize index version.
2. Create required metadata indexes before upserting future vectors.
3. Re-upsert affected vectors if metadata indexes are added after the fact.
4. Keep Vectorize as retrieval index, not source of truth.
5. Confirm no raw memory bodies are stored in vector metadata.

Acceptance:

- Semantic index supports intended tenant/scope/source filters.
- Retrieval can link back to canonical Neon/R2 records.
- Vector metadata contains only approved metadata.

## Final Cutover Checklist

- Compatibility date current.
- Cloudflare packages current or deliberately pinned.
- Deprecated Workers AI model scan clean.
- Worker-native UI deployed.
- Pages proxy retired or explicitly marked legacy.
- Secrets Store bindings active.
- Canonical Postgres private path either live or tracked as blocker.
- D1 read model audited and read replication used where useful.
- Workflows own long waits and durable approvals.
- Browser Run available for HITL flows.
- AI Gateway metadata-only logging active.
- Observability sampling explicit.
- No new Hindsight dependency introduced.

## Rollback Strategy

- Keep the pre-modernization Worker deployment ID.
- Change one platform primitive per deploy where possible.
- Use feature flags for:
  - Worker Static Assets cutover
  - Hyperdrive path
  - Browser Run path
  - Workflow-backed action delay
  - Agent SDK session features
- Roll back by flag first, deploy rollback second.

## Source References

- Workers best practices and Static Assets:
  https://developers.cloudflare.com/workers/best-practices/workers-best-practices/
- Workers Static Assets:
  https://developers.cloudflare.com/workers/static-assets/
- Cloudflare Vite plugin static assets:
  https://developers.cloudflare.com/workers/vite-plugin/reference/static-assets/
- Agents scheduled tasks:
  https://developers.cloudflare.com/agents/api-reference/schedule-tasks/
- Agents Sessions:
  https://developers.cloudflare.com/agents/api-reference/sessions/
- D1 read replication and Sessions API:
  https://developers.cloudflare.com/d1/best-practices/read-replication/
- Workflows sleep/retry:
  https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/
- Workers AI Llama 3.1 8B deprecation:
  https://developers.cloudflare.com/workers-ai/models/llama-3.1-8b-instruct/
- GLM-4.7-Flash:
  https://developers.cloudflare.com/changelog/post/2026-02-13-glm-47-flash-workers-ai/
- Secrets Store Worker integration:
  https://developers.cloudflare.com/secrets-store/integrations/workers/
- Hyperdrive private database via Workers VPC:
  https://developers.cloudflare.com/changelog/post/2026-04-29-hyperdrive-vpc-private-databases/
- Browser Run Human in the Loop:
  https://developers.cloudflare.com/browser-rendering/features/human-in-the-loop/
- Browser Run session recording:
  https://developers.cloudflare.com/browser-run/features/session-recording/

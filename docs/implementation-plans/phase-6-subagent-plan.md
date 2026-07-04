# Phase 6 Implementation Plan — Sub-Agent Spawn + Cancel/Retry

Date: 2026-07-04. Author: Fable 5 (mission session). Spec source: HAETSAL_MISSION.md §8 Phase 6
+ docs/implementation-plans/phase-6-kickoff-context.md.

## Verified platform facts (CHECK-IN Step 2)

- `agents@0.17.0` installed. Sub-agent primitives confirmed against the installed
  package (`node_modules/agents/dist/agent-tool-types-*.d.ts` + `index.js`):
  - `subAgent(cls, name)` resolves through `ctx.exports[className]` + `ctx.facets` —
    the child class must be **exported from the worker entry point** under its own
    name; no wrangler DO binding or migration is required for a facet class. The
    ROOT class (`McpAgentDO`) must be export-named + namespace-bound (it is).
  - `runAgentTool(cls, {input, inputPreview, detached})` requires the CHILD to
    implement the **agent-tool child adapter** (duck-typed, checked at dispatch):
    `startAgentToolRun(input,{runId,signal?}) → AgentToolRunInspection`,
    `cancelAgentToolRun(runId,reason?)`, `inspectAgentToolRun(runId)`,
    `getAgentToolChunks(runId)`. Chat hosts (Think/AIChatAgent) ship it; a lean
    `Agent` subclass may implement it directly (exported `AgentToolChildAdapter` type).
  - Run ledger lives in the **parent DO SQLite** table `cf_agent_tool_runs`
    (status, input_preview, summary, output_json, progress, milestones, detached
    bookkeeping). `_updateAgentToolTerminal` persists `summary` + `output_json`
    verbatim → **Law 2: child output/summary must be ciphertext or content-free.**
  - Detached runs: `detached: { onFinish: '<methodName>', maxBudgetMs,
    noProgressBudgetMs }`. onFinish invoked as `(runInfo: AgentToolRunInfo,
    lifecycle: AgentToolLifecycleResult)` via a claim+lease at-least-once funnel →
    handler must be idempotent. Budget expiry delivers `interrupted/budget-exceeded`.
  - `cancelAgentTool(runId, reason)` → child's `cancelAgentToolRun`; idempotent.
  - `keepAliveWhile(fn)` holds the DO alive during child work (facets delegate the
    heartbeat to the root).
- Workers AI `@cf/meta/llama-3.3-70b-instruct-fp8-fast`: **function calling: Yes**,
  `tool_calls[]` in output, 24k context (developers.cloudflare.com model page,
  checked 2026-07-04). MODEL_DEEP stays the agent-loop tier; tolerant parser handles
  both `{name, arguments}` and OpenAI-nested `{function:{name, arguments}}` shapes.
- `@cloudflare/think` = 0.12.1 (published 2026-07-02, pre-1.0 Preview, actively
  churning). **Decision: NOT adopted for Phase 6.** It is an AI-SDK streaming chat
  harness; our G4 pipeline is `env.AI.run` via AI Gateway with `collectLog:false`
  and the model registry. Everything Phase 6 needs (spawn/cancel/retry/heartbeat/
  budget auto-fail) is in the base SDK agent-tool layer. Revisit Think at Phase 9
  (Sessions/Think working context), where the mission already scopes it.

## Architecture

**Interaction agent** = the per-tenant `McpAgentDO` (holds TMK, WS, schedules),
fronted by the channel webhooks. **Execution agent** = new `ExecutionAgent` facet
class (extends `Agent`), one instance per run (named by runId), implementing the
child adapter with a real function-calling tool loop.

Flow (text inbound, Telegram/Sendblue):
1. Webhook → `maybeDelegateToExecutionAgent(env, tenantId, text, {channel, replyTo})`.
2. Delegation decider: pattern-first (research/multi-step verbs) + MODEL_CHAT
   classifier fallback; conservative default `inline`. Inline → existing
   `buildGroundedReply`. Delegate → DO RPC `dispatchExecutionTask`.
3. `dispatchExecutionTask` (parent DO): requires TMK (honest null → channels fall
   back inline); persists TMK-encrypted task record in own SQLite
   (`haetsal_agent_tasks`: ciphertext, profile, tools, reply route, lineage);
   `runAgentTool(ExecutionAgent, { input (plaintext over in-process RPC only),
   inputPreview (content-free), detached: { onFinish: 'onExecutionTaskFinish',
   maxBudgetMs: 900_000, noProgressBudgetMs: 300_000 } })` → ack text with runId.
4. `ExecutionAgent.startAgentToolRun`: derives TMK from jwtSub (same derivation as
   approve route), runs scoped tool loop (max 6 turns): MODEL_DEEP + `tools`
   (scoped subset only — structural allowlist), executes READ tools inline
   (recall_memory → searchCanonicalMemory; web_search → executeWebSearch + audit),
   WRITE tools as proposals through the existing act stubs → authorization gate.
   Doom-loop guard reused (`checkDoomLoop`). After each step persists content-free
   progress `{fraction, phase, at}` + heartbeat in child SQLite. Returns
   `{status:'completed', output: {ciphertext}, summary: '<content-free>'}`.
5. Detached terminal → `onExecutionTaskFinish(runInfo, lifecycle)` on the parent:
   reads `output_json` ciphertext from `cf_agent_tool_runs`, decrypts with TMK,
   delivers over the originating channel, writes episodic memory
   (`agent:execution_agent` provenance), audit row, updates task record. Idempotent
   via task-record state check.
6. Cancel path: dashboard → Worker route → DO RPC `cancelAgentRun(runId)` →
   `cancelAgentTool` → child's `cancelAgentToolRun` sets a durable cancelled flag
   + aborts in-memory controller; loop checks the flag before every model call and
   every tool execution → status 'aborted' visible immediately (≤5s bar met:
   ledger flips instantly; in-flight model call is not awaited further for effects).
7. Retry path: DO RPC `retryAgentRun(runId)` → decrypt stored task spec → fresh
   dispatch with `retry_of` lineage recorded.

**Dashboard surface (this phase, minimal):** CF-Access-protected routes on the
Worker: `GET /api/agents/runs` (content-free ledger JSON: run id, profile, scoped
tools, status, progress phase/fraction, heartbeat age, timestamps, lineage),
`POST /api/agents/runs/:id/cancel`, `POST /api/agents/runs/:id/retry`,
`GET /dashboard/agents` (single-page HTML panel, 2s auto-refresh, cancel/retry
buttons). Full 8-panel dashboard remains Phase 11.

**Removed:** `ChiefOfStaff.parseDelegation` + `DelegationSignal` (text-parsed
delegation signal — was never wired into a live path; native spawn replaces the
design). `tests/3.1-chief-of-staff.test.ts` updated accordingly.

**Fold-in:** `src/tools/act/remind.ts` channel enum `['sms','push','both']` →
canonical `['sms','imessage','telegram','email']`.

## Pre-flight (9 questions, phase surface)

1. **Law check** — Law 1: no new public surface except CF-Access-protected routes
   on the existing Worker (dashboard/API); webhooks unchanged. Law 2: run ledger
   holds ciphertext output + content-free summaries/previews/progress; task specs
   TMK-encrypted in DO SQLite (Phase 5 `cf_agents_schedules` precedent); no content
   in D1/KV/AE/logs. Law 3: execution agents write episodic only, via existing
   governed retain path. PASS.
2. **State tier** — run metadata + encrypted task/output: DO SQLite (T3 extension,
   same plane as cf_agents_schedules); audit rows: D1 (T2, content-free); memory
   writes: T1 canonical. No new D1 tables; migration 1024 not needed.
3. **Compute tier** — dispatch + loop run inside the tenant DO (C2) with
   `keepAliveWhile`; per-turn model calls are seconds-scale; 15-min budget bounds
   total. Long-horizon consolidation stays Phase 8/C4.
4. **Encryption** — task spec + result encrypted with TMK before rest (reuse
   `encryptWithKek/decryptWithKek` AES-GCM helpers); decrypt transiently at
   delivery/retry. Cron KEK untouched.
5. **Agent identity** — `execution_agent/<profile>` in audit + provenance
   `agent:execution_agent`. Memory type: episodic only.
6. **Authorization gate** — READ tools inline (GREEN fixed floor) with audit;
   WRITE tools only as proposals through existing act stubs → gate (capability
   class + TOCTOU + delay preserved). No new bypass.
7. **Audit chain** — spawn/cancel/retry/finish write `writeAuditLog` D1 rows
   (content-free), same batch semantics as existing action audit.
8. **Service layer** — decider + dispatch helpers are service functions; DO
   methods are thin; routes call DO RPC. No business logic in route handlers.
9. **Hono pattern** — new routes registered after auth+audit middleware chain,
   like /api/actions.

## Stop-condition watch

S3 (CF semantics): facets availability at compatibility_date 2026-06-01 is
verified by dry-run + tests before deploy. S5: none required (no Google paths).
S9: no secrets in diffs/logs — enforced by review before commit.

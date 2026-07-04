# Phase 6 Lessons — Sub-Agent Spawn + Cancel/Retry

Date: 2026-07-04. Scope: Agents SDK 0.17.0 sub-agent primitives in production use.

## SDK contracts that were NOT obvious from the announcement docs

1. **`runAgentTool` awaits `startAgentToolRun` before returning the detached
   handle.** A child adapter that runs its whole task inside
   `startAgentToolRun` silently turns a "detached" dispatch into a blocking
   call (it would have held the inbound webhook open for minutes). The child
   MUST return `{status: 'running'}` immediately and finish in background
   (`ctx.waitUntil` + `keepAliveWhile`). This is how the chat hosts behave;
   nothing type-checks it.

2. **The child adapter is duck-typed and open.** `_asAgentToolChildAdapter`
   only checks for the four methods (`startAgentToolRun`,
   `cancelAgentToolRun`, `inspectAgentToolRun`, `getAgentToolChunks`); the
   error message suggests Think/AIChatAgent, but a lean `Agent` subclass
   implementing the exported `AgentToolChildAdapter` shape works and keeps our
   AI Gateway (`collectLog: false`) model pipeline intact.

3. **Detached completion latency is backbone-cadenced (5/15/30/120s) unless
   the child implements `tailAgentToolRun`.** An empty `ReadableStream` that
   simply closes when the run row leaves `running` makes the parent's warm
   fast path deliver `onFinish` ~1s after the loop ends. The backbone remains
   the eviction-surviving guarantee.

4. **`onFinish` lifecycle carries no output.** It delivers
   `(runInfo, {status, summary, error, reason})`; the run OUTPUT must be read
   back from `cf_agent_tool_runs.output_json` in the parent's own SQLite (or
   via child inspect). Design the output shape for that table (see Law 2 note).

5. **Give-up is soft, and delivery is at-least-once.** `interrupted /
   budget-exceeded` can be followed by a late real `completed` — the framework
   keeps two delivery slots. Our task ledger mirrors that: the give-up claim
   does not block the final claim, but a final claim closes both (a stale
   timeout note can never follow a delivered result... and a late result CAN
   follow a timeout note, which is what you want).

6. **Facet classes need no wrangler migration/binding** — they resolve through
   `ctx.exports[className]` + `ctx.facets`, so the class must be exported from
   the worker entry point UNDER ITS OWN NAME. The ROOT agent class must still
   be a bound DO namespace. Minifiers that rename classes break this
   (`keepNames` if a bundler ever enters the chain).

## Law 2 finding (load-bearing)

`cf_agent_tool_runs` persists `summary` and `output_json` verbatim in the
parent DO's SQLite. Any child whose result contains memory content MUST return
ciphertext (we TMK-encrypt with the same `deriveTmk(jwtSub, CF_ACCESS_AUD)`
derivation as `initTenant`, so parent decrypt works) and keep summaries to a
fixed content-free vocabulary. Same discipline as Phase 5's
`cf_agents_schedules` reminder encryption. `inputPreview` is caller-controlled
— pass `{profile, tools}` only, never task text.

## Testing constraints

- The vitest pool entry (`tests/test-entry.ts`) deliberately excludes the
  agents-SDK DO, so real facet spawns cannot be exercised in tests; the
  adapter semantics are unit-tested against fakes and the spawn path is
  verified at the live-smoke gate.
- `agents`-package imports in test files hit the pool's CJS resolution known
  issue for `ajv`/`ajv-formats` (via @modelcontextprotocol/sdk): fixed with
  `test.deps.optimizer.ssr.include = ['ajv', 'ajv-formats']`. Do NOT add the
  whole `agents` package to the optimizer — it imports node builtins the
  optimizer cannot bundle.
- When unit-testing the tool loop with a scripted `env.AI`, remember
  `recall_memory` calls the embedding model through the SAME `env.AI` — count
  loop turns with a tool whose executor makes no AI calls (web_search).

## Think evaluation (decision record)

`@cloudflare/think` 0.12.1 (Preview, published the day before this phase) is
an AI-SDK streaming chat harness. Phase 6 needs spawn/cancel/retry/heartbeat/
budgets — all present in the base SDK agent-tool layer. Adopting Think would
have re-plumbed model calls through an AI SDK binding (losing our
registry/G4 wiring) for no Phase 6 capability. Re-evaluate at Phase 9
(Sessions/Think working context), where the mission scopes it deliberately.

## Gate review outcomes (2026-07-04)

- **Fresh-context verifier: PASS/APPROVE.** All four acceptance criteria
  verified with file:line evidence; 29 Phase 6 + 12 regression tests green on
  a fresh run; defect sweep (claim races, ledger leaks, RPC serialization,
  grounded-reply preservation) clear.
- **Law-2 audit: PASS-WITH-NOTES, TMK symmetry confirmed.** The one MEDIUM
  (run-row `error` column was safe only by call-graph) was fixed same-session:
  `sanitizeExecutionError` in run-store.ts maps every persisted error to a
  fixed vocabulary (`encryption_failure`, `deadline_exceeded`, `cancelled`,
  `model_call_failure`, `unexpected_error:<class>`), with a contract test.
- **Pre-existing notes carried to Phase 13 hardening (NOT Phase 6
  regressions):** (a) retain queue messages carry plaintext `content`
  alongside `contentEncrypted` — strip the plaintext field at the enqueue site
  for all callers; (b) `GATEWAY_CHAT_EMPTY` diagnostic logs up to 80 chars of
  model output on the null-parse path (workers-ai-chat.ts); (c) synthetic
  OAuth-prefixed test tokens in tests/2.2 could false-positive secret scans.

## Sendblue Free Tier note (carried forward)

Execution-agent results delivered to the `sendblue` channel are subject to the
same 24h reply-window limit as every outbound; if a run finishes outside the
window the delivery fails softly (logged `AGENT_RESULT_DELIVERY_FAILED`).
Telegram is the reliable live channel for the demo gate.

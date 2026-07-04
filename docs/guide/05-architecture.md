# 5. Architecture

> **In plain terms:** The whole system is one program running on
> Cloudflare's network, with one door in. Inside, your "session" is a
> little stateful computer that wakes when you talk to it, and it can
> spin up helper agents, set timers, and hand heavy work to queues and
> long-running jobs. Your memories live in a Postgres database the
> program reaches over a private line. No servers to patch, nothing
> at home to keep on.

## The shape of it

```
                    Cloudflare Access (Google sign-in)
                                 │
                 ┌───────────────▼────────────────┐
   Internet ────▶│   the-brain (one Worker)       │  Law 1: the only public thing
                 │  /mcp  /api/*  /dashboard.html │
                 └──┬──────────┬─────────┬────────┘
                    │          │         │
        ┌───────────▼──┐  ┌────▼───┐ ┌───▼──────────────┐
        │ McpAgentDO   │  │ Queues │ │ Workflows        │
        │ (your session│  │ 5 lanes│ │ bootstrap, dream │
        │  + facets)   │  └────┬───┘ └───┬──────────────┘
        └──┬───────┬───┘       │         │
           │       │        ┌──▼─────────▼──────────────────┐
           │       │        │ Stores                        │
  ┌────────▼──┐ ┌──▼─────┐  │ Neon Postgres (Hyperdrive) ←──┼── the ONE plaintext store
  │ ExecutionA│ │ DO     │  │ D1 (metadata) · KV (keys)     │
  │ gent      │ │ alarms │  │ R2 (sealed blobs) · AE (rsvd) │
  │ (facets)  │ │        │  └───────────────────────────────┘
  └───────────┘ └────────┘        Workers AI via AI Gateway
```

- **One Worker** (`the-brain`) receives everything: MCP traffic, API
  calls, webhooks, dashboard assets, cron ticks, queue batches.
- **One Durable Object class** (`McpAgentDO`) is your session: MCP server,
  chat state, tool registry, automations, sub-agent bookkeeping. It's
  addressed by a name derived from your tenant id, so "your brain" is
  always the same object with the same private SQLite.
- **Sub-agents are facets**: child agents (`ExecutionAgent`) spawned *inside*
  your DO's context — same isolation, no separate deployment.
- **Queues** split work by urgency (high/normal/bulk), plus a dedicated
  actions queue (batch size 1 — actions never batch) and a dead-letter
  queue.
- **Workflows** handle long, must-finish jobs (nightly dream cycle,
  tenant bootstrap) with durable step semantics.
- **Smart placement** runs the Worker near the database (Neon, us-west-2)
  so Postgres round-trips are short.

## The request lifecycle (what happens when you ask something)

1. Cloudflare Access authenticates you at the edge (Law 1) and injects a
   signed JWT.
2. The Worker verifies the JWT, derives your tenant id and — per request —
   your **tenant master key (TMK)** from it ([chapter 7](07-security.md)).
3. The request routes to your `McpAgentDO`. Chat goes to the working
   session; tool calls go to the registered tool; dashboard calls go to
   read models.
4. Memory reads/writes cross to Neon over Hyperdrive — the single
   plaintext boundary. Anything cached, queued, logged, or persisted
   elsewhere is ciphertext or metadata.
5. Replies stream back; retrieval traces and audit rows (content-free)
   are recorded as they go.

---

## Under the hood

### The Durable Object and its facets

`McpAgentDO` is built on the Cloudflare Agents SDK (0.17.x). Sub-agents
use the SDK's **facet** mechanism: the parent spawns a named child class
(`ExecutionAgent`) via `subAgent()`; the child implements the agent-tool
adapter (`startAgentToolRun` / `cancelAgentToolRun` / `inspectAgentToolRun`
/ `getAgentToolChunks` / `tailAgentToolRun`). Three hard-won rules encoded
in `src/agents/execution-agent.ts` and `src/agents/execution/*`:

- **Return `running` immediately.** The SDK *awaits* `startAgentToolRun`
  before handing back a detached handle — so the child must acknowledge
  instantly and do the actual work via `waitUntil` + keep-alive, or the
  parent blocks for the whole run.
- **Cancel is a data race you must win**: `markCancelled` flips run status
  synchronously (observed cancel latency in the live demo: 439–881 ms
  against a 5 s budget), and the tool loop checks status between steps.
- **Budgets**: 15-minute hard cap per run, 5-minute no-progress auto-fail
  (the "stuck agent" reaper), with detached completion callbacks
  (`onExecutionTaskFinish`) delivering results exactly once (idempotent
  claim-slot in `agent-finish.ts`).

Each spawn gets a **tool profile** (`research`/`memory`/`comms`/`general` —
`PROFILE_TOOLS` in `src/agents/execution/tool-registry.ts`): a sub-agent
researching the web simply does not *have* the send-message tool.
Execution traces are AES-GCM-sealed to R2; the framework-persisted
summary/output columns get ciphertext or content-free strings only
(`sanitizeExecutionError` maps failures to a fixed vocabulary).

### Model calls

Every LLM call goes through **Workers AI via the AI Gateway**
(`haetsal-brain-gateway`): tiered model selection (`src/agents/models.ts`),
retry with `[800, 3200]` ms backoff on upstream blips, embeddings via
`bge-base-en-v1.5`. The gateway gives one choke point for cost tracking
(the Usage panel derives from the audit ledger) — and payload logging
stays off content (shape-only logs, e.g. `GATEWAY_CHAT_EMPTY`).

### Queues and workflows

Ingestion rides priority queues with explicit batch sizes/timeouts
(`wrangler.toml`); the actions queue is `max_batch_size = 1` with platform
retries and a DLQ. Long jobs are Workflows because a Worker invocation is
short-lived — but Workflow engine persistence is *outside* Law 2's
plaintext boundary, so content handling is confined to single steps whose
return values are counts/ids (see the dream cycle in
[chapter 4](04-nights-and-weekends.md)).

### The dashboard is static

`public/dashboard.html` ships via Workers Static Assets (asset-first,
`not_found_handling = "none"` pinned so asset paths can never shadow
Worker routes). CF Access gates assets exactly like APIs, so there's no
separate auth story for the UI.

## Why it's built this way

- **One Worker, one DO class** keeps Law 1 auditable — the attack surface
  is a single `fetch` handler you can read in a sitting.
- **Facets over separate Workers** for sub-agents: spawn/cancel/retry are
  in-process calls with DO-grade consistency, not cross-service RPC.
- **Queues + Workflows over "just do it in the request"**: bulk ingestion
  and nightly consolidation can't be allowed to compete with your live
  conversation for the same request budget.
- **Hyperdrive + smart placement over an in-Cloudflare database**: the
  mission evaluated CF-native memory primitives and none satisfied Law 2
  (plaintext-only, no customer keys). Postgres you own, reached privately,
  was the design that kept the zero-knowledge property.

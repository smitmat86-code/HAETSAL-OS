# THE Brain - Full System Walkthrough

*How everything operates around Hindsight to deliver the complete solution*

> See also: [hindsight_walkthrough.md](/C:/Users/matth/Documents/HAETSAL%20OS/docs/hindsight_walkthrough.md) for a deep dive on Hindsight specifically.

---

## System At a Glance

THE Brain is a three-layer personal AI system running on Cloudflare:
Ingestion (data in) -> Brain (Hindsight memory + cognitive engine) -> Agents (intelligence out).
A single Cloudflare Worker is the sole public face. Everything else - Hindsight,
agents, actions, and crons - is internal.

```
You -> SMS / Email / Web UI / Claude
   -> Worker (auth, audit, DLP, routing)
      -> McpAgent DO
      -> Action Queue
      -> Ingestion Queues
         -> Hindsight Container
            -> Neon Postgres
      -> D1 / KV / R2 / Vectorize / Workflows
```

---

## 1. The Worker - Single Entry Point

**File:** [index.ts](/C:/Users/matth/Documents/HAETSAL%20OS/src/workers/mcpagent/index.ts)

The Worker is a Hono app that serves as the only public endpoint. It handles:

| Traffic Type | Handler |
|---|---|
| HTTP requests | Route-matched via Hono middleware chain |
| Queue batches | `brain-actions` -> action executor, all others -> ingestion consumer |
| Cron triggers | Scheduled handlers for briefs, heartbeat, synthesis, and consolidation |

### Route Map

```
/ingest/*          -> SMS webhook
/telegram/webhook  -> Telegram webhook
/hindsight/webhook -> Consolidation webhook
-- CF Access auth boundary --
/auth/*            -> Google OAuth flow
/actions/*         -> Undo API
/api/actions/*     -> Approval queue API
/api/settings/*    -> Tenant preferences
/api/audit/*       -> Audit log API
/mcp               -> MCP Streamable HTTP -> McpAgent DO
/ws                -> WebSocket upgrade -> McpAgent DO
```

---

## 2. Security - Three Layers

### Layer 1: Authentication

**File:** [auth.ts](/C:/Users/matth/Documents/HAETSAL%20OS/src/middleware/auth.ts)

Every request except signed webhook endpoints requires Cloudflare Access auth.
The middleware validates the JWT, derives `tenantId`, and stamps `tenantId`
plus `jwtSub` onto the request context.

### Layer 2: Key Isolation

The Tenant Master Key (TMK) is derived from the authenticated session and held
only in Durable Object memory. Hindsight now receives plaintext through its
official API. HAETSAL still encrypts its own archives, reasoning traces, and
cron-handoff material at rest.

Practical split:

- Hindsight memory writes and recalls: plaintext over internal authenticated service calls
- R2 STONE archive: encrypted at rest
- R2 observability traces: encrypted at rest
- Cron KEK material in KV: encrypted at rest

### Layer 3: DLP

**File:** [dlp.ts](/C:/Users/matth/Documents/HAETSAL%20OS/src/middleware/dlp.ts)

Currently a passthrough stub. The intended role is to inspect MCP payloads and
scrub or transform prompts before they leave the Worker boundary.

### Audit Trail

**File:** [audit.ts](/C:/Users/matth/Documents/HAETSAL%20OS/src/middleware/audit.ts)

Every operation writes metadata to `memory_audit` via `waitUntil()`. Failed auth
attempts are logged too. Audit rows never duplicate full memory bodies.

---

## 3. McpAgent Durable Object

**File:** [McpAgent.ts](/C:/Users/matth/Documents/HAETSAL%20OS/src/workers/mcpagent/do/McpAgent.ts)

Each tenant gets a named DO instance. The DO holds:

- session-scoped TMK material
- MCP tool registrations
- WebSocket connections for UI push
- interview/bootstrap state
- persisted correctness-critical session metadata in private DO storage

On authenticated session start, the DO can prewarm Hindsight in the background
to improve recall latency after idle periods.

---

## 4. The Ingestion Pipeline

### Sources -> Queue -> Retain

```
SMS / Gmail / Calendar / Drive / Obsidian / Pages uploads
  -> ingestion queue
     -> consumer
        -> retainContent()
           -> Hindsight

MCP retain tools / agent close summaries
  -> retainContent()
     -> Hindsight (async=true)
        -> dedicated Hindsight workers
```

### Interactive Async Retain

Interactive tool and agent writes now follow Hindsight's native async model
rather than adding a second HAETSAL queue in front of them.

The write path is:

1. Tool or agent creates an `IngestionArtifact`
2. `retainContent()` performs the canonical write pipeline immediately
3. Hindsight accepts `async=true` retain and returns an operation id
4. Dedicated Hindsight workers process the operation in the background
5. HAETSAL tracks lifecycle state in `hindsight_operations`
6. Later recall and reflect use the completed memory state

This keeps interactive writes aligned with Hindsight best practice while
preserving queue-backed ingestion for external and bulk sources.

### Canonical Retain Pipeline

**File:** [retain.ts](/C:/Users/matth/Documents/HAETSAL%20OS/src/services/ingestion/retain.ts)

The worker-side retain pipeline now looks like:

1. Direct async retain for interactive writes, queue handoff for external ingestion
2. Dedup
3. Write-policy validation
4. Salience scoring
5. Domain inference
6. Encrypted R2 STONE archive
7. Hindsight retain via official API
8. D1 audit/event writes

### Salience Tiers

| Tier | Signal | Queue | Examples |
|---|---|---|---|
| 3 (High) | Decision language, explicit retain, self-SMS | `QUEUE_HIGH` | "I decided to accept the offer" |
| 2 (Notable) | Named entities, meetings, money, most SMS | `QUEUE_HIGH` | "Meeting with Sarah about budget" |
| 1 (Routine) | Low-importance routine facts | `QUEUE_NORMAL` | newsletters, confirmations |

---

## 5. The Action Layer

**File:** [authorization.ts](/C:/Users/matth/Documents/HAETSAL%20OS/src/services/action/authorization.ts)

Every `brain_v1_act_*` tool goes through a traffic-light authorization gate:

| Capability Class | Hard Floor | Example Actions |
|---|---|---|
| `READ` | GREEN | Web search, browse |
| `WRITE_INTERNAL` | GREEN | Draft, reminder creation |
| `WRITE_EXTERNAL_REVERSIBLE` | YELLOW | Calendar create |
| `WRITE_EXTERNAL_IRREVERSIBLE` | RED | Send email, send SMS |

The action layer also applies TOCTOU protection and optional send delays before
external irreversible actions fire.

---

## 6. The Agent Layer

**File:** [base-agent.ts](/C:/Users/matth/Documents/HAETSAL%20OS/src/agents/base-agent.ts)

Each agent follows the same lifecycle:

```
open()
  -> load mental model
  -> recall recent memories
  -> load pending actions

agentLoop(input)
  -> bounded tool use and LLM turns
  -> context guardrails and doom-loop protection

close(synthesis)
  -> queue episodic retain
  -> write encrypted reasoning trace to R2
  -> clear context
```

Agents do not call raw Hindsight endpoints directly. They use shared services:

- `this.retain(...)` -> queues the canonical retain pipeline
- `recallViaService(...)` -> shared Hindsight recall adapter
- `reflectViaService(...)` -> shared Hindsight reflection adapter
- mental model loading -> shared Hindsight client seam

---

## 7. Cron and Background Work

### Morning Brief

Assembles the daily brief from calendar data, pending approvals, Hindsight
recall, consolidation gaps, and news.

### Heartbeat

Runs quietly unless there is something actionable, such as stale approvals or
too many high-priority unsurfaced gaps.

### Weekly Synthesis

**File:** [weekly-synthesis.ts](/C:/Users/matth/Documents/HAETSAL%20OS/src/cron/weekly-synthesis.ts)

Weekly synthesis now uses Hindsight `reflect` rather than "recall then separate
LLM summarization." The result is delivered via Telegram and Obsidian, then
archived back into memory.

### Nightly Consolidation

Consolidation remains background orchestration. Contradictions, bridges,
patterns, and gaps stay in async cron/workflow lanes rather than user-facing
sync requests.

### Bootstrap

**File:** [bootstrap.ts](/C:/Users/matth/Documents/HAETSAL%20OS/src/workflows/bootstrap.ts)

Bootstrap remains a Cloudflare Workflow with durable retry semantics:

1. interview
2. historical import
3. Hindsight bank configuration
4. handoff back to the UI/session

---

## 8. Cloudflare Infrastructure Stack

| Service | Binding | Purpose |
|---|---|---|
| Workers | `default` | Hono app, queue consumers, cron handlers |
| Durable Objects | `MCPAGENT` | Per-tenant sessions, MCP, WebSocket, prewarm trigger |
| Containers | `HINDSIGHT`, `HINDSIGHT_WORKER` | Hindsight API + dedicated workers |
| Neon Postgres | `NEON_CONNECTION_STRING` | Hindsight database |
| D1 | `D1_US` | Actions, audit, tenants, ingestion events, consolidation metadata |
| KV | `KV_SESSIONS` | Session tokens, rate limits, Cron KEK |
| R2 | `R2_ARTIFACTS` | STONE archive, file uploads |
| R2 | `R2_OBSERVABILITY` | Reasoning traces, cold archive |
| Queues | `QUEUE_ACTIONS`, `QUEUE_HIGH`, `QUEUE_NORMAL`, `QUEUE_BULK` | Async durable work |
| Vectorize | `VECTORIZE_MEMORIES` | Semantic retrieval cache |
| AI Gateway | `haetsal-brain-gateway` | LLM routing, cost tracking, caching, fallback |
| Workers AI | `AI` | On-edge fallback and classifiers |
| Workflows | `BOOTSTRAP_WORKFLOW` | Durable bootstrap import |

Hyperdrive is no longer part of the live Hindsight path. The container uses the
direct Neon connection string because Hindsight runs as a long-lived container
process rather than inside the Worker runtime.

---

## 9. The Compounding Intelligence Loop

The compounding loop is:

1. New data enters through ingestion
2. Hindsight stores fresh facts and relationships
3. Background consolidation finds patterns, bridges, contradictions, and gaps
4. Mental models update
5. Agents open with better context
6. Better sessions create better new memories

That is the core flywheel.

---

## 10. What's Built vs. What's Coming

### Built

- authenticated Worker + MCP surface
- Hindsight API-only container on Cloudflare
- dedicated Hindsight worker topology
- Neon-backed memory store
- direct interactive async retain + queued external ingestion
- bootstrap workflow
- nightly consolidation passes
- morning brief, heartbeat, weekly synthesis
- agent framework and first domain agents

### In Progress / Next

- remaining operator cleanup for legacy rollout-era stuck operations
- top-level docs/spec lock-in for the repaired Hindsight path
- future Graphiti lane for temporal and graph-native capabilities

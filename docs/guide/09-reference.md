# 9. Reference

Quick tables. Source of truth is always the code — paths given per table.

## MCP tools (the DO's tool registry)

| Tool | Purpose | Source |
|---|---|---|
| `capture_memory` | Write through the canonical memory contract | `src/tools/canonical-memory.ts` |
| `search_memory` | Query; `mode` = `raw` `lexical` `semantic` `graph` `temporal` `compiled` `composed` | `src/tools/canonical-memory.ts` |
| `brain_v1_retain` / `brain_v1_recall` | Legacy-named retain/recall (canonical-backed) | `src/workers/mcpagent/do/register-tools.ts` |
| `create_automation` / `list_automations` / `toggle_automation` / `delete_automation` | Automation CRUD from chat/MCP | `do/register-automation-tools.ts` |
| `brain_v1_act_*` | Action tools (table below) | `do/register-tools.ts` |

External MCP clients see the scoped brain-memory surface (flat list in
`src/tools/brain-memory-surface.ts`; write/read split in
`src/services/external-client-memory.ts`): **write** = `capture_memory`;
**read** = `search_memory`, `trace_relationship`, `get_entity_timeline`,
`prepare_context_for_agent`, `get_recent_memory_traces`,
`get_memory_trace`, `get_recent_memories`, `get_document`,
`memory_status`, `memory_stats`.

## Action tools × capability class

| Tool | Class | Gate |
|---|---|---|
| `brain_v1_act_search` | READ | GREEN floor — immediate |
| `brain_v1_act_browse` | READ | GREEN floor — immediate (Browser Rendering) |
| `brain_v1_act_draft` | WRITE_INTERNAL | GREEN floor — immediate |
| `brain_v1_act_remind` | WRITE_INTERNAL | GREEN floor — immediate (channels: canonical MessageChannel enum) |
| `brain_v1_act_create_event` | WRITE_EXTERNAL_REVERSIBLE | YELLOW floor — approval |
| `brain_v1_act_modify_event` | WRITE_EXTERNAL_REVERSIBLE | YELLOW floor — approval |
| `brain_v1_act_send_message` | WRITE_EXTERNAL_IRREVERSIBLE | YELLOW floor — draft-first + approval + 120 s send delay |
| `brain_v1_act_run_playbook` | WRITE_EXTERNAL_IRREVERSIBLE | YELLOW floor — draft-first + approval + 120 s send delay |

Definitions: `src/tools/act/*.ts`. Authorization floors + default send
delays: `src/types/action.ts` (a `WRITE_EXTERNAL_FINANCIAL` class is
defined with a 120 s delay; no tool uses it yet). GREEN executes
immediately only at zero send delay; delayed GREEN actions are stored
with `execute_after` for cron pickup (`src/services/action/router.ts`).

## HTTP surface (selected; routing lives in `src/workers/mcpagent/index.ts`)

| Route | What |
|---|---|
| `POST /mcp` | MCP Streamable-HTTP endpoint |
| `GET /dashboard.html` | The dashboard SPA (static asset) |
| `GET/POST /api/agents/runs`, `POST …/{id}/cancel`, `POST …/{id}/retry` | Sub-agent runs |
| `GET/POST /api/automations`, `DELETE …/{id}` | Automations |
| `GET /api/dream/latest`, `POST /api/dream/run` | Dream cycle |
| `POST /api/dream/decay/run` | Manual decay pass |
| `POST /api/dream/canary/run`, `GET /api/dream/canary/latest` | Canaries |
| `POST /api/compiled/{kind}/{key}/rebuild` | Rebuild a compiled page |
| Dashboard feeds | `routes/dashboard-data.ts` (memory search/recent, traces, usage, connections) |
| `POST /telegram/webhook` | Telegram inbound (`public-webhooks.ts`, secret-verified) |
| Ingest webhooks (SMS/Telnyx, Gmail + Calendar when live) | `routes/ingest.ts` |
| Approval, actions, audit, auth, session, settings | `routes/*.ts` by name |

Everything behind Cloudflare Access; headless callers use service-token
headers (`CF-Access-Client-Id` / `CF-Access-Client-Secret`).

## Cron schedule (dispatch: `src/workers/mcpagent/runtime.ts:30`)

| Expression | Handler | Job |
|---|---|---|
| `*/1 * * * *` | `cron/obsidian-poll.ts` | `/to-brain/` folder poll |
| `*/15 * * * *` | `cron/obsidian-poll.ts` + `cron/canary.ts` | Vault `brain: true` scan; canary sweep on the top-of-hour tick |
| `*/30 * * * *` | `cron/heartbeat.ts` | Predictive heartbeat (8am–8pm) |
| `0 2 * * *` | `cron/dream.ts` → `workflows/dream-cycle.ts` | Dream cycle (+ decay) |
| `0 7 * * *` | `cron/morning-brief.ts` | Morning brief |
| `0 17 * * 5` | `cron/weekly-synthesis.ts` | Weekly synthesis |

Automations & session idle-close: per-DO alarms, not platform crons.

## Bindings (`wrangler.toml`)

| Binding | Resource | Role |
|---|---|---|
| `HYPERDRIVE_CANONICAL` | Neon Postgres | **The** plaintext memory store |
| `MCPAGENT` | DO class `McpAgentDO` | Session/agent/automation state |
| `D1_US` (+`D1_EU` stub) | D1 `brain-us` | Metadata (content-free) |
| `KV_SESSION` | KV | Session material, Cron KEK (24 h TTL) |
| `R2_ARTIFACTS` | R2 `brain-artifacts` | Sealed blobs (bodies, traces, payloads, compiled artifacts) |
| `R2_OBSERVABILITY` | R2 `brain-observability` | Ops artifacts |
| `QUEUE_HIGH/NORMAL/BULK` | Queues | Prioritized ingestion/work |
| `QUEUE_ACTIONS` | Queue (batch=1, DLQ) | Action execution |
| `QUEUE_DEAD` | Queue | Dead letters |
| `ANALYTICS` | Analytics Engine | Reserved — zero write sites (ADR #2) |
| `AI` | Workers AI via gateway `haetsal-brain-gateway` | All model + embedding calls |
| `BROWSER` | Browser Rendering | `act_browse` |
| `BOOTSTRAP_WORKFLOW` / `DREAM_WORKFLOW` | Workflows | Bootstrap; nightly dream |
| `ASSETS` | Static assets `./public` | Dashboard |

Public vars: `TELEGRAM_BOT_USERNAME`, `WORKER_DOMAIN`,
`TELNYX_FROM_NUMBER`, `AI_GATEWAY_ID`, `AI_GATEWAY_ACCOUNT_ID`. Secrets
(names only; values via `wrangler secret put`): Telegram/Sendblue/Telnyx/
Brave credentials, and — once provisioned — `GOOGLE_CLIENT_ID` /
`GOOGLE_CLIENT_SECRET`.

## D1 migrations (`migrations/`)

| Range | What |
|---|---|
| 1001–1004 | Tenants, observability, cognitive layer, action layer |
| 1005–1006 | Ingestion; Google (tokens/config) |
| 1007–1008 | Bootstrap; consolidation |
| 1009–1012 | Hindsight ops era (historical; engine retired) |
| 1013 | **Canonical open-brain foundation** |
| 1014, 1018 | Projection adapters (historical) |
| 1021 | Broker primary/shadow traces |
| 1022–1026 | Telegram chats; action drafts; dream runs; compiled pages; memory decay |

Next migration number: **1027**.

## Governance vocabularies (`src/types/canonical-governance.ts`)

- **Memory class**: `raw_source` `episode` `observation` `claim` `fact`
  `preference` `procedure` `compiled_view`
- **Trust state**: `evidence` `inferred` `user_confirmed` `trusted_import`
  `disputed` `stale` `superseded` `rejected`
- **Use policy**: `can_use_as_evidence` `can_use_as_instruction`
  `requires_confirmation` `do_not_inject_automatically`
- **Author kind**: `user` `agent` `cron` `external_client` `system`
- **Retention**: `standard` `ephemeral` `permanent`

## Key numbers

| Constant | Value | Where |
|---|---|---|
| Sub-agent run budget | 15 min | `do/agent-dispatch.ts` |
| Sub-agent no-progress fail | 5 min | same |
| Cancel SLA (demo-verified) | < 5 s (measured 0.4–0.9 s) | Phase 13 demo |
| Session idle close / turn ceiling | 30 min / 40 turns | `session-runtime.ts` |
| Cron KEK TTL / renewal window | 24 h / < 2 h remaining | `services/tenant.ts` |
| Decay half-life / archive / reinforce | 30 d / < 0.15 & > 21 d / ≥ 0.9 or ≥ 2 hits | `services/decay/pass.ts` |
| Decay scoring window | 200 most recent docs per pass | same (follow-up noted) |
| Model retry backoff (agents + chat) | 800 ms, 3200 ms | `execution/tool-loop.ts`, `services/workers-ai-chat.ts` |
| Irreversible-send delay (undo window) | 120 s | `src/types/action.ts` |
| Deploy propagation wait | ~12 s | smoke scripts |
| Source-file line limit (postflight) | 150 | `scripts/postflight-check.ts` |

## Key documents

- `HAETSAL_MISSION.md` — the mission: laws, phases, demo clauses
- `ARCHITECTURE.md` — architecture record
- `SESSION_LOG.md` — append-only build journal
- `docs/lessons/` — deploy memos, runbooks, setup guides, post-mortems
- `docs/lessons/phase-13-ops-runbook.md` — rebuild procedures + ADRs
- `docs/lessons/phase-5-google-oauth-setup.md` — **the one outstanding setup task**

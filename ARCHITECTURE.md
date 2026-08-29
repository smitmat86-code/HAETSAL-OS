# Architecture - HAETSAL OS

> **This document is constitutional law.** Changes require explicit justification
> and agreement with Matt. Day-to-day patterns live in CONVENTIONS.md.
>
> AI: Read this file at the start of every session. It defines the boundaries
> you MUST NOT cross.

---

## Post-Hindsight Migration (mission Phase 3, 2026-07)

The Hindsight engines (API container + dedicated worker containers) were
removed in the mission: write path severed in Phase 1, read path severed in
Phase 2, container classes deleted in Phase 3 (`wrangler.toml` DO migration
v5, `deleted_classes`). Canonical Postgres (Neon), reached through the
`HYPERDRIVE_CANONICAL` binding, is now the only memory substrate. Retrieval
is a 7-mode broker (raw | lexical | semantic | graph | temporal | compiled |
composed) running against canonical tables and pgvector, not a Graphiti
projection. Historical D1 tables (`hindsight_operations`, `hindsight_bank_config`,
`tenants.hindsight_tenant_id`) remain in the schema as inert history - do not
write to them and do not treat their presence as evidence Hindsight is still
live. The dream cycle reads authorized canonical Neon chunks and writes its
governed report through the canonical capture path; compiled wiki pages remain
regenerable projections rather than dream-cycle input. Law 3 (Agents Write
Facts - Crons Write Patterns) is unchanged and governs that work.

---

## The Laws

> These are non-negotiable. Every design decision is evaluated against them.
> If a proposed change violates a law, the change is wrong - not the law.

### Law 1: One Public Face

The Cloudflare Worker (McpAgent) is the **only** public surface of THE Brain.
Canonical Postgres (Neon) is reached exclusively through the `HYPERDRIVE_CANONICAL`
binding, accessed by HAETSAL's canonical DB adapter running inside the Worker.
There are no containers and no separate memory-engine service - the Worker is
both the public face and the sole caller of the canonical database.
No database, no container port, no internal service is ever exposed to the
public internet - directly or indirectly.

This boundary is also the authorization boundary. Everything that crosses
into the system goes through McpAgent's auth gate first.
Publicly, this surface is presented as HAETSAL at
`https://haetsalos.specialdarksystems.com/mcp`; the underlying Worker may
remain named `the-brain` as a legacy internal/runtime identifier.

### Law 2: Key-Isolated Platform

Tenant-derived key material stays scoped to authenticated session work and
HAETSAL-owned storage surfaces. The Tenant Master Key (TMK) is derived from a
WebAuthn passkey assertion and held in Durable Object memory only for the
duration of the authenticated session. Canonical Postgres via Hyperdrive
receives plaintext memory content through HAETSAL's canonical DB adapter
running inside the Worker, while HAETSAL archives, traces, and cron handoff
material stay encrypted at rest with tenant-scoped or cron-scoped keys.

**Corollary:** Cron jobs that need tenant-scoped encrypted artifacts use a
time-bound Cron KEK provisioned during an active session and stored encrypted
in KV. If the Cron KEK has expired, crons queue their work and drain on next
authentication. Crons NEVER bypass tenant key isolation for HAETSAL-owned
encrypted artifacts.

**Corollary:** Vector embeddings are stored in plaintext in Postgres pgvector
(T1, via Hyperdrive) by architectural necessity - cosine similarity math
requires plaintext vectors. Embeddings are not reversible to source text but
represent THE Brain's primary plaintext retrieval surface at the
infrastructure layer. This is documented and accepted. The `VECTORIZE`
binding still exists but is currently unused - the semantic index lives in
pgvector alongside the rest of canonical memory content, not in Vectorize.

### Law 3: Agents Write Facts - Crons Write Patterns

Domain agents (Career Coach, Life Coach, etc.) write **episodic and semantic
memories only** - facts about what happened, what was learned, what was
committed to. They NEVER write `memory_type = procedural`.

Procedural memories (behavioral patterns about the tenant) are the exclusive
output of the offline consolidation cron, which has longitudinal data across
sessions. An agent observing a pattern in one session is noise. The cron
observing it across 20 sessions is signal.

**Enforcement:** The `brain_v1_retain` middleware rejects `memory_type = procedural`
from any `agent_identity` other than `consolidation_cron`. Violations are
logged as anomaly signals. The agent receives a success response (to prevent
doom loops) - the write is silently dropped.

**Corollary:** The Write Policy Validator runs on every `brain_v1_retain` call
from a domain agent. Heuristic pass (no AI cost) catches sweeping language
("always", "never", "tends to", "avoids", "prefers when"). Flagged writes
escalate to Workers AI Llama classifier. Unflagged writes go straight through.

**Corollary - Drift Detection:** The consolidation cron also runs a drift
detection sub-pass within pass 4. This compares explicitly stated intentions
(retained commitments with high user-salience) against actual behavioral
evidence (calendar, captured sessions, content patterns) over a rolling 60-day
window. Output: `anomaly_signals` rows with `signal_type = intention_behavior_drift`.
Surfaced in morning brief when divergence is sustained 21+ days. Accessible
on-demand via `brain_v1_get_drift`. This is distinct from gap discovery (which
finds missing knowledge) - drift detection finds inconsistency between what the
tenant says matters and what their behavior shows.

---

## State Architecture

> Every piece of data in the system lives in exactly ONE tier.
> If you're unsure which tier, you haven't designed the feature yet.

| Tier | Storage | Encrypted? | Purpose |
|------|---------|-----------|---------|
| T1: Memory Content | Neon Postgres via Hyperdrive (canonical schema `haetsal_canonical`) | Partial - plaintext authorized in canonical Postgres, encrypted in HAETSAL-owned sidecars | Knowledge graph, engrams, entity relationships, mental models, chunk_text, claims, messages, recall traces |
| T2: Operational Metadata | Cloudflare D1 | Partial (reasoning traces yes, metadata no) | Audit logs, agent traces, action queue, scheduled tasks, tenant config |
| T3: Ephemeral Session | Durable Objects (McpAgent DO) | TMK in DO memory only | Active session state, WebSocket connections, TMK for session duration |
| T4: Semantic Index | Cloudflare Vectorize (unused/reserved) | Plaintext (required by design) | Currently unused - semantic index lives in pgvector in T1. Binding kept reserved. |
| T5: Artifacts & Archive | Cloudflare R2 | Server-side + tenant-encrypted sidecars | Raw files (PDFs, audio, docs), cold observability archive, encrypted archival bodies |
| T6: Ephemeral Cache | Cloudflare KV | Cron KEK encrypted | Rate limits, session tokens, Cron KEK (time-bound) |
| T7: Aggregate Metrics | Analytics Engine (BRAIN_ANALYTICS) | N/A - metadata only | Aggregate dashboards - never memory content |

**Anti-pattern:** Never store memory content in D1, KV, or Analytics Engine.
These tiers are visible to the platform operator. T1 (Neon via Hyperdrive) is
the primary home for memory content and the sole authorized Law 2 boundary for
plaintext, with encrypted HAETSAL-owned sidecars stored only where explicitly
documented.

---

## Compute Continuum

> Every workload routes to the appropriate tier based on latency and duration.

| Tier | Runtime | Time Limit | Use Case |
|------|---------|-----------|---------|
| C1: Sync Request | Cloudflare Worker | 30s CPU | MCP tool calls, auth, routing, DLP, short agent sessions |
| C2: Durable Object | McpAgent DO | Session duration | Stateful MCP sessions, WebSocket push, TMK holding |
| C3: Fire-and-Forget | Cloudflare Queues | N/A (consumer handles) | SMS routing, external ingestion, session write-back, action dispatch |
| C4: Durable Async | Cloudflare Workflows | No timeout | Bootstrap import, nightly crons, long-running synthesis, full data export |

**The 30-second rule:** Any operation that might exceed 30s MUST use C4
(Cloudflare Workflow) or an async queue handoff. This includes bootstrap import,
full data export, nightly consolidation, gap discovery, and other long-running
background work. MCP tool calls that trigger long operations return a Job ID or
queued acknowledgement immediately - result delivered via primary channel (SMS
or WebSocket push to Pages UI).

---

## Action Layer Authorization

Every agent-proposed action passes through the authorization gate before
execution. The capability class system defines authorization floors.

| Class | Default | Hard Floor | Description |
|-------|---------|-----------|-------------|
| READ | GREEN | GREEN (fixed) | Memory reads, calendar reads, web search |
| WRITE_INTERNAL | GREEN | GREEN (fixed) | brain_v1_retain, session synthesis |
| WRITE_EXTERNAL_REVERSIBLE | YELLOW | Upgradable to GREEN | Calendar create, draft creation |
| WRITE_EXTERNAL_IRREVERSIBLE | YELLOW | YELLOW (floor) | Send email, send SMS |
| WRITE_EXTERNAL_FINANCIAL | RED | RED (fixed) | Anything touching money |
| DELETE | RED | RED (fixed) | Any deletion anywhere |

**Hard floors are code-enforced in the Action Worker, not prompt-enforced.**
FINANCIAL and DELETE are always RED. IRREVERSIBLE is always at minimum YELLOW.

**TOCTOU protection:** Every pending action stores a SHA-256 hash of its
payload at proposal time. The Action Worker re-hashes at execution and
rejects any mismatch as a critical security anomaly.

**Send delay:** WRITE_EXTERNAL_IRREVERSIBLE actions have a configurable delay
(default 120s) before execution. User notified immediately; can cancel via
SMS "CANCEL" or Pages UI during the window.

---

## AI Integration

All LLM traffic routes through AI Gateway (`haetsal-brain-gateway`).

```
McpAgent -> haetsal-brain-gateway -> Workers AI (primary tier, this mission)
                                 -> Cache layer (semantic caching enabled)
```

Workers AI is the primary tier for this mission - there is no BYOK
(bring-your-own-key external provider) path active. Embeddings are generated
via `@cf/baai/bge-base-en-v1.5` through AI Gateway and stored in Postgres
pgvector (T1), not Vectorize.

AI Gateway sits **after** the DLP scrubbing layer. It sees scrubbed/transformed
prompts only - never raw memory content unless an explicit prompt path requires
it and the calling code allows it. Any AI Gateway call that carries or could
carry content-bearing prompts MUST set `collectLog: false` - this is a
discipline, not a default, and applies whether the call is embeddings,
chat completion, or classification.

**AI cost ceiling enforcement:**
- Warning (80% daily): anomaly signal + morning brief mention
- Degraded (100% daily): suspend external AI, continue ingestion via Workers AI
- Hard stop (150% daily): suspend all except cache recall, require reset
- Workers AI is exempt - flat cost, not variable

---

## Security Stack

### Structural Guarantees (automatic - specs do not re-specify)

| Guarantee | Enforcement |
|-----------|-------------|
| Authentication | CF Access + deny-by-default Hono middleware on every route |
| Rate limiting | Cloudflare edge - not in application code |
| Tenant isolation | `tenant_id` on every tenant-scoped table + postflight check |
| SQL parameterization | All queries use `.bind()` - no string interpolation |
| Prompt injection defense | Firewall for AI on all ingestion paths - structural |
| TLS | Cloudflare enforces TLS 1.3 - not in application code |

### Behavioral Wiring (explicit - specs MUST specify)

| Wiring | What specs must declare |
|--------|------------------------|
| Agent identity | Which `agent_identity` string the agent uses in audit records |
| Capability class | For every `brain_v1_act_*` call: which class, which floor |
| Audit entries | Which events write to audit tables, blocking or waitUntil |
| Queue routing | Which queue, payload schema, consumer |
| Memory type | Which `memory_type` the agent is allowed to write |
| Cron KEK dependency | If spec touches crons: confirm Cron KEK flow is handled |

---

## Platform Bindings

| Binding | Type | Purpose |
|---------|------|---------|
| `HYPERDRIVE_CANONICAL` | Hyperdrive | Pooled connection to canonical Neon Postgres - the memory substrate, reached only by the Worker's canonical DB adapter |
| `NEON_CONNECTION_STRING` | Secret | Legacy - direct Postgres connection used by the removed Hindsight container. Phase 13 retirement candidate. Not used by the canonical DB adapter. |
| `D1_US` | D1 Database | Operational metadata, audit, action queue |
| `R2_ARTIFACTS` | R2 Bucket | Raw uploaded files, provenance |
| `R2_OBSERVABILITY` | R2 Bucket | Cold archive, Logpush, export zips |
| `KV_SESSION` | KV Namespace | Session tokens, Cron KEK, rate limits |
| `VECTORIZE` | Vectorize Index | Currently unused - semantic index lives in pgvector (T1) instead |
| `QUEUE_HIGH` | Queue | SMS/voice/Tier3 - 30s SLA |
| `QUEUE_NORMAL` | Queue | Gmail/Calendar - 5min SLA |
| `QUEUE_BULK` | Queue | Bootstrap/Drive - best effort |
| `QUEUE_DEAD` | Queue | Dead letter - 7-day retention |
| `QUEUE_ACTIONS` | Queue | Pending action execution |
| `ANALYTICS` | Analytics Engine | BRAIN_ANALYTICS dataset |
| `BROWSER` | Browser Rendering | CDP proxy for brain_v1_act_browse |
| `AI_GATEWAY` | AI Gateway | haetsal-brain-gateway - all LLM calls |
| `D1_EU` | D1 Database | Stubbed - EU tenant jurisdiction |
| `R2_EU` | R2 Bucket | Stubbed - EU tenant jurisdiction |

**Note:** There is no `GRAPHITI` binding. Graphiti projection was a candidate
engine considered during Phase 8 design work; it was never provisioned and
is not part of the current retrieval broker.

---

## Obsidian Integration Boundary

Obsidian is a capture surface and output surface - not a live mirror of the
knowledge graph. Google Drive sync is the bridge. No local process required.

**Tenant-controlled ingestion (Obsidian -> Brain):**
- Notes in `/to-brain/` Drive folder, OR notes with `brain: true` YAML frontmatter
- Everything else in the vault is untouched - tenant decides what crosses
- Salience scorer tiers all ingested content (a grocery list ingests at Tier 1,
  not excluded - behavioral patterns live in mundane data too)
- Obsidian-specific extraction pass parses `[[wikilinks]]` as explicit relationship
  declarations -> canonical edges with `provenance = obsidian_link`
  (stronger signal than co-occurrence - the user made the connection intentionally)

**Brain outputs to Obsidian (`/from-brain/` Drive folder):**
- Morning brief, mental model snapshots, evergreen notes, SMS captures as markdown
- All output notes carry `generated_by: the-brain` YAML frontmatter
- Read-only artifacts - editing them does not write back to the graph

**Anti-pattern:** Do not ingest `/from-brain/` notes. They are outputs.
Ingesting them creates circular references. The ingestion pipeline must
filter notes where `generated_by: the-brain` frontmatter is present.

---

## Multi-Tenancy

Every tenant-scoped table includes `tenant_id`. Enforced by:
1. Schema design - column on every tenant-scoped table
2. Postflight check - classifies every table as tenant-scoped or exempt
3. Auth middleware - stamps `tenant_id` from CF Access verified token

`tenant_id` is NEVER trusted from client input. Always derived from
the authenticated session.

`data_region` column on `tenants` table determines which regional bindings
the routing middleware selects. Day 1: always `us`. EU support is a named
binding stub - routing logic exists before EU is instantiated.

---

## Authoritative Sources

When in doubt, these are the sources of truth (in priority order):

1. **The actual code on disk** - not specs, not prior conversation, not memory
2. **ARCHITECTURE.md** - immutable constraints (this file)
3. **CONVENTIONS.md** - evolving patterns
4. **LESSONS.md** - bug prevention
5. **THE_BRAIN_ARCHITECTURE.md** - the full system design (reference, not law)

Specs are instructions for what to build. The code IS what was built.
When they conflict, the code is right and the spec needs an As-Built update.

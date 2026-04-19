# Conventions — THE Brain

> **This document evolves.** Add patterns as you discover them.
> ARCHITECTURE.md is constitutional law (rarely changes).
> This file is case law (grows with each decision).
>
> AI: Read this file after ARCHITECTURE.md and MANIFEST.md.

---

## File Size Limits

> Small files = AI comprehension. Large files = AI hallucination.

| File Type | Extension | Max Lines | Rationale |
|-----------|-----------|-----------|-----------|
| Worker Route Handler | `.ts` | 80 | Thin transport adapter — parse, call service, respond |
| Service / Business Logic | `.ts` | 150 | One concern per file |
| Agent Class | `.ts` | 200 | BaseAgent + domain logic — extract helpers if longer |
| Hono Middleware | `.ts` | 100 | Single middleware concern |
| Type Definitions | `.ts` | 200 | Type files are inherently larger — accepted |
| Test File | `.test.ts` | 400 | Test setup is verbose |
| Migration File | `.sql` | 150 | Split large migrations into sequential files |

**Enforcement:** `npm run postflight` — automated check at session checkout.

**When a file exceeds limits:** Split it. If a file genuinely cannot be
split, add to `FILE_SIZE_ACCEPTED` in `postflight-check.ts` with justification.

---

## Naming Conventions

| Thing | Convention | Example |
|-------|-----------|---------|
| Files (TS) | `kebab-case.ts` | `auth-middleware.ts` |
| Types / Interfaces | `PascalCase` | `TenantActionPreference` |
| Functions | `camelCase` | `resolveAgentIdentity` |
| Constants | `SCREAMING_SNAKE` | `MAX_RETRY_COUNT` |
| DB Tables | `snake_case` (plural) | `pending_actions` |
| DB Columns | `snake_case` | `created_at`, `tenant_id` |
| Agent identity strings | `snake_case` | `career_coach`, `consolidation_cron` |
| MCP tool names | `brain_v{N}_{verb}` | `brain_v1_retain`, `brain_v1_act_browse` |
| Queue names | `descriptive-kebab` | `priority-high`, `action-queue` |
| Environment Variables | `SCREAMING_SNAKE` | `HINDSIGHT_SERVICE_URL` |
| Memory types | `snake_case` | `episodic`, `semantic`, `procedural`, `world` |
| Capability classes | `SCREAMING_SNAKE` | `WRITE_EXTERNAL_IRREVERSIBLE` |

---

## Worker / Hono Patterns

All Workers use **Hono** as the routing framework.

```typescript
// Standard Worker pattern — every Worker follows this shape
import { Hono } from 'hono'
import { authMiddleware } from './middleware/auth'
import { auditMiddleware } from './middleware/audit'
import { dlpMiddleware } from './middleware/dlp'

const app = new Hono<{ Bindings: Env }>()

// Structural guarantees — always first, always present
app.use('*', authMiddleware)
app.use('*', auditMiddleware)
app.use('/mcp/*', dlpMiddleware)  // DLP on all MCP routes

// Route handlers are thin
app.post('/api/action/approve', async (c) => {
  const body = await c.req.json()
  const result = await approveAction(body.actionId, c.env, c.get('tenantId'))
  return c.json(result)
})

export default app
```

**Route handlers are thin.** Parse input → call service function → format
response. No business logic in handlers. If a handler exceeds 20 lines,
extract to a service.

---

## Service Layer

Every service exposes a **programmatic API** (function calls, not HTTP).
Agents call service functions directly — they never make HTTP requests to
themselves.

```typescript
// Service function signature — no Request/Response in parameters
export async function approveAction(
  actionId: string,
  env: Env,
  tenantId: string
): Promise<ActionApprovalResult>

// Route handler calls service
app.post('/api/action/approve', async (c) => {
  const { actionId } = await c.req.json()
  return c.json(await approveAction(actionId, c.env, c.get('tenantId')))
})
```

---

## Agent Patterns

### BaseAgent structure

Every domain agent inherits BaseAgent. Subclass provides:
- `systemPrompt: string`
- `domain: string`
- `run(input: AgentInput): Promise<AgentOutput>`

BaseAgent handles: TMK loading, procedural memory load at open(), doom loop
detection, context budget monitoring, audit hooks, session synthesis at close().

### Agent identity

Every agent declares its identity in the constructor. This string appears
in every audit record, memory write, and action proposal.

```typescript
// Identity strings are canonical — use these exactly
export const AGENT_IDENTITIES = {
  CAREER_COACH: 'career_coach',
  LIFE_COACH: 'life_coach',
  CHIEF_OF_STAFF: 'chief_of_staff',
  FITNESS_COACH: 'fitness_coach',
  CONSOLIDATION_CRON: 'consolidation_cron',
  GAP_DISCOVERY_CRON: 'gap_discovery_cron',
  ACTION_WORKER: 'action_worker',
} as const
```

### Memory write constraints

Agents call `brain_v1_retain` with allowed memory types only:

```typescript
// Allowed for domain agents
type AgentWritableMemoryType = 'episodic' | 'semantic' | 'world'

// NEVER write this from an agent — consolidation_cron only
type CronOnlyMemoryType = 'procedural'
```

The middleware enforces this structurally. But agents should not even attempt
procedural writes — the write policy validator adds latency to flagged calls.

---

## Encryption Patterns

### Content field encryption

All memory content fields encrypted before Neon write:

```typescript
// Always use the tenant's session DEK, never raw TMK
const encrypted = await encrypt(content, sessionContext.domainDEK)
// Store: { ciphertext, iv, tag } — never plaintext
```

### Projection payload staging

Queue messages and D1 projection rows carry identifiers and engine references
only. If a projection adapter needs the canonical body after acceptance,
materialize an engine-specific payload in R2 under a deterministic key and
encrypt it with the tenant KEK before queue dispatch. Do not copy raw body
content into queue payloads, D1, KV, or audit rows.

### Audit records

Audit records store metadata only — never plaintext content.
If reasoning trace is needed, encrypt it with the tenant's key and store
the ciphertext with a link to the audit record ID.

```typescript
// NEVER in audit records:
// { content: "Matt's health concern is..." }

// CORRECT:
// { memory_id: "mem_abc", operation: "recall", agent_identity: "career_coach" }
```

---

## Action Layer Patterns

### Proposing an action

```typescript
// All action proposals go through the authorization gate
await proposeAction({
  tenantId,
  proposedBy: AGENT_IDENTITIES.CAREER_COACH,
  capabilityClass: 'WRITE_EXTERNAL_IRREVERSIBLE',
  integration: 'gmail',
  actionType: 'send_email',
  payload: encryptedPayload,    // always encrypted
  payloadHash: sha256(plaintext), // TOCTOU protection
})
// Returns: { actionId, status: 'pending' | 'queued' | 'rejected' }
```

### Action Worker execution

Action Worker only reads from `QUEUE_ACTIONS`. It has no direct MCP surface.

```typescript
// Action Worker MUST verify hash before executing
const stored = await getAction(actionId, env)
const currentHash = await sha256(decrypt(stored.payload, env.TMK))
if (currentHash !== stored.payloadHash) {
  await logSecurityAnomaly('toctou_violation', actionId, env)
  return // never execute
}
```

---

## Async Patterns (Queue vs. Workflow vs. Sync)

> Decision tree for every new operation:

1. **Can it complete in <5 seconds?** → Sync Worker request
2. **Is it fire-and-forget with one step?** → Queue (C3)
3. **Does it have multiple steps, need retry, or might take >30s?** → Workflow (C4)
4. **Does it need Postgres?** → Must go through Container (service binding)

**The 30-second rule is absolute.** MCP tool calls that trigger long operations
(STONE, bootstrap, export) return a Job ID immediately and deliver results
via primary channel. Never block a synchronous MCP response.

---

## Database Patterns

### Parameterization (Law 3)

```typescript
// CORRECT — always .bind()
const result = await env.D1_US.prepare(
  'SELECT * FROM pending_actions WHERE tenant_id = ? AND state = ?'
).bind(tenantId, 'awaiting_approval').all()

// NEVER — string interpolation
const query = `SELECT * FROM pending_actions WHERE tenant_id = '${tenantId}'`
```

### Atomic audit writes

Audit log writes are atomic with the operation they record.

```typescript
// CORRECT — same D1 batch
await env.D1_US.batch([
  db.prepare('UPDATE pending_actions SET state = ? WHERE id = ?').bind('approved', actionId),
  db.prepare('INSERT INTO memory_audit ...').bind(...auditFields),
])
// If audit write fails, operation fails. No silent mutations.

// NEVER — sequential writes
await updateAction(actionId)
await writeAudit(actionId) // could fail silently
```

### Migration naming

```
Hindsight migrations: managed by Hindsight, never touch
  0001_hindsight_*.sql

Brain additions: always additive, 1001+ prefix
  1001_brain_tenants.sql
  1002_brain_audit.sql
  1003_brain_security.sql
  1004_brain_action_layer.sql
  1005_brain_observability.sql
```

---

## Audit Action Vocabulary

> Standardized. Never invent ad hoc action strings.
> Add new categories here as you build new features.

| Category | Prefix | Examples |
|----------|--------|---------|
| Authentication | `auth.*` | `auth.session_opened`, `auth.session_closed`, `auth.permission_denied` |
| Memory operations | `memory.*` | `memory.retained`, `memory.recalled`, `memory.reflected`, `memory.deleted` |
| Action layer | `action.*` | `action.proposed`, `action.approved`, `action.rejected`, `action.executed`, `action.expired`, `action.cancelled` |
| Authorization | `authz.*` | `authz.level_changed`, `authz.hard_floor_attempt`, `authz.toctou_violation` |
| Cron operations | `cron.*` | `cron.consolidation_started`, `cron.consolidation_completed`, `cron.kek_provisioned`, `cron.kek_expired` |
| Ingestion | `ingest.*` | `ingest.received`, `ingest.tiered`, `ingest.extracted`, `ingest.deduplicated` |
| Export / access | `data.*` | `data.export_requested`, `data.presigned_url_generated`, `data.file_retrieved` |
| Security anomalies | `security.*` | `security.write_policy_violation`, `security.toctou_violation`, `security.authz_escalation` |
| AI calls | `ai.*` | `ai.provider_call`, `ai.fallback_triggered`, `ai.cost_ceiling_warning`, `ai.cost_ceiling_degraded` |

---

## Observability Retention Policy

| Table | Hot Storage | Cold Storage | Notes |
|-------|------------|-------------|-------|
| `memory_audit` | 90 days (D1) | 7 years (R2) | Personal record |
| `action_audit` | 90 days (D1) | 7 years (R2) | Action record = personal record |
| `agent_traces` | 30 days (D1) | 1 year (R2) | Reasoning trace encrypted |
| `agent_cost_summary` | 90 days (D1) | 1 year (R2) | |
| `ingestion_events` | 30 days (D1) | 1 year (R2) | |
| `cron_executions` | 90 days (D1) | 2 years (R2) | |
| `pending_actions` | 90 days (D1) | 1 year (R2) | Resolved actions |
| `anomaly_signals` | 90 days (D1) | 1 year (R2) | |
| `graph_health_snapshots` | 1 year (D1) | 5 years (R2) | |
| `mental_model_history` | All versions (D1) | Permanent (R2) | |
| `predictions` | All (D1) | Permanent (R2) | Accuracy record |

**Archival pattern:** Nightly cron, keyset pagination, write NDJSON to
`R2_OBSERVABILITY/archive/{table}/{YYYY-MM-DD}.ndjson`, delete from D1
only after confirmed R2 write.

---

## Anti-Patterns (Never Do This)

| Anti-Pattern | Why |
|-------------|-----|
| Calling Hindsight from outside the Worker via service binding | Law 1 |
| Storing memory content in D1, KV, or Analytics Engine | Law 2 |
| Writing `memory_type = procedural` from a domain agent | Law 3 |
| Calling an AI provider directly (not via AI Gateway) | All LLM traffic through haetsal-brain-gateway |
| Returning plaintext memory content in an audit record | Platform operator blindness |
| Blocking a sync MCP tool call with a >30s operation | 30-second rule |
| Running STONE re-extraction synchronously | Use Workflow + Job ID pattern |
| Trusting `tenant_id` from client input | Always derive from CF Access token |
| Sequential writes for logically paired operations | Use D1 batch |
| Business logic in route handlers | Extract to service layer |
| Rate limiting in application code | Edge/CDN only |
| String interpolation in SQL | Law 3 — always `.bind()` |
| Modifying Hindsight's migration files | Brain additions use 1001+ prefix, separate files |
| Writing `agent_identity = action_worker` from a domain agent | Action Worker has isolated identity |
| Running `wrangler pages deploy` from project root | Functions are discovered relative to CWD — always `cd pages && wrangler pages deploy dist` |
| Forwarding `CF-Access-Jwt-Assertion` through a CF Access bypass | CF Access strips it — use `X-Forwarded-Access-Jwt` custom header |

---

## Pages Proxy Pattern

The Pages Function proxy at `pages/functions/api/[[catchall]].ts` forwards all
`/api/*` requests from the SPA to the Worker. Key requirements:

1. **CWD for deploy:** `cd pages && wrangler pages deploy dist --project-name haetsal`
2. **Header forwarding:** Clone all headers into new `Headers()`, skip hop-by-hop (`host`, `connection`, etc.)
3. **JWT forwarding:** Copy `cf-access-jwt-assertion` → `X-Forwarded-Access-Jwt` (CF Access strips the original on bypass)
4. **Worker auth:** Read from `CF-Access-Jwt-Assertion || X-Forwarded-Access-Jwt`
5. **Redirect handling:** `redirect: 'manual'` — don't follow CF Access redirects
6. **WORKER_URL secret:** Set via `wrangler pages secret put WORKER_URL --project-name haetsal`

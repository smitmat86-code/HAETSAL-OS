# Spec: [Name]

**Phase:** [1–5] | **Session:** [N.N] | **Priority:** [P0/P1/P2]
**Prior Art:** [files/lines to check for prior implementations, or "None — net new"]
**Fixture Data:** [which fixture files this spec consumes and what output it must produce.
Required for every spec. If truly none: "None — infrastructure only"]
**Depends on:** [prior sessions this spec directly calls into. List specific
files/functions consumed, not just session numbers. e.g., "1.2: authMiddleware(),
auditBatch(), TenantContext"]

---

## What We're Building

[2–4 sentences. What does this module do? What problem does it solve?
What is the user or agent experience when this is working correctly?]

---

## THE Brain Laws Check

> This section is MANDATORY. Confirm all three laws before implementation begins.

### Law 1: One Public Face
[Does this spec add any new public surface? If yes, confirm it goes through McpAgent/Worker.
If this spec touches Hindsight access, confirm service binding is the only path.]

### Law 2: Zero-Knowledge
[Does this spec read or write memory content? If yes:
- Which encryption key is used (TMK / domain DEK / Cron KEK)?
- Is Cron KEK availability checked before any cron memory access?
- Confirm no memory content lands in D1, KV, or Analytics Engine.]

### Law 3: Agent Write Policy
[Does this spec involve an agent writing to memory? If yes:
- Which memory types does the agent write? (Allowed: episodic | semantic | world)
- Confirm procedural writes are only from consolidation_cron.
- Is the write policy validator (heuristic + classifier) in the path?]

---

## Behavioral Wiring

> This section is MANDATORY and cannot be left blank.
> Structural guarantees (auth, rate limiting, migrations, TLS) do NOT belong here.
> See CONVENTIONS.md §Structural Guarantees for what is automatic.

### Authorization
[For every route or entry point this spec adds:

| Route / Entry Point | Auth Level | Tenant ID Source | When Checked |
|---------------------|-----------|-----------------|-------------|
| POST /api/... | CF Access session | c.get('tenantId') | Auth middleware (automatic) |

If a route is intentionally public, state that explicitly with justification.]

### Action Layer (if applicable)
[If this spec introduces any brain_v1_act_* tools:

| Tool | Capability Class | Hard Floor | Send Delay | TOCTOU? |
|------|-----------------|-----------|-----------|---------|
| brain_v1_act_... | WRITE_EXTERNAL_... | YELLOW | 120s default | Yes |

If no action tools: state "No action tools in this spec."]

### Audit
[Which events write to audit tables.

| Event | Table | Action String | Blocking? |
|-------|-------|-------------|-----------|
| [what happened] | memory_audit / action_audit | [vocab.action] | Atomic batch / waitUntil |

Every state-mutating operation and every security event must have an audit entry.
Audit writes must be atomic with their operation (same D1 batch).]

### Compute Routing
[For every async operation this spec introduces:

| Operation | Tier | Rationale |
|-----------|------|-----------|
| [operation] | Queue C3 / Workflow C4 | [why this tier] |

If a spec triggers a >30s operation from a sync MCP call, specify the
Job ID return + async delivery pattern explicitly.]

### Other Behavioral Wiring
[Other explicit calls to prior-phase infrastructure:
- Agent identity: which agent_identity string(s) used
- Queue publishing: which queue, payload schema
- Cron KEK: if cron touches memory, confirm KEK check is in path
- Memory type constraints: which types are written and why each is allowed
- Analytics Engine: which dataset written, what fields (metadata only, never content)

If none: state "No additional behavioral wiring required."]

---

## Acceptance Criteria

- [ ] [Specific, testable criterion — behavior, not implementation]
- [ ] [Specific, testable criterion]
- [ ] [Fixture data: specific input → specific expected output value]
- [ ] Law 1: No new public surface bypasses McpAgent/Worker auth gate
- [ ] Law 2: No memory content in D1, KV, or Analytics Engine; Cron KEK checked
- [ ] Law 3: No procedural writes from domain agents; write policy validator in path
- [ ] All audit writes are atomic with their operations
- [ ] Action tools: TOCTOU hash verified before execution
- [ ] Service-layer integration test passes with fixture assertions
- [ ] All files within line limits
- [ ] MANIFEST.md updated via `npm run manifest`

---

## Part 1: File Structure

```
src/
├── workers/
│   └── [worker-name]/
│       ├── index.ts        (~N lines) ← Hono app + route registrations
│       ├── routes/
│       │   └── [route].ts  (~N lines) ← Thin handler: parse → service → respond
│       └── services/
│           └── [service].ts (~N lines) ← Business logic + agent-callable API
├── agents/
│   └── [agent-name].ts     (~N lines) ← BaseAgent subclass
├── middleware/
│   └── [middleware].ts     (~N lines) ← Single middleware concern
└── types/
    └── [types].ts          (~N lines) ← Shared type contracts

migrations/
└── 100N_brain_[name].sql   (~N lines) ← Additive Brain migration (1001+ prefix)

tests/
└── [spec-name].test.ts     (~N lines) ← Integration test with fixture assertions
```

[Every file must have an estimated line count. If any file exceeds its limit,
split the work before starting.]

---

## Part 2: Schema / Migration

[If this spec adds or modifies database tables:
- Migration filename: `100N_brain_[descriptive_name].sql` (1001+ prefix)
- Every tenant-scoped table includes `tenant_id TEXT NOT NULL`
- All content fields that hold memory content: note encryption requirement
- Include any indexes required for query patterns in this spec
- Confirm: does this migration run on Neon (via Hindsight) or D1?]

---

## Part 3: Types

```typescript
// All types shared between Worker and agents live in src/types/
// No Request/Response in service function parameters

export interface [TypeName] {
  tenantId: string  // always present on tenant-scoped types
  // ...
}
```

---

## Part 4: Core Logic

[Service functions, agent logic, encryption/decryption patterns.
Each service function must show:
1. Function signature (no HTTP types)
2. Key business logic
3. Audit write (atomic with operation)
4. Error handling]

---

## Part 5: API / Route Layer

[Hono route handlers — thin only.
Pattern: parse input → call service → return c.json(result)
Middleware chain: authMiddleware → auditMiddleware → [dlpMiddleware if MCP] → handler]

---

## Part 6: Agent-Callable API

[Required for every service. Every service exposes a programmatic API
callable by agents without HTTP awareness.

```typescript
// Direct function — no Request/Response in parameters
export async function [verbNoun](
  input: InputType,
  env: Env,
  tenantId: string
): Promise<OutputType>
```

Agents call these functions directly from within their run() method.
They never make HTTP requests to themselves.]

---

## Integration Tests

### `tests/[spec-name].test.ts`

[Every spec requires at least one integration test with fixture assertions.
Tests run against real Cloudflare Worker bindings — not mocks.

Required test coverage:
- Happy path with fixture data (specific expected values, not "returns something")
- Zero-knowledge: confirm content is encrypted in storage, not plaintext
- Authorization: confirm tenant isolation (tenant A cannot access tenant B data)
- Law 3 (if applicable): confirm procedural write is rejected from domain agent
- Action layer (if applicable): confirm TOCTOU hash verification works
- Any error cases in acceptance criteria

Key assertion pattern:
```typescript
// Not: "the function returned something"
// Yes: "the function returned this specific value from fixture data"
expect(result.memoryType).toBe('episodic')
expect(result.contentEncrypted).not.toBe(plaintextContent) // Zero-knowledge check
```]

---

## Lessons Applied

| Lesson (from LESSONS.md) | Where Applied in This Spec |
|--------------------------|---------------------------|
| [Lesson text] | [File/function where the fix lives] |

[If no lessons are relevant: "No directly applicable lessons.
New lessons discovered during this session should be added to LESSONS.md."]

---

## As-Built Record

> Completed AFTER implementation, BEFORE marking spec done.
> Future specs that `Depends on` this one MUST read this section.

### Deviations from Spec
| # | Specified | Actually Built | Why |
|---|-----------|---------------|-----|
| 1 | [what the spec said] | [what was implemented] | [reason] |

### Discovered Constraints
[Runtime discoveries, platform behaviors, or integration surprises not
anticipated by the spec. Feed forward into LESSONS.md.]

### File Inventory (Actual)
[Actual files created/modified vs. Part 1 estimate. Include actual line counts.]

---

## Constraints

### File Size Limits
| File | Max Lines |
|------|-----------|
| [file.ts] | [N] |

### Must Use
- Hono for all Worker routing — per CONVENTIONS.md
- `.bind()` for all D1 queries — Law 3
- Atomic D1 batch for all (operation + audit) pairs
- `brain-gateway` AI Gateway for all LLM calls
- `agent_identity` string from CONVENTIONS.md canonical list
- Brain migration prefix 1001+ for all new tables

### Must NOT
- Write memory content to D1, KV, or Analytics Engine — Law 2
- Write `memory_type = procedural` from domain agents — Law 3
- Block sync MCP calls with >30s operations — 30-second rule
- Include Request/Response in service function signatures
- Trust `tenant_id` from client input — always from CF Access token
- Call AI providers directly — all through AI Gateway

---

## Out of Scope

[What this spec explicitly does NOT cover. Format:
"- [Feature]: [one sentence why deferred] — Phase [N.N] / Session [N.N]"

This prevents scope creep and gives the AI clear stop points.]

---

## Pre-Finalization Checklist

> MANDATORY before marking any spec COMPLETE.

### THE Brain Laws
- [ ] Law 1: No new public surface bypasses McpAgent auth gate — confirmed
- [ ] Law 2: All memory content fields encrypted before write; no content in D1/KV/Analytics
- [ ] Law 2: Cron KEK check confirmed in any cron that reads memory
- [ ] Law 3: No procedural writes from domain agents; write policy validator present

### Atomicity
- [ ] Every function writing to >1 table uses D1 batch
- [ ] No sequential writes for logically paired operations
- [ ] `action_audit` write is atomic with `pending_actions` state update

### Action Layer (if applicable)
- [ ] TOCTOU hash stored at proposal time
- [ ] TOCTOU hash verified at execution time
- [ ] Send delay implemented for IRREVERSIBLE class
- [ ] Automatic episodic memory written on successful execution
- [ ] Hard floor respected — cannot be lowered by tenant preferences

### Access Control
- [ ] Tenant isolation confirmed — no cross-tenant data access possible
- [ ] Agent identity constrained — action_worker only accepts from queue, never MCP

### SQL Validity
- [ ] No dynamic `IN ()` with empty array
- [ ] All SQL uses parameterized queries
- [ ] Every tenant-scoped table has `tenant_id` column

### Type Safety
- [ ] No `: any` in production code
- [ ] Service function signatures have no HTTP types (no Request/Response)
- [ ] Agent-callable API matches service function implementation exactly

### Cross-Section Consistency
- [ ] Acceptance criteria has at least one checkbox per route in Behavioral Wiring
- [ ] Fixture assertions reference specific expected values
- [ ] As-Built record completed

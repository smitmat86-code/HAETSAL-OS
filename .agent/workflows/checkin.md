---
description: Run the full check-in protocol before starting any work on a spec or session
---

# Check-In Protocol

Run every step in order before writing any code.

## Step 1: Context Loading

Read these files IN ORDER:

1. `MANIFEST.md` — current module registry, binding status, known issues
2. `SESSION_LOG.md` — last 3 entries (what changed recently, decisions made)
3. `LESSONS.md` — section relevant to your current work area
4. Your active spec (the spec you're about to implement)
5. `ARCHITECTURE.md` — if touching security, encryption, action layer, or memory

## Step 2: Design Pre-Flight

Before writing ANY code, answer these 9 questions. If you cannot answer one confidently, STOP and ask Matt.

### Law Check
Does this change violate any of the three Laws?
- **One Public Face** — only McpAgent Worker exposes public routes
- **Zero-Knowledge** — memory content lives in T1 (Neon via Hindsight) only, never D1/KV/Analytics
- **Agents Write Facts** — agents write episodic/semantic/world only, never procedural

If yes → STOP and explain the conflict.

### State Tier
Which tier does the data belong to?
- Memory content → T1 (Neon via Hindsight)
- Operational metadata → T2 (D1)
- Session/ephemeral → T3 (KV)
- Artifacts → T4 (R2)
- Never put content in the wrong tier.

### Compute Tier
Where does this computation run?
- Sync and fast (<30s) → Worker (C1)
- One-step fire-and-forget → Queue (C3)
- >30s or multi-step → Workflow (C4)
- Heavy math → Container (C5)

### Encryption
Does this touch memory content?
- If yes: encrypt before write, decrypt with tenant TMK after read
- If this is a cron: is the Cron KEK available? If not, defer — never bypass.

### Agent Identity
If this involves an agent action:
- Which `agent_identity` string?
- Is the memory type allowed for that identity?
- Domain agents: episodic/semantic/world only — never procedural

### Authorization Gate
If this is an action:
- Which capability class?
- Is the hard floor respected?
- Is TOCTOU hash protection implemented?

### Audit Chain
Does this mutate state or touch security?
- If yes: audit write must be atomic with the operation (same D1 batch)
- Plaintext NEVER in audit records

### Service Layer
- Is business logic in a service function (not a route handler)?
- Does the service expose an agent-callable API (no Request/Response params)?

### Hono Pattern
- Is the Worker using Hono with middleware chain?
- Auth → Audit → DLP (on MCP routes) → route handler

## Step 3: Confirm

Before proceeding to implementation, confirm:
- [ ] All context files read
- [ ] All 9 pre-flight questions answered (or marked N/A with justification)
- [ ] No Law violations detected
- [ ] Spec As-Built section from prior specs reviewed (if `Depends on` any)

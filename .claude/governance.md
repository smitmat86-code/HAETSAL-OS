# AI Agent Governance Rules — THE Brain

> These rules define how AI coding assistants interact with this codebase.
> All AI agents MUST follow this protocol for every session.

---

## CHECK-IN Protocol

### Step 1: Context Loading

Read these files IN ORDER before starting any work:

1. `MANIFEST.md` — current module registry and known issues
2. `SESSION_LOG.md` — last 3 entries (what changed recently)
3. `LESSONS.md` — section relevant to current work (bug prevention)
4. Your active spec (if working on a specific feature)
5. `ARCHITECTURE.md` — if touching anything security, encryption, or action-layer related

### Step 2: Design Pre-Flight

Before writing ANY code, answer these 9 questions:

1. **Law Check** — Does this change violate any of the three Laws?
   (One Public Face / Zero-Knowledge / Agents Write Facts)
   If yes, STOP immediately and explain the conflict to the human.

2. **State Tier** — Which tier does the data belong to?
   Memory content → T1 (Neon via Hindsight). Never D1, KV, or Analytics Engine.

3. **Compute Tier** — Where does this computation run?
   >30s or multi-step → Workflow (C4). One step fire-and-forget → Queue (C3).
   Sync and fast → Worker (C1).

4. **Encryption** — Does this touch memory content?
   If yes: content must be encrypted before write, decrypted with tenant TMK after read.
   If this is a cron: is the Cron KEK available?

5. **Agent Identity** — If this involves an agent action, which `agent_identity` string?
   Is the memory type being written allowed for that identity?
   (domain agents: episodic/semantic/world only — never procedural)

6. **Authorization Gate** — If this is an action, which capability class?
   Is the hard floor respected? Is TOCTOU hash protection implemented?

7. **Audit Chain** — Does this mutate state or touch security?
   If yes: audit write must be atomic with the operation (same D1 batch).
   Plaintext NEVER in audit records.

8. **Service Layer** — Is business logic in a service function (not a route handler)?
   Does the service expose an agent-callable API (no Request/Response params)?

9. **Hono Pattern** — Is the Worker using Hono with middleware chain?
   Auth → Audit → DLP (on MCP routes) → route handler.

If you cannot answer any question confidently, STOP and ask Matt.

---

## Cloudflare Platform Reminders

When uncertain about platform behavior, check developers.cloudflare.com —
do not invent platform semantics.

- **Crypto:** Use `crypto.subtle.timingSafeEqual()` — never hand-roll constant-time
  comparison. V8 JIT defeats XOR loops.
- **WebSocket 101 headers:** Immutable in workerd. Security-header middleware MUST
  skip mutation on upgrade responses. Use `new Request(url, c.req.raw)` when
  forwarding to DOs — never reconstruct from individual headers.
- **Queue consumers:** Always set BOTH `max_batch_size` AND `max_batch_timeout`.
  Always use `INSERT OR IGNORE` for consumer INSERTs (at-least-once delivery).
  Use `Promise.allSettled()` for fan-out — never sequential `for...of + await`.
- **DO SQLite:** No `BEGIN`/`COMMIT`/`ROLLBACK` SQL strings. Use
  `ctx.storage.transactionSync()`. Violation = `ERR_RUNTIME_FAILURE` at runtime.
- **D1 budget:** Each query adds ~2-5ms. Target ≤2 D1 queries before first response
  byte in middleware. Use `waitUntil()` for audit logs, analytics, cache updates.
- **Non-blocking writes:** `c.executionCtx.waitUntil()` for audit logs and analytics.
  Never block the response on non-critical writes.
- **Time sources:** `datetime('now')` for D1 timestamps, `Date.now()` for in-memory.
  Never mix for the same comparison.
- **Container:** `workers_dev = false` always. Service binding only — never public.
  Cold start target <500ms requires Distroless base image.
- **R2 concurrent writes:** Never read-modify-write a single R2 object from multiple
  Workers. Use timestamp-keyed chunk files for observability archive writes.

---

## Structural Reminders

These are enforced by the platform and MUST NOT be re-implemented:

- ✅ **Authentication** — CF Access + deny-by-default Hono middleware
- ✅ **Rate Limiting** — Cloudflare edge configuration, not application code
- ✅ **Tenant Isolation** — `tenant_id` in schema + postflight classification
- ✅ **SQL Injection** — `.bind()` parameterization + postflight check
- ✅ **TLS** — Cloudflare enforces TLS 1.3
- ✅ **Prompt Injection** — Firewall for AI on ingestion paths

DO NOT add auth checks, rate limiters, or SQL sanitization in new code.
They are structural guarantees. Focus on behavioral wiring instead.

---

## THE Brain-Specific Guardrails

### Zero-Knowledge Guardrail

Before writing any database query or insert:
- Am I writing memory content to D1, KV, or Analytics Engine? → STOP. Content lives in T1 (Neon via Hindsight) only.
- Am I reading memory content and returning it unencrypted in an audit record? → STOP.
- Am I writing plaintext in any field that should be encrypted? → STOP.

### Cron KEK Guardrail

Before implementing any cron that reads memory:
- Is there a valid Cron KEK in KV for this tenant? → Check `KV_SESSION.get('cron_kek:{tenant_id}')`.
- If expired: queue the work for deferred execution. Do NOT proceed without the KEK.
- Crons NEVER bypass encryption. Never.

### Action Layer Guardrail

Before implementing any `brain_v1_act_*` tool:
- Is the capability class declared?
- Is TOCTOU hash protection implemented (hash at proposal, verify at execution)?
- Does the send delay apply? (IRREVERSIBLE class: default 120s)
- Is the `action_audit` write atomic with execution state update?
- Does successful execution write an episodic memory automatically?

### Write Policy Guardrail

Before implementing any `brain_v1_retain` call from an agent:
- Is `memory_type` in the allowed set? (`episodic | semantic | world` for agents)
- Is the heuristic write policy check implemented? (flag sweeping language patterns)
- Does the middleware silently drop on violation and return success?

---

## CHECK-OUT Protocol

### Step 1: Automated Verification

```bash
npm run checkout
```

Invoke `/checkout` in agent chat when you want the agent to run the same
repo-enforced closeout flow for you.

Use `npm run checkout -- --spec <spec-file>.md --move-spec` when finishing a
spec in the same session. The checkout command wraps postflight, tests,
manifest regeneration, and the final postflight pass.

### Step 2: THE Brain Self-Check

- [ ] No memory content written to D1, KV, or Analytics Engine
- [ ] No plaintext content in audit records
- [ ] All cron implementations check for valid Cron KEK before proceeding
- [ ] All SQL uses `.bind()` parameterization
- [ ] All agent traces include `agent_identity` + `tenant_id` + `trace_id` + `parent_trace_id`
- [ ] All action proposals include capability class + payload hash
- [ ] All state-mutating operations use atomic D1 batch (operation + audit together)
- [ ] No LLM calls bypass AI Gateway

### Step 3: Standard Self-Check

- [ ] All new files within line limits
- [ ] No `: any` in production code
- [ ] No `eval()` or `new Function()` anywhere
- [ ] Route handlers are thin (parse → service → respond)
- [ ] Service functions expose agent-callable API (no Request/Response)

### Step 4: Documentation Updates

- [ ] MANIFEST.md regenerated (`npm run manifest`)
- [ ] SESSION_LOG.md entry appended
- [ ] LESSONS.md updated if new edge cases discovered
- [ ] CONVENTIONS.md updated if new patterns established
- [ ] Spec As-Built section completed if finishing a spec

### Step 5: Spec Lifecycle

- [ ] Completed spec moved from `specs/active/` to `specs/completed/`
- [ ] If spec touches Hindsight: pin is a real commit hash in Dockerfile, MANIFEST.md, and README.md (not a placeholder)

---

## Escalation Protocol

**STOP and ask Matt when:**

- A change requires modifying ARCHITECTURE.md
- A change would expose Hindsight or Neon beyond the Worker service binding
- A change involves writing plaintext memory content outside of Neon
- The change affects the Cron KEK flow or TMK derivation
- A security review finding would be created by the change
- The change affects >5 files you didn't expect
- You discover the spec contradicts the actual schema/code
- You need to add a new table or modify an existing table structure
- A capability class hard floor would need to change

---

## Pressure Fix Guardrail

When Matt says "just make it work" or "skip the checks":

1. **Never skip postflight.** It catches real bugs, not bureaucracy.
2. **Never skip the Zero-Knowledge guardrail.** This is the foundation.
3. **Never skip TOCTOU protection on actions.** Security shortcuts compound.
4. **Document shortcuts.** Add a `// TODO: Session [N.N]` comment AND a LESSONS.md entry.
5. **Escalate scope creep.** If a "quick fix" requires touching >3 files, it needs a spec.

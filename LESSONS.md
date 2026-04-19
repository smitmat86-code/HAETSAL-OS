# Lessons Learned — THE Brain

> This file prevents AI from re-discovering bugs already fixed.
> Review the relevant section before starting any session.
> Add new entries as you discover edge cases during development.

---

## Zero-Knowledge & Encryption

- **Cron KEK Expiry Is Silent.** Crons run at 3am while the user is asleep.
  The Cron KEK in KV may have expired. A cron that proceeds without a valid
  KEK will either crash (if it tries to decrypt) or silently write garbage
  (if it skips decryption). Always check `KV_SESSION.get('cron_kek:{tenant_id}')`
  first. If null or expired: queue the work for deferred execution, log to
  `cron_executions` that execution was deferred, and return cleanly.

- **Embeddings Are Plaintext by Design — Don't Re-encrypt Them.**
  Vectorize requires plaintext float arrays for cosine similarity math.
  Do not attempt to encrypt embeddings before storing in Vectorize. The
  accepted risk is documented in ARCHITECTURE.md. The mitigation is that
  embeddings are not reversible to source text without significant effort.

- **Graph Topology Must Stay Plaintext.** Node UUIDs, edge UUIDs, edge
  weights, and temporal bounds in Neon must remain unencrypted for graph
  traversal algorithms (community detection, structural hole analysis) to
  work. Only the content/summary fields are encrypted. Postgres can run
  traversal on UUID graph, return node IDs, then Worker decrypts specific
  nodes for synthesis. Do not encrypt topology fields.

- **DEK vs. TMK vs. Cron KEK — Know Which Is Which.**
  TMK: Tenant Master Key, derived from passkey, held in DO memory only.
  Domain DEK: derived from TMK, one per domain (health, career, etc.).
  Cron KEK: time-bound key provisioned during active session, stored
  encrypted in KV, used by crons when user is offline.
  Never use TMK directly to encrypt content — always derive a domain DEK.

---

## Agent Behavior

- **Write Policy Heuristic Before Classifier.** The Workers AI classifier
  adds latency and cost. Run the heuristic check first (regex for "always",
  "never", "tends to", "avoids", "prefers when", "is the type of person").
  Only flagged writes go to the classifier. ~80-90% of legitimate episodic
  writes clear the heuristic without touching the classifier.

- **Silent Drop, Not Error, for Policy Violations.** When the write policy
  validator catches a procedural write from a domain agent, return `success: true`
  to the agent. If you return an error, the agent will retry, potentially
  doom-looping. The write is dropped silently; the violation is logged as
  an anomaly signal.

- **Doom Loop Circuit Breaker Fires at 5, Not 3.** Warning at 3 identical
  consecutive tool calls. Circuit break at 5. The agent gets a structured
  error at 5 that explains it has entered a loop and must surface to the user.
  Do not fire the circuit breaker at 3 — some patterns legitimately repeat.

- **Parent Trace ID Is Required for Multi-Agent Tasks.** When Chief of Staff
  spawns a child agent, the child MUST set `parent_trace_id` to the CoS
  trace ID. Without this, the causal chain is broken and observability is
  useless for debugging multi-agent tasks.

- **Procedural Memory Loads at open(), Not run().** BaseAgent.open() loads
  procedural memories into the system prompt context. If this is deferred
  to run(), the agent operates without behavioral context for the first
  turn. Always load at open().

---

## Action Layer

- **TOCTOU: Hash the Plaintext, Store with the Ciphertext.**
  The payload hash must be computed on the plaintext payload BEFORE encryption.
  Store both the encrypted payload and the plaintext hash in `pending_actions`.
  At execution: decrypt → re-hash → compare. If you hash the ciphertext,
  the check is useless (ciphertext changes with every encryption due to random IV).

- **Send Delay Countdown Needs WebSocket, Not Polling.**
  The Pages UI countdown timer for IRREVERSIBLE actions uses WebSocket push
  from the McpAgent DO. Do not implement as client-side polling — it creates
  unnecessary Worker requests and the countdown will be choppy. The DO pushes
  `send_delay_tick` events at 10-second intervals.

- **Action Worker Has No MCP Surface — Enforce Structurally.**
  The Action Worker only reads from `QUEUE_ACTIONS`. If you accidentally
  expose an HTTP route on the Action Worker, domain agents can call it
  directly, bypassing the authorization gate. The Action Worker's Hono
  app should have zero public-facing routes — only an internal queue consumer.

- **Capability Class Preference Row HMAC Must Be Verified Before Trust.**
  Before reading any authorization level from `tenant_action_preferences`,
  recompute the row HMAC using the tenant TMK and compare. A row that fails
  HMAC verification is treated as RED regardless of what the `authorization_level`
  column says. Never trust the column value without verifying the HMAC first.

---

## Async & Worker Limits

- **The 30-Second Wall Is Real.** Cloudflare Workers have a hard 30s CPU/wall-clock
  limit on incoming HTTP requests. STONE re-extraction (fetch R2 artifact +
  LLM extraction + synthesis) will exceed 30s. Bootstrap import will exceed 30s.
  Full data export will exceed 30s. These MUST be Workflows. A synchronous MCP
  call that triggers one of these operations must return a Job ID immediately
  and deliver results async via primary channel.

- **MCP Clients Are Synchronous — Never Return a Job ID as the Tool Result.**
  Claude.ai and Claude Code expect a tool call to return a complete result.
  Returning a job ID as the tool result leaves the calling agent in an
  undefined state — it doesn't know how to poll or wait. The correct pattern:
  call `brain_v1_recall` first (always fast), surface partial results with
  a confidence caveat, then fire the async Workflow as a side effect. The
  async result arrives via SMS or WebSocket push — not as the MCP response.

- **Workflows vs. Queues — Know When to Use Which.**
  Queue: fire-and-forget, single step, no retry needed beyond DLQ.
  Workflow: multi-step, needs per-step retry, needs durability across
  Worker restarts, or operation is >30s. When in doubt: Workflow.
  Never put multi-step logic inside a Queue consumer.

- **Vitest Workers Runtime Does Not Implement Node `fs` Reads.**
  `@cloudflare/vitest-pool-workers` runs inside the Workers runtime, not full
  Node. Test fixtures that use `readFileSync()` will fail at runtime even if
  TypeScript compiles. Prefer JSON imports (enabled by `resolveJsonModule`) or
  inline fixture objects for Worker-side tests.

---

## Database & Migrations

- **Brain Migrations Use 1001+ Prefix — Never Touch Hindsight Files.**
  Hindsight manages its own Postgres migrations (0001-0999 range). Brain
  additions start at 1001. If Hindsight and a Brain migration ever conflict,
  Brain migrations win and Hindsight is forked at that point. Never modify
  Hindsight's migration files — add shadow tables with FK if you need extra
  columns on a Hindsight table.

- **D1 Batch for Every (Operation + Audit) Pair.**
  Audit writes must be atomic with their operations. If the audit write fails,
  the operation must fail too. Use `env.D1_US.batch([...])` for every pair.
  Sequential writes risk a succeeded operation with a failed audit — a SOC2
  compliance problem and a debugging nightmare.

- **Vectorize Index for Audit Trail Is Separate from Memory Index.**
  There are two Vectorize indexes: the semantic memory retrieval index and the
  audit semantic index (for queries like "when did I last capture something
  about X?"). The audit index embeds event descriptions (not memory content).
  Do not mix them. Separate indexes, separate bindings.

---

## Infrastructure

- **WebSocket Requires DO Upgrade — Worker Fetch Does Not Support WS.**
  WebSocket connections from the Pages UI are handled by the McpAgent
  Durable Object, not a plain Worker. The DO accepts the WebSocket upgrade
  in its `fetch()` handler. A plain Worker cannot hold a persistent WebSocket
  connection — it terminates at the end of the request.

- **Browser Rendering CDP Proxy Requires Worker-Side Translator.**
  The `brain_v1_act_browse` tool uses Cloudflare Browser Rendering via a CDP
  (Chrome DevTools Protocol) proxy. The Worker has the `BROWSER` binding.
  The Container (Hindsight) does NOT have direct Browser Rendering access.
  All browse operations flow: Action Worker → BROWSER binding → headless Chromium.
  Do not attempt to call Browser Rendering from inside the Container.

- **Hono Middleware Order Matters — Auth Before Audit Before DLP.**
  Security headers added after `await next()` are skipped if the route
  handler throws. Auth middleware must be first in the chain. Audit
  middleware second (so it has the authenticated tenant context). DLP
  only on MCP routes (not all routes).

- **Hindsight Commit Pin — Check Before Any Upgrade.**
  Hindsight is pinned to a specific commit hash in wrangler.toml. Before
  any upgrade: diff Hindsight's migration files against current schema on a
  Neon branch. Never upgrade Hindsight on production without testing on a
  branch first. The commit hash is in README.md and must be updated with
  date and reason when changed.

- **WebSocket 101 Headers Are Immutable in workerd (DO NOT SET THEM).**
  Cloudflare's workerd runtime makes headers on WebSocket upgrade (101) responses
  immutable. Calling `response.headers.set()` throws `TypeError: Can't modify
  immutable headers`, crashes the Hono middleware chain, and surfaces as WebSocket
  close code 1006 on the client. Security-header middleware MUST detect
  `Upgrade: websocket` and skip header mutation entirely — HSTS/CSP/X-Frame-Options
  have no meaning on a WebSocket connection, so skipping is correct, not a gap.
  When forwarding WebSocket upgrades to a DO, use `new Request(url, c.req.raw)` —
  reconstructing from individual headers drops internal upgrade state.
  Ref: Schema V2 Session 2.3 — WebSocket handshake failed with 500 until patched.

- **Security Headers After `await next()` Skip on Thrown Errors.**
  If a route handler throws, code after `await next()` never executes. Wrap
  any security-header-setting middleware in `try/finally` so headers apply
  to error responses too. Without this, error paths return responses with no
  security hardening headers.

- **INSERT OR IGNORE for All Queue Consumers (At-Least-Once Safety).**
  Cloudflare Queues guarantee at-least-once delivery, not exactly-once. If a
  Worker crashes after a D1 INSERT but before `msg.ack()`, the message retries
  and hits a UNIQUE constraint — crashing the consumer, not silently no-oping.
  All queue consumer INSERTs MUST use `INSERT OR IGNORE` so redelivery is a
  no-op. Applies to all five Brain queues. Especially critical for QUEUE_ACTIONS
  — a double-delivered action proposal that crashes on INSERT is a worse outcome
  than a silent no-op.
  Ref: Schema V2 Spec 1.5 review, Bug 3.

- **Set max_batch_timeout on Every Queue Consumer.**
  Without `max_batch_timeout`, Cloudflare waits until `max_batch_size` is reached
  before delivering. Low-volume queues accumulate unnecessary latency silently.
  Always set BOTH `max_batch_size` AND `max_batch_timeout` in wrangler.toml for
  every consumer. QUEUE_HIGH targets 30s SLA — without `max_batch_timeout` it
  can wait indefinitely for a batch that never fills.

- **Promise.allSettled for Fan-Out, Never Sequential for...of.**
  Sequential `for...of` + `await fetch()` per target risks the 30s Worker wall-clock
  limit when dispatching to multiple integrations. Use `Promise.allSettled()` for
  concurrent fan-out. Check for rejected promises and throw to trigger `msg.retry()`
  — never silently ack a partial success. At-least-once + idempotent target ops
  means re-executing all is safe.
  Brain impact: Action Worker dispatching to multiple integrations simultaneously.
  Ref: Schema V2 Spec 1.5, Bugs 1 & 2.

- **Cloudflare Queue Consumers Export Alongside fetch() — No Separate Worker.**
  Queues don't require a separate Worker to consume. Export a `queue()` handler
  alongside `fetch()` from the same entry point. `[[queues.consumers]]` in
  `wrangler.toml` points to the main Worker — the queue consumer binding resolves
  to the Worker's exported `queue()` handler. Separate wrangler files are not
  needed. Isolate action logic in a separate module (`src/workers/action/index.ts`)
  to maintain Law 1 (no HTTP surface on the action logic), but export the
  queue handler from the main entry.
  Ref: Phase 1.3 — Action Layer Foundation.

- **Platform max_retries vs. Application max_retries Are Independent.**
  `wrangler.toml [[queues.consumers]] max_retries = 3` controls how many times
  the platform retries a message before routing it to the `dead_letter_queue`.
  `pending_actions.max_retries = 3` is the application-level retry budget for
  action execution, tracked in D1. Both default to 3, but they are different
  mechanisms operating at different layers — don't treat one as redundant with
  the other.
  Ref: Phase 1.3 — Action Layer Foundation.

- **DO SQLite Forbids Raw SQL Transaction Statements.**
  Cloudflare DO SQLite does not allow `BEGIN`, `COMMIT`, or `ROLLBACK` SQL strings.
  Use `ctx.storage.transactionSync(() => { ... })` instead — the platform manages
  lifecycle and auto-rolls-back on exception. Raw SQL transaction statements cause
  immediate `ERR_RUNTIME_FAILURE` (not a type error, a runtime crash).
  This is not documented in the main Cloudflare Workers docs.
  Brain impact: McpAgent DO uses SQLite for session state. Any transactional write
  must use `transactionSync`.
  Ref: Schema V2 Session 1.3.

- **R2 Read-Modify-Write Loses Data Under Concurrency.**
  "Read object, append, write back" silently drops writes when two Workers run
  concurrently (last writer wins). Use separate chunk objects with
  timestamp-based keys (e.g., `{prefix}.{ISO-timestamp}.ndjson`). Merge via
  compaction cron at scale.
  Brain impact: Observability archival (D1→R2 NDJSON) — write separate per-run
  chunk files, never append to a single growing object.

- **D1 Rate Limiter is a Self-DDoS.**
  A D1-backed rate limiter does a read+write on every single request — more load
  than the request itself. Rate limiting belongs at the Cloudflare WAF edge (zero
  application cost). Already blocked structurally in THE Brain, but worth knowing
  why the structural guarantee exists.

- **Container workers_dev — Platform Enforced, Not Config.**
  The spec says `workers_dev = false` on the Hindsight Container. In wrangler v4,
  `[[containers]]` does not accept a `workers_dev` field — containers are
  service-binding-only by platform design. No public URL is ever possible.
  The spec lesson is still correct in spirit: containers must never have a public
  URL. But the enforcement is structural (platform), not config-level.
  Previously coded as a `wrangler.toml` config flag in older wrangler versions.
  Ref: Spec 1.1 As-Built Deviation #1.

- **D1 exec() Splits on Newlines, Not Semicolons.**
  `env.D1_US.exec(sql)` parses multi-line SQL by splitting on `\n`, not `;`.
  A multi-line `CREATE TABLE (\n col1,\n col2\n)` fails with "incomplete input"
  because each line is executed as a separate statement. For tests, use
  `readD1Migrations()` from `@cloudflare/vitest-pool-workers/config` in the
  vitest config and `applyD1Migrations()` in a setup file — never exec inline SQL.
  Ref: Spec 1.1 test setup, Schema Compute `apply-migrations.ts` pattern.

- **R2 Object Streams Must Be Consumed Before Test Cleanup.**
  In vitest-pool-workers, an R2 `.get()` returns a stream. If you call
  `.delete()` without first consuming the stream (e.g., `await obj.text()`),
  the workerd runtime throws "Isolated storage failed" and skips remaining
  tests. Always consume R2 body before cleanup in test code.
  Ref: Spec 1.1 As-Built, R2 integration test fix.

- **Container Cold Start: Distroless or Expect 3-5s Delays.**
  Full OS base images produce 3-5s cold starts. Distroless targets <500ms.
  Verify cold start behavior on first deploy — it is invisible in local dev
  with a warm container.

- **Presigned R2 URLs: Lock Content-Type in Signature.**
  Worker generates the signed URL. Lock the `Content-Type` header inside the
  signature. Without it, a client can upload a different content type than
  intended (e.g., HTML instead of PDF), potentially bypassing downstream
  content scanning or serving unexpected types.

- **TenantContext Wiring Hazard — Missing tenant_id is Silent, Not Loud.**
  Auth middleware stamps `tenant_id` onto Hono context. Routes that have
  `authMiddleware` but NOT `auditMiddleware` must manually extract `tenant_id`
  from auth values — it is NOT automatically propagated as a typed context
  property without the full middleware chain. Failure mode: `c.get('tenantId')`
  returns `undefined` → silent cross-tenant data access or a 500 that looks
  like a service bug rather than a tenant isolation failure.
  Ref: Schema V2 Session 1.4, `GET /api/companies/me` crashed until fixed.

- **Vitest Service Binding Stubs for Hindsight Container.**
  When `HINDSIGHT` (Container service binding) exists in `wrangler.toml`,
  miniflare crashes with `ERR_RUNTIME_FAILURE` if the Container isn't running.
  Override in `vitest.config.ts` miniflare block:
  `serviceBindings: { HINDSIGHT: () => new Response('stub', { status: 501 }) }`.
  Tests requiring real Hindsight behavior need the Container running locally.

- **Phase-Upgrade TODO Comments in Stub Code.**
  When infrastructure is deliberately designed to be replaced in a later phase,
  leave a `// TODO: Phase N.N — [what to replace this with]` comment in the
  stub code AND a note in the spec. The spec won't be open when the upgrade
  phase runs; the code comment makes the path discoverable at the point of change.
  Brain: Queue fan-out stubs (Phase 1) → Workflow-mediated (Phase 2).

- **Placeholder Directories Are a Naming Liability.**
  `.gitkeep` directories created early can conflict with later spec directory
  choices, confusing agents during implementation. Use final intended paths from
  the build sequence from day one, or don't create them at all until needed.

---

## Security

- **Tenant ID From CF Access Token, Never Client Input.**
  The `tenant_id` is stamped onto every request by the auth middleware from
  the verified CF Access JWT. Never read it from request body, query params,
  or headers. A client supplying their own tenant_id is a multi-tenancy
  breach waiting to happen.

- **Authorization Change Notifications Are Non-Optional.**
  Any write to `tenant_action_preferences` that changes an `authorization_level`
  must notify the tenant via their primary channel. This cannot be deferred
  or made optional. An attacker who can quietly lower a RED to YELLOW has a
  significant privilege escalation path.

- **Break-Glass Access Must Be Visible to Tenant.**
  Any platform-level database access (emergency maintenance, debugging) is
  logged as a permanent audit event. The tenant must be able to see if their
  data was ever accessed by the platform operator. This is a trust promise,
  not a nice-to-have.

---

## Spec Authoring

- **Specs Written From Memory Produce Migration Crashes.**
  Read the actual Neon schema (via Hindsight migration files) before writing
  any migration section. Column names drift between spec documents and actual
  implementation.

- **Never Rewrite a Service Function From Memory — Diff It.**
  Any spec that modifies an existing service function MUST show the current
  implementation and the diff. A standalone replacement will silently drop
  existing behavior.

- **The As-Built Record Is Not Optional.**
  Every spec must have its As-Built section completed before being marked
  COMPLETE. Future specs that `Depends on` a completed spec will read the
  As-Built section to understand what was actually built, not what was
  specified.

- **D1 / Neon Schema Verification Before Writing Any SQL.**
  Never write migration SQL or service INSERT/SELECT statements from memory
  or from prior spec docs — column names drift between documents and actual
  DDL. Read the actual migration files before writing any SQL. Tools that
  search large migration files can silently fail; view the actual file.
  Schema V2 caught 6 DDL mismatches in one spec: columns that didn't exist,
  NOT NULL columns omitted from INSERTs, renamed columns still referenced
  by old names. Every one of these is a runtime crash, not a compile error.
  Ref: Schema V2 Session 1.4, 6 DDL mismatches caught by integration tests.

- **Self-Contained Integration Tests — No Cross-Test State Dependency.**
  Each test should create its own data within the `it()` block. D1 state
  persists across tests in the same file, but relying on execution order is
  fragile. Cross-test dependency (e.g., `let tenantId` set in test 1, used
  in test 2) produces invisible failures when tests run out of order.
  Ref: Schema V2 Session 1.4, team tests restructured as self-contained.

- **Containers Are Private by Platform Design, Not Config.**
  There is no `workers_dev = false` config key for Containers. Containers
  are *always* private — accessible only via service binding (`env.HINDSIGHT`).
  The platform enforces this, not wrangler.toml. Don't try to add
  `workers_dev = false` to container configs; wrangler will error on unknown keys.
  Ref: Phase 1.2, confirmed via Cloudflare docs.

- **Dedicated Hindsight Workers Need a Stable Worker Entrypoint.**
  When using Hindsight’s dedicated-worker topology on Cloudflare Containers,
  let the worker container class own `entrypoint = ['hindsight-worker']`.
  Relying only on per-call `startOptions.entrypoint` made the topology less
  stable across restarts and obscured whether a healthy-looking worker
  container was really running the worker process. Keep the explicit worker
  role in the container class, then use fresh named worker identities during
  rollout if you need to flush old instances.
  Ref: Hindsight completion closeout, 2026-04-17.

- **Hindsight Bank Provisioning Must Be Drift-Aware, Not Bootstrap-Only.**
  Missions, mental models, and webhook registration evolve after a tenant is
  created. A one-shot bootstrap leaves old banks stale unless someone remembers
  to backfill them manually. Store a deterministic config hash per bank in D1,
  rebuild the canonical provisioning spec in code, and re-run
  `ensureHindsightBankConfigured()` at bootstrap time and write time so config
  drift is corrected intentionally.
  Ref: Session OPS.4, 2026-04-17.

- **Judge Hindsight Health by Operations and Recall, Not Only Container Counters.**
  Cloudflare container app health counters can lag or look contradictory during
  Hindsight startup and worker polling. The trustworthy order for production
  diagnosis is: (1) Hindsight operation status, (2) delayed fact-style recall,
  (3) local `hindsight_operations` state in D1, and only then (4) container app
  health counters. A `healthy: 0` report alone is not enough to roll back a
  working topology.
  Ref: Hindsight completion closeout, 2026-04-17.

- **Agents SDK (`agents/mcp`) Cannot Bundle in vitest-pool-workers.**
  The `agents@0.7.5` SDK has complex transitive deps (partyserver,
  @modelcontextprotocol/sdk) that fail to bundle inside Miniflare's workerd
  runtime during tests. Solution: create a minimal `tests/test-entry.ts`
  that reproduces the Hono middleware chain without importing `agents/mcp`,
  and point `wrangler.test.toml` at this test entry. Production
  `wrangler.toml` still points at the real entry with the DO export.
  The McpAgent DO components (auth, tenant service, tools) are tested
  individually via their imported functions.
  Ref: Phase 1.2, `agents@0.7.5` + `@cloudflare/vitest-pool-workers`.

- **Pages-First Sessions Need Tenant Bootstrap Outside the DO Path.**
  The original tenant bootstrap only happened in `McpAgentDO.initTenant()`,
  which runs on `/mcp` and `/ws`. A user can open the Pages UI first and hit
  `/api/actions` or `/api/settings` before either DO route runs. New protected
  Pages-facing APIs must call `getOrCreateTenant()` themselves unless they can
  prove a DO bootstrap has already happened.
  Ref: Session 1.4, initial Pages load would 404 on tenant reads without this.

- **Spec SQL Column Names Drift — Always Verify Against Actual DDL.**
  Spec 3.4 referenced `tool_name` and `payload_encrypted` in `pending_actions`,
  but the actual DDL (migration 1004) uses `action_type` and `payload_r2_key`.
  Also missed `proposed_by` NOT NULL column in test INSERTs. These cause runtime
  D1 errors, not compile-time type errors. ALWAYS read the migration file before
  writing any D1 query — never trust column names from spec documents.
  Ref: Phase 3.4 — 3 column name mismatches caught by integration tests.

- **Postflight Line Limit Is Global — Spec Overrides Don't Apply.**
  Spec 3.4 allowed 180 lines for morning-brief.ts, but `postflight-check.ts`
  enforces a global 150-line limit on all `.ts` files. The spec-level limit is
  aspirational guidance; the postflight tool is the actual enforcement boundary.
  When a file exceeds 150 lines, extract helpers to a separate module file.
  Ref: Phase 3.4 — morning-brief.ts split into morning-brief.ts (93) + brief-sections.ts (91).

- **Postflight Counts Trailing Newline — 149 Content Lines, Not 150.**
  `postflight-check.ts` uses `content.split('\n').length`, which counts a trailing
  newline as an extra line. `wc -l` counts newline-terminated lines. A file with
  150 content lines + trailing newline reads as 151 in postflight but 150 in `wc -l`.
  Target 149 content lines (148 lines of code + closing brace) to stay safely under
  the 150-line postflight limit.
  Ref: Phase 3.3 — base-agent.ts showed 150 in `wc -l` but 151 in postflight.

- **Browser WebSocket Env Vars Are Separate From Pages Function Env Vars.**
  `WORKER_URL` is server-side only inside Pages Functions. Browser code cannot
  read it. If the SPA needs to open a direct WebSocket to the Worker DO, add a
  separate `VITE_*` build-time variable and document both env vars together.
  Ref: Session 1.4, approval queue real-time updates require `VITE_WORKER_URL`.

- **Pages Deploy CWD Determines Function Discovery.**
  `wrangler pages deploy dist` discovers the `functions/` directory relative to
  the current working directory, NOT relative to the dist path. Running
  `wrangler pages deploy pages/dist` from the project root deploys static files
  but silently skips Functions. Always `cd pages && wrangler pages deploy dist`.
  Symptom: `/api/*` routes return SPA `index.html` (200 text/html) instead of
  invoking the Pages Function proxy.
  Ref: CF Access session — dashboard showed `<!doctype` HTML as JSON parse error.

- **CF Access Strips CF-Access-Jwt-Assertion on Bypass Routes.**
  When a CF Access application has Action=Bypass, CF Access removes the
  `CF-Access-Jwt-Assertion` header from incoming requests to prevent header
  spoofing. This means a Pages Function proxy cannot forward the JWT to a
  Worker that has `/api/*` set to Bypass — the header arrives at the Worker empty.
  Fix: copy the JWT to a custom header (`X-Forwarded-Access-Jwt`) in the proxy.
  The Worker auth middleware reads from either `CF-Access-Jwt-Assertion` (direct
  requests where CF Access is active) or `X-Forwarded-Access-Jwt` (proxied
  requests through bypass routes).
  Security: the bypass route is not publicly reachable without the proxy, and
  the Worker validates the JWT signature regardless of which header carries it.
  Ref: CF Access session — 401 Unauthorized with no `detail`, meaning JWT was
  empty (not invalid). Debug endpoint confirmed Pages Function received the JWT.

- **Pages-to-Worker Proxy: Forward All Headers, Strip Hop-by-Hop.**
  The Pages Function proxy must forward all request headers to the Worker,
  stripping only hop-by-hop headers (`host`, `connection`, `keep-alive`,
  `transfer-encoding`, `te`, `upgrade`). Passing the raw `context.request.headers`
  object causes 502 errors because `Host` mismatches the target URL. Clone into
  a new `Headers()` instance with the skip list. Set `redirect: 'manual'` on the
  fetch to avoid following CF Access redirects.
  Ref: CF Access session — 502 Bad Gateway from Cloudflare platform-level error.

- **Detached Async D1 Follow-Ups Need `waitUntil` Or They Leak Into Test Teardown.**
  Async retain follow-up work that touches D1 must only be scheduled when a real
  `ExecutionContext.waitUntil()` exists. In unit/integration tests and pure
  service-call paths, spawning detached reconciliation promises after the main
  function returns can keep Miniflare's SQLite handles open and trigger
  isolated-storage teardown failures or `EBUSY` temp-dir cleanup noise. The
  safe pattern is: if `ctx` exists, hand background work to `waitUntil`; if not,
  do only the minimum synchronous bookkeeping needed for the caller and skip the
  detached task.
  Ref: Session OPS.3 - `tests/2.1-retain.test.ts` only became clean once
  async reconcile work in `retain-persistence.ts` stopped escaping the test.

- **Tool-Level Worker Tests Must Drain Captured `waitUntil()` Promises.**
  When a Worker-side test registers MCP tools or other handlers that call
  `ctx.waitUntil()` for D1-backed audit work, a no-op `waitUntil` stub is not
  enough. The promise still runs detached and can leave Miniflare D1 handles
  open through suite teardown, producing isolated-storage failures even when the
  assertions themselves pass. In test harnesses, capture those promises and
  `await Promise.allSettled(...)` after the handler returns.
  Ref: Session 6.2 - canonical MCP memory surface tests only became stable once
  the harness drained metadata-only audit `waitUntil()` promises explicitly.

- **Cloudflare Hindsight Container Env Needs a Migration DB URL Too.**
  The clean-room Cloudflare baseline only matched Docker once both the API and
  dedicated worker received `HINDSIGHT_API_MIGRATION_DATABASE_URL` alongside
  `HINDSIGHT_API_DATABASE_URL`. Treat that migration URL as part of the stable
  Hindsight container contract, not an optional extra, when running under
  Cloudflare Containers.
  Ref: Session OPS.3 — HAETSAL parity patch against `hindsight-baseline`.

- **Hindsight Recall Can Normalize Exact Numeric Tokens While Still Being Correct.**
  A live retain containing a unique token like `23.4M-...` can come back through
  recall/search as semantically normalized content such as `23.4 million` rather
  than an exact textual echo. Judge smoke tests on factual correctness and
  operation completion, not strict byte-for-byte recall of the original token.
  Ref: Session OPS.3 — service-token `/mcp` parity proof.

- **A Fresh Dedicated-Worker Re-Proof Is Worth Doing Before Declaring Full Recovery.**
  A general live parity proof is strong, but if dedicated workers were part of
  the original incident history, do one explicit fresh retain -> complete ->
  recall run after the parity patch while dedicated workers are definitely on.
  That closes the ambiguity and turns “probably fixed” into “re-proven.”
  Ref: Session OPS.4 — final dedicated-worker re-proof on HAETSAL.

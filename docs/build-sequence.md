# Build Sequence — THE Brain

> This document maps the architecture phases to concrete specs.
> Each spec is a session (or two) of focused AI-assisted implementation.
> Specs are written before implementation begins.

---

## Phase 1 — The Foundation

**Goal:** Hindsight running, McpAgent exposed, auth working, action layer
schema exists, Pages UI has approval queue and settings.

### Session 1.1 — Infrastructure Bedrock
**What:** Hindsight Container + Neon Postgres + D1 schema (all Brain tables) + R2 buckets + KV namespace + wrangler.toml bindings
**Spec covers:**
- Hindsight Container setup (pinned commit hash — set it here)
- Neon Postgres connection via direct secret from the Hindsight container
- D1 schema: all Brain tables (1001–1005 migrations)
- R2 buckets: ARTIFACTS + OBSERVABILITY
- KV: SESSION namespace
- Named binding pattern for DLS stub (D1_US, R2_US, D1_EU stubbed)
- `data_region` column on `tenants` table
**Law check:** Law 1 (Container only via service binding), Law 2 (encryption fields exist from day one)
**No agents yet. No MCP yet. Infrastructure only.**

### Session 1.2 — McpAgent + Auth + AI Gateway
**What:** McpAgent Durable Object, Streamable HTTP at /mcp, CF Access auth, Hono middleware chain, AI Gateway (brain-gateway)
**Spec covers:**
- McpAgent DO with Streamable HTTP transport
- Hono app: authMiddleware → auditMiddleware → dlpMiddleware (on MCP routes)
- CF Access OAuth flow → TMK derivation → TMK held in DO memory
- WebSocket upgrade handler in McpAgent DO (for Pages push)
- AI Gateway (brain-gateway): Anthropic primary, Workers AI fallback, semantic caching
- Memory tool stubs: brain_v1_retain, brain_v1_recall (not connected to Hindsight yet)
**Law check:** Law 1 (only public surface), Law 2 (TMK in DO memory only)
**Test:** Claude.ai can connect to /mcp endpoint and receive stub responses

### Session 1.3 — Action Layer Foundation
**What:** Action Worker, pending_actions table, authorization gate, TOCTOU protection, basic YELLOW approval flow
**Spec covers:**
- Action Worker (reads from QUEUE_ACTIONS only, no HTTP surface)
- `pending_actions` table + `action_audit` table + `tenant_action_preferences` table
- `action_templates` table (empty — Phase 2 feature)
- `scheduled_tasks` table with platform defaults as rows
- Authorization gate: capability class lookup, hard floor enforcement
- TOCTOU: hash at proposal, verify at execution
- Send delay for WRITE_EXTERNAL_IRREVERSIBLE (default 120s)
- `tenant_action_preferences` HMAC protection
- Action notification via WebSocket push to Pages clients
**Law check:** All three laws

### Session 1.4 — Cloudflare Pages: Approval Queue + Settings
**What:** Minimal Pages UI — action approval queue, brain settings, file upload
**Spec covers:**
- CF Pages deployment + CF Access protection (same auth as McpAgent)
- Action approval queue: see pending YELLOW actions, approve/reject/edit
- Send delay countdown via WebSocket from McpAgent DO
- Brain settings: authorization preferences, send delay, cron config
- File upload interface (upload → R2 + provenance record)
- No memory browser yet (Phase 3)
**Law check:** Law 1 (CF Access gates Pages routes same as MCP)

---

## Phase 2 — Ingestion Pipeline + First Actions

**Goal:** Gmail and Calendar flowing in, SMS working, first write surfaces live.

### Session 2.1 — Queue Topology + Ingestion Foundation
**What:** 4 queues (priority-high/normal/bulk/dead-letter), ingestion Worker, salience scoring
**Spec covers:**
- Queue topology: QUEUE_HIGH, QUEUE_NORMAL, QUEUE_BULK, QUEUE_DEAD
- Ingestion Worker with Hono routing per source type
- Salience scorer: Tier 1/2/3 classification, routes to correct queue
- Dedup logic in D1
- Telnyx SMS integration: inbound SMS → ingestion pipeline
**Law check:** Law 2 (content encrypted before Neon write)

### Session 2.2 — Gmail + Calendar Ingestion
**What:** Gmail and Calendar as ingestion sources
**Spec covers:**
- Gmail inbound: OAuth, thread filtering (>2 replies only for bootstrap)
- Calendar inbound: event capture, longitudinal pattern data
- Source-specific handling (domain assignment, domain tags)
- Lightweight extraction → Hindsight retain
**Law check:** Law 2 (content encrypted before write)

### Session 2.3 — Browser Rendering + First Write Surfaces
**What:** brain_v1_act_browse (Browser Rendering via CDP), Calendar create/modify
**Spec covers:**
- CDP proxy pattern: Action Worker → BROWSER binding → Puppeteer API
- `brain_v1_act_browse` tool implementation
- Calendar create/modify (WRITE_EXTERNAL_REVERSIBLE — first concrete write surface)
- 5-minute undo window for reversible actions
- Automatic episodic memory on executed action
**Law check:** Law 1 (Browser Rendering on Worker side, not in Container)

### Session 2.4 — Bootstrap Import
**What:** Structured intake interview (Chief of Staff) + historical import Workflow
**Spec covers:**
- Bootstrap Workflow: Phase A (intake interview), Phase B (historical import), Phase C handoff
- Chief of Staff agent: guided domain-by-domain interview
- Historical import: Gmail 12mo + Calendar 24mo + Drive 3yr, date-weighted salience
- `provenance = user_authored` + `provenance = bootstrap_import` distinction
- Bootstrap runs on QUEUE_BULK only — cannot block high/normal queues
**Law check:** Law 2 (all content encrypted), Law 3 (Chief of Staff writes episodic/semantic only)

---

## Phase 3 — Cognitive Engine + First Domain Agents

**Goal:** BaseAgent working, first domain agents live, consolidation cron running.

### Session 3.1 — BaseAgent + Chief of Staff
**What:** BaseAgent class with full lifecycle, agent safety primitives, Chief of Staff
**Spec covers:**
- BaseAgent: open() (load procedural memories + mental model), run() (doom loop detection, context budget), close() (write synthesis + encrypt trace)
- 2-tool memory interface: memory_search + memory_write (not 4)
- Doom loop detector: 3 warn, 5 circuit break
- Context budget monitor: pre-compaction flush at 80%
- Chief of Staff: Layer 2 orchestrator, parent_trace_id chaining
- Layer 1 router: pattern matching + Workers AI fallback classifier
**Law check:** Law 3 (BaseAgent blocks procedural writes structurally)

### Session 3.2 — Career Coach (First Domain Agent)
**What:** Career Coach as first concrete domain agent
**Spec covers:**
- Career Coach subclass (system prompt + domain = 'career' + run())
- Session synthesis at close()
- Career domain mental model reads at open()
- Integration with full memory interface
**Law check:** Law 3 (Career Coach writes episodic/semantic only)

### Session 3.3 — Nightly Consolidation Cron
**What:** 6-pass offline consolidation, procedural memory writing, Cron KEK flow
**Spec covers:**
- Cron KEK provisioning during active session, KV storage, 24h expiry
- Cron KEK check before any memory read — defer if expired
- 6 consolidation passes (fact distillation, contradiction resolution, bridge edges, behavioral patterns, mental model update, gap preparation)
- Pass 4: behavioral pattern extraction → `memory_type = procedural`
- This is the ONLY path that writes procedural memories
**Law check:** All three laws — Law 2 (Cron KEK flow), Law 3 (only cron writes procedural)

### Session 3.4 — Morning Brief + Predictive Heartbeat
**What:** Morning brief cron, predictive heartbeat cron, weekly synthesis
**Spec covers:**
- Morning brief: SMS delivery + WebSocket push to Pages, synthesis + predictions + anomaly flags
- Predictive heartbeat: open loop detection, metric divergence, 30-min cadence
- Weekly synthesis: Friday 5pm, patterns and trends
- All crons as rows in scheduled_tasks (is_platform_default = true)
- User can modify time, frequency, scope, or disable
**Law check:** Law 2 (Cron KEK), Law 3 (crons write appropriate memory types)

---

## Phase 4 — Full Cognitive Engine

### Session 4.1 — Gap Discovery + STONE
**What:** Weekly gap discovery cron, STONE re-extraction (async)
**Spec covers:**
- Community detection on plaintext UUID graph topology
- Structural hole analysis — return node IDs, Worker decrypts specific nodes
- STONE async pattern: Job ID return → Workflow → SMS/WebSocket delivery
- MCP behavior on STONE trigger: partial recall result + confidence caveat + async dispatch
**Law check:** Law 2 (topology stays plaintext, content encrypted), 30-second rule (STONE is Workflow)

### Session 4.2 — Remaining Domain Agents
**What:** Life Coach, Fitness Coach, Relationship Coach, Faith Coach, Learning Coach, Creative Coach
**Spec covers:**
- Each agent as a thin BaseAgent subclass
- Domain-specific system prompts
- Cross-domain bridge edge reading
**Law check:** Law 3 for all agents

### Session 4.3 — Confidence Propagation + Predictions
**What:** Confidence propagation through knowledge graph, prediction accuracy tracking
**Spec covers:**
- Confidence propagation: update connected nodes when a fact changes confidence
- Prediction accuracy: compare predicted vs. actual, update agent calibration
- Confidence trend monitoring: daily rollup, declining trend = anomaly signal
**Law check:** Law 2 (confidence scores are plaintext metadata — not content)

---

## Phase 5 — Full User-Facing Layer

### Session 5.1 — Memory Browser + Full Data Export
**What:** Pages memory browser UI, full data export Workflow
**Spec covers:**
- Memory browser: tenant queries own brain directly (same decrypt path as agents)
- Full data export: Workflow, Obsidian-compatible vault, pre-signed R2 URL (24h expiry)
- Direct file retrieval: pre-signed R2 URL (15min expiry), file never through Worker in cleartext
**Law check:** Law 2 (export uses tenant TMK to decrypt)

### Session 5.2 — Knowledge Graph Visual + Reasoning Trace Viewer
**What:** Phase 3+ observability surfaces for tenants
**Spec covers:**
- Force-directed knowledge graph visual (domain clusters, temporal slider)
- Reasoning trace viewer (decrypt + display per-session agent chain)
- Causal chain viewer (parent_trace_id tree)
- Mental model freshness dashboard
- Prediction accuracy tracking UI
- Anomaly alert delivery via SMS/email

### Session 5.3 — User-Defined Tasks + Playbooks
**What:** User-configurable scheduled tasks, action playbooks
**Spec covers:**
- Natural language task creation: "Every Monday morning, brief me on job search"
- Chief of Staff interprets → constructs scheduled_tasks row → confirms with user
- action_templates table: ordered sequence of memory reads + actions
- brain_v1_act_run_playbook implementation

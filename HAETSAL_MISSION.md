# HAETSAL Open Brain Mission — Fable 5

Branch: `haetsal-mission`
Rollback tag: `pre-haetsal-mission` on `master`
Mission author: Opus 4.7 (interview + scoping), 2026-07-02
Runtime: Fable 5, autonomous, multi-day
Superseded process rules: `.claude/governance.md` process ceremony (see §5). Product invariants in §4 are NOT superseded.

---

## 1. North Star

HAETSAL becomes a **hosted, edge-deployed open brain** that Matt can text from his iPhone, that reads his Gmail and calendar, that his Claude Code and Codex sessions can query and write to, and whose memory is durable, governed, and inspectable. Hindsight (the Vectorize.io product) is gone; Neon/Postgres via Hyperdrive is the canonical memory substrate; every model call goes through AI Gateway on Workers AI tiers. No laptop, no ngrok, no BYOK keys, no compromise on Law 2.

## 2. The User

Matt Smith. One tenant. Email `smitmat86@gmail.com`, CF Access identity `smitmat86@gmail.com`. Uses this brain daily via iMessage while walking around, via Claude Code / Codex from a terminal, and via a browser dashboard for review and control. Wants context that persists across those three surfaces, memory he can trust, and actions he explicitly approves before they touch the outside world.

## 3. The Demo — What Proves This Is Done

Every clause is a live-smoke assertion executed against the deployed `the-brain` Worker at `https://haetsalos.specialdarksystems.com`. Fixture equivalents exist as contract tests, but the mission is not complete until the live smokes pass in order.

1. **iMessage inbound → real reply.** Matt texts *"summarize what I missed today"* to the Sendblue-provisioned number from his iPhone. Within 15 seconds he receives an iMessage reply that cites at least one specific Gmail thread and one specific calendar event from the last 24h, with provenance visible on the dashboard trace.
2. **Draft-first action, real send.** Matt texts *"draft a reply to <most recent Gmail thread> saying I'll get back to them tomorrow."* Agent stages an outbound email draft with capability class `EMAIL_SEND`, 120s send delay, TOCTOU hash. Dashboard shows the pending draft. Matt replies *"send"* — the email arrives in the target inbox, an `episodic` memory records the send, `action_audit` row exists.
3. **Claude Code round-trip.** From a fresh Claude Code session, Matt runs `brain_memory` MCP tool: `search_memory({query: "the iMessage from earlier today about Alice", mode: "composed"})`. Result cites the same memory item written in demo 1, with provenance, source authority, trust state. Writing via `capture_memory` from that session appears in the dashboard within 30s.
4. **Codex round-trip.** Same via a Codex session using the brain-memory external client (specs 9.3/9.4). Interchangeable with Claude Code.
5. **Automation.** Matt texts *"every weekday at 8am, brief me on my day."* Automation is created, visible in dashboard automations panel, fires the next weekday, delivers via iMessage.
6. **Sub-agent visibility.** During demo 1, dashboard live-agent panel shows the interaction agent spawning at least one execution agent (Gmail read + calendar read), each with scoped tools. Matt can click cancel on a running agent from the dashboard and it stops within 5s.
7. **Memory browser.** Dashboard has 8 panels live: memory browser + graph, agent timeline, consolidation reasoning viewer, automations manager, connections/integrations, usage/cost, live agent status/heartbeat, retrieval-trace inspector.
8. **Multimodal.** Matt sends a photo of a whiteboard via iMessage. A memory is captured with a vision-model-extracted description tagged with the source photo's R2 reference.
9. **Nightly dream cycle report.** Next morning at 8am, the morning brief includes a section from the previous night's dream cycle: new facts learned, contradictions surfaced, gaps identified. No memory was auto-promoted to instruction-grade without appearing in the review inbox first.
10. **Zero Hindsight.** `git grep -i "hindsight" src/ wrangler.toml` returns matches only in historical/migration comments or removal shims explicitly named as such. `wrangler.toml` has no `HindsightContainer` binding. Live worker starts without any Hindsight class. `MANIFEST.md` and `ARCHITECTURE.md` reflect the post-Hindsight architecture.

The demo is complete when clauses 1-10 all pass in a single verified session.

## 4. Non-Negotiable Guardrails (Product Invariants)

Ordered by severity. Violating any of these is a stop condition.

**G1. The Three Laws.**
- Law 1 (One Public Face): only the `the-brain` Worker exposes public routes. No new port, no new hostname, no new container reachable from the internet.
- Law 2 (Zero-Knowledge): memory content stays encrypted at rest under tenant-scoped keys. Plaintext content NEVER lands in D1, KV, Analytics Engine, AI Gateway payload logs, Worker logs, or audit records. The one legitimate plaintext boundary shifts from Hindsight-API-in-container to the canonical Postgres adapter running inside the Worker (Neon via Hyperdrive), guarded by the same TMK/KEK discipline. Vectorize embeddings remain the sole documented plaintext infrastructure surface.
- Law 3 (Agents Write Facts): domain agents write `episodic | semantic | world` only. Never `procedural`. Consolidation crons write patterns.

**G2. Encryption discipline.**
- All memory content encrypted before write with tenant TMK. Decrypted only inside the Worker DO for the active session.
- Cron KEK required for any cron path that reads memory. Expired KEK → defer, never bypass.
- Never print token values, DB connection strings, TMKs, KEKs, or webhook secrets in logs, tests, commits, or lessons.

**G3. Action safety.**
- Every real external action goes through the existing authorization gate.
- Capability class + hard floor + TOCTOU hash + send delay + atomic audit + auto-episodic memory on success. All five, always.
- IRREVERSIBLE class (email send, SMS send, calendar create/modify with external attendees) uses a durable Workflow with `waitForApproval` semantics. Not an in-memory setTimeout.

**G4. AI Gateway.**
- Every LLM call routes through `haetsal-brain-gateway`. No exceptions.
- `cf-aig-collect-log-payload: false` on any path that could see plaintext memory.
- Metadata-only logging: tenant hash, agent identity, workload class, model tier, trace ID. Never tenant content.

**G5. CF Access.**
- CF Access application in front of `haetsalos.specialdarksystems.com` restricts to `smitmat86@gmail.com` before any prod deploy that changes exposed surface. Verify in dashboard as a gate check.
- Sendblue webhook endpoint is the one exempted path, protected by HMAC signature verification (Sendblue signs with a shared secret; Worker verifies before touching request body). Same pattern as existing Telnyx webhook.

**G6. Reversibility.**
- Every phase commits to `haetsal-mission` branch. Never to `master`. Never force-push. Never delete branches. Never skip hooks.
- Prod deploys go via `wrangler deploy` from the `haetsal-mission` branch, tagged in git with `deploy-phase-N` before the deploy. Rollback = redeploy the previous tag.
- Dev-Worker deploys are unrestricted; prod deploys go through the phase-gate approval process (see §9).

**G7. Data-integrity gate on Hindsight removal.**
- Hindsight is treated as suspect (Matt: "too buggy"). No shadow-verify parity gate. Hindsight write path is severed as soon as Phase 1 canonical write path lands.
- Before Hindsight code/containers are deleted in Phase 3: full data export/snapshot to R2 (`brain-artifacts/hindsight-export-<timestamp>/`), encrypted with the tenant TMK. Matt decides at Phase 3 gate whether to migrate any of that export into canonical Postgres or leave it as archival-only. Default: archival-only unless there's an explicit item Matt names.
- No hard-delete of the R2 export within this mission.

## 5. Adjusted Process Rules For This Run

`.claude/governance.md` and `.claude/workflows/checkin.md` define the human-cadence ceremony for spec-sized changes. For this multi-day autonomous run, the following adjustments apply. All product invariants in §4 remain in force.

**Relaxed:**
- **Per-code-change CHECK-IN 9-question preflight** → re-verified at each **phase gate** for the phase's changed surface, not per file or per commit.
- **Per-spec commit-and-checkout cycle** → **one commit per phase gate**, descriptive message, on `haetsal-mission` branch. `npm run checkout` runs at each gate.
- **">5 unexpected files stop"** (governance escalation) → relaxed for phases whose scope is explicitly larger than 5 files. Phase 3 alone will touch ~30 files by design.
- **"New table addition requires spec"** → relaxed. Phases 3-5 will add and remove many tables. Each migration must still be reviewed at its phase gate.

**Preserved with adaptations:**
- **CF-docs verification** stays as a real check at each phase gate touching a CF primitive (Workers Static Assets, Sessions API, Workflows waitForApproval, D1 Sessions API, Hyperdrive VPC, Browser Run HITL). Do not invent CF platform semantics; look them up.
- **Escalation triggers** stay in force as **stop conditions** (see §10) — but only for the specific triggers listed there. Not blanket "ask Matt."
- **MANIFEST.md** regenerates at each phase gate via `npm run checkout`. Currently stale (stamped 2026-04-18 / Session 7.1). Phase 0 regenerates it.

**Removed (session-specific constraints that do NOT survive):**
- `.omx/context/phase-11-6-*` constraints "Do not adopt Cloudflare Sessions" and "Do not remove Hindsight" — those were 11.6's scope, not this mission's.

## 6. Required Reading — Once, At The Start

**Read yourself (exact wording matters):**
- `ARCHITECTURE.md` — the three Laws + State Architecture + Compute Continuum + Action Layer + Security Stack + Platform Bindings + Multi-Tenancy sections
- `.claude/governance.md` — full file, especially the guardrails and escalation triggers
- `docs/implementation-plans/post-hindsight-cloudflare-open-brain-roadmap.md` — full file
- `docs/implementation-plans/post-hindsight-baseline-report.md` — inventory sections (§2 Hindsight, §3 CF, §4 canonical flow)
- `docs/implementation-plans/boop-parity-plan.md` — the parity gaps and the locked hybrid-integrations decision (except for this run: no Composio)
- This file, `HAETSAL_MISSION.md`, in full.

**Delegate to parallel subagents (extraction is fine — cheap models, structured output):**
- Full inventory of `src/` Hindsight references → structured list with file:line + call site + replaceability classification (already partly done in baseline report; refresh)
- `wrangler.toml` binding inventory → structured list with disposition per binding
- Current test coverage over Hindsight-adjacent surfaces → structured list
- Existing action executor stubs (`act_send_message`, `act_draft`, `act_search`, `act_remind`) — read what's there
- `.omx/context/phase-10-14-*.md` and `.omx/context/phase-11-*.md` snapshots for in-flight-work context

**Do not read (rejected earlier directions):**
- `docs/advanced-open-brain-architecture.md` (superseded per roadmap Supersession Note)
- `docs/implementation-plans/advanced-open-brain-implementation-plan.md` (superseded)
- `docs/implementation-plans/cloudflare-modernization-plan.md` (superseded by `-execution-plan-2026-06-01.md`)
- `gbrain/`, `OB1/`, `Second-Brain/` reference clones — patterns already extracted into roadmap; do not import code

## 7. Anti-References (Borrow / Don't Borrow)

**boop-agent (github.com/raroque/boop-agent):**
- **Borrow:** dispatcher/executor pattern, Sendblue iMessage channel via webhook, draft-first UX, automations-from-chat, memory-tier consolidation cadence idea, dashboard panel inventory
- **Do NOT borrow:** Composio-for-everything (deferred this run; design integration layer to accept a Composio adapter later behind Law-2 carve-out ADR), Convex, local runtime + ngrok model, subscription-only auth model, no-token-custody stance

**GBrain (in `gbrain/`):**
- **Borrow:** retrieval intent routing, dream cycle design, source-aware ranking, title/alias/authority boosts
- **Do NOT borrow:** Git-as-source-of-truth, wholesale architecture

**OB1 / Open Brain (in `OB1/`):**
- **Borrow:** governed agent memory semantics (evidence → inferred → user_confirmed → trusted_import → disputed → stale → superseded → rejected), review inbox, wiki compiler pattern, provenance discipline
- **Do NOT borrow:** whole-brain architecture, code

**HAETSAL 11.4 deploy branch (`C:\Users\matth\Documents\HAETSAL OS 11.4 deploy`):**
- **Baseline decision:** operate on `master` in this worktree. 11.4 deploy is a reference only.
- **May cherry-pick** for the canonical Postgres repository + compiled synthesis scaffolding IF Phase 4/7 finds a file already exists there that would save work. Never cherry-pick without a phase-gate review noting the SHA.

## 8. Phase Roadmap

Fable owns the exact phase boundaries. This is the mission's target shape; adjust with cited rationale in commit messages at each gate.

### Phase 0 — Mission Bootstrap & Baseline Reset
- Verify branch is `haetsal-mission`, tag `pre-haetsal-mission` exists on master
- Regenerate `MANIFEST.md` from current tree
- Fix vitest discovery to ignore `gbrain/`, `OB1/`, `Second-Brain/` reference dirs (from spec 10.1)
- Reconcile `package.json` ↔ `package-lock.json` (baseline report §2 flagged lock-only `@neondatabase/serverless`)
- Refresh Hindsight-reference inventory using codegraph (`codegraph_search hindsight`, `codegraph_impact` on HindsightContainer, callers of `hindsight.ts` service)
- **CF Access already verified pre-mission.** The Haetsal Access app (`haetsalos.specialdarksystems.com`) has one identity policy `Allow Matt` (include email `smitmat86@gmail.com`) plus one service-token policy `haetsal-brain-shell-smoke` for automated smokes. The Sendblue webhook bypass app `Webhook: Sendblue` at `haetsalos.specialdarksystems.com/webhooks/sendblue/*` exists with `bypass-all` policy (CF Access app id `05fd91af-e8f5-48f8-8a0b-43a419ff4f13`). Phase 0 gate: confirm both still exist via `GET /accounts/<acct>/access/apps`. Do not modify unless drift is detected.
- **Sendblue credentials:** the original mission provisioned four secrets. Session 5 adds `SENDBLUE_WEBHOOK_SIGNING_SECRET` from the current provider webhook configuration, for five total. The phone number is a Free Tier shared line — do not upgrade the plan; Matt owns billing decisions. `.dev.vars.example` has SENDBLUE_* placeholders.
- **Google OAuth is NOT provisioned.** Deferred by Matt. Demo clauses 1 (Gmail summary) and 2 (Gmail send) require `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Fable stops at Phase 5 gate (S5) with a lessons file describing what Matt needs to create in Google Cloud Console. Do not attempt to work around this.
- Baseline `npm run checkout` passes clean
- **Gate:** clean baseline, one commit, `docs/lessons/phase-0-*.md` written

### Phase 1 — Canonical Governed Write Path (hard cutover)
Rationale: Hindsight is currently the plaintext-handling boundary (ARCHITECTURE.md Law 2). Canonical write path moves that boundary into the Worker via Hyperdrive → Neon. Matt has authorized a hard cutover on write; Hindsight is unwired from the write path this phase, not shadow-verified.
- Add canonical Postgres schemas: `events`, `sessions`, `messages`, `captures`, `artifacts`, `documents`, `chunks`, `entities`, `claims`, `facts`, `edges`, `reviews`, `policies`, `recall_traces`, `projection_jobs`, `compiled_documents`
- Canonical DB adapter (over Hyperdrive) with typed query boundaries, tenant/scope filters, transaction support, encryption at HAETSAL boundary
- Epistemic memory classes: `raw_source | episode | observation | claim | fact | preference | procedure | compiled_view`
- Trust states: `evidence | inferred | user_confirmed | trusted_import | disputed | stale | superseded | rejected`
- Use policy: `can_use_as_evidence | can_use_as_instruction | requires_confirmation | do_not_inject_automatically`
- Provenance envelope on every write: source, timestamp, author/agent, model/runtime, confidence, scope, retention, agent_identity
- Agent-written memory defaults to `evidence` with `can_use_as_evidence` only. Promotion requires policy or review.
- **Sever Hindsight write path** at end of phase: `retainViaService`, `capture_memory`, ingest handlers, session summaries all route to canonical only. Hindsight retain calls removed; Hindsight compat bridge in `canonical-capture-pipeline.ts` deleted. Read path still Hindsight-backed until Phase 2 ships (temporary read-only asymmetry — acceptable because writes stop populating Hindsight so reads only serve historical data).
- **Gate:** all new writes land in canonical Postgres with full provenance envelope. Contract tests cover epistemic type + trust state + use policy. Verifier subagent (fresh context) audits Law 2 boundary in the new adapter and confirms no Hindsight write remains in code paths. Live smoke: `capture_memory` from an MCP client lands a row in canonical Postgres and returns a provenance-tagged receipt.

### Phase 2 — Retrieval Broker (hard cutover)
- Seven retrieval modes: `raw | lexical | semantic | graph | temporal | compiled | composed`
- Deterministic intent routing (GBrain pattern) with explicit caller override
- Title/alias/source-authority/scope/freshness/trust-state boosts
- Citations + evidence contract on every retrieval result
- Postgres FTS + pgvector for semantic (replaces Hindsight semantic path — hard cutover, not parallel)
- Postgres-native one-hop and two-hop graph traversal over canonical edges. **This is the only graph path in the mission — Graphiti is being removed in Phase 3.**
- Eval fixtures for named-thing retrieval, relationship queries, contradiction queries, hard negatives
- **Sever Hindsight read path** at end of phase: `canonical-semantic-recall.ts` no longer routes to Hindsight; `canonical-graph-query.ts` no longer reads Graphiti mappings. Both read from canonical Postgres + pgvector only.
- **Gate:** `search_memory(mode=...)` works through one stable surface, all seven modes. Composed mode assembles bundle with provenance. Live smoke: retrieve a memory written in Phase 1 via each mode. Fresh-context verifier confirms no Hindsight/Graphiti read remains in service code.

### Phase 3 — Hindsight + Graphiti Removal
Blocked until Phase 1 + Phase 2 gates green (write path canonical + read path canonical, live-smoke verified). Hindsight and Graphiti are already unwired from runtime by end of Phase 2 — this phase deletes the corpses and updates docs.
- **Data export first (G7):** dump Hindsight tenant memory to `R2:brain-artifacts/hindsight-export-<UTC-timestamp>/`, TMK-encrypted, indexed manifest. Do the same for Graphiti mappings if any local state exists.
- **Remove Hindsight code + config:** `HindsightContainer`, `HindsightWorkerContainer`, `HINDSIGHT`, `HINDSIGHT_WORKER` bindings, `hindsight/` directory (including Dockerfile), `cron/hindsight-*` files, `services/hindsight*.ts`, `services/canonical-hindsight-*.ts`, `services/bootstrap/hindsight-*.ts`, all Hindsight-related types in `src/types/env.ts`, `HINDSIGHT_DEDICATED_WORKERS_ENABLED` and related vars in `wrangler.toml`. Use codegraph `codegraph_impact` on each symbol before deletion.
- **Remove Graphiti code + config:** `GraphitiContainer` binding, `graphiti/` directory (including Dockerfile), `GRAPHITI_RUNTIME_MODE` var, any `services/*graphiti*.ts`, Graphiti references in `canonical-graph-query.ts`, `migrations/1018_graphiti_ingestion_projection.sql` disposition (keep as historical migration; no runtime read).
- **Migration Wrangler DO migrations:** `v2` (HindsightContainer), `v3` (HindsightWorkerContainer), `v4` (GraphitiContainer) require Wrangler DO deletion migration entries. Do not delete migration history retroactively — add new deletion migrations forward.
- **Update `ARCHITECTURE.md` Law 2** language: "canonical Postgres via Hyperdrive receives plaintext through HAETSAL's canonical DB adapter running inside the Worker" (replaces "Hindsight receives plaintext through its official API"). Update every other reference to Hindsight in `ARCHITECTURE.md`.
- **Update `.claude/governance.md`**: `T1 (Neon via Hindsight)` → `T1 (Neon via Hyperdrive)`. Remove Hindsight-specific escalation triggers.
- **Update `.claude/workflows/checkin.md`, `checkout.md`**: remove Hindsight-specific language.
- **Update `README.md`, `MANIFEST.md`** (via regen), `CONVENTIONS.md`, `LESSONS.md` (Hindsight lessons stay as historical; add "Post-Hindsight Migration" section).
- **Postflight checks added:** fail if `HindsightContainer`, `GraphitiContainer`, `HINDSIGHT*`, `GRAPHITI*` binding, or reference appears in `wrangler.toml` or `src/**` (excluding explicit migration-history docs and archived lessons).
- **Delete `@cloudflare/containers` dependency** from `package.json` if no other container remains. Verify with codegraph.
- **Gate:** demo clause 10 (Zero Hindsight) passes plus a Graphiti equivalent. Live smoke: worker starts cleanly, no HindsightContainer/GraphitiContainer DO classes registered, MCP tools respond, memory capture + recall work through canonical only, all seven retrieval modes return expected fixtures. Fresh-context verifier subagent runs a Law-2 audit against the post-removal codebase.

### Phase 4 — Sendblue iMessage Channel
Sendblue credentials + CF Access bypass are already in place (see Phase 0). The Free Tier phone number is a shared line with must-text-first, 24h reply window; automations (Phase 7) will only fire reliably if Matt has texted the brain in the prior 24h — call this out in Phase 7 lessons but do not attempt to work around it.
- `src/services/delivery/sendblue.ts` — outbound API client. Auth headers: `sb-api-key-id: env.SENDBLUE_API_KEY_ID`, `sb-api-secret-key: env.SENDBLUE_API_SECRET_KEY`. Base URL: `https://api.sendblue.co`. Primary send endpoint: `POST /api/send-message` with `{from_number: env.SENDBLUE_PHONE_NUMBER, number, content, media_url?, send_style?}`.
- `POST /webhooks/sendblue/:pathSecret` inbound route on the Worker. Session 5 correction requires the current `sb-signing-secret` header against `env.SENDBLUE_WEBHOOK_SIGNING_SECRET`; the path-secret comparison remains defense in depth. `to_number` must equal `env.SENDBLUE_PHONE_NUMBER`.
- Fold into existing `processInboundMessage` channel abstraction: `processInboundMessage(..., 'sendblue')`.
- Photo attachments (`media_url` in inbound webhook body) → download → R2 → vision-capable model → canonical capture with photo provenance (WS8 slice).
- **Register the webhook with Sendblue once the route is deployed to prod.** Command (Fable runs this at Phase 4 gate after prod deploy): `curl -X POST https://api.sendblue.co/api/account/webhooks -H "sb-api-key-id: $SENDBLUE_API_KEY_ID" -H "sb-api-secret-key: $SENDBLUE_API_SECRET_KEY" -H "Content-Type: application/json" -d '{"url":"https://haetsalos.specialdarksystems.com/webhooks/sendblue/'"$SENDBLUE_WEBHOOK_PATH_SECRET"'","type":"receive"}'` — or the CLI equivalent `sendblue webhooks set-receive <url>`. Verify with `GET /api/account/webhooks`.
- **Gate:** demo clauses 1 (iMessage inbound reply) and 8 (photo → memory) pass live. Matt texts the Sendblue number `+16452067656` from his iPhone, gets a real reply citing at least one specific Gmail thread and one calendar event within 15 seconds. Photo separately produces a captured memory with vision-extracted description.

### Phase 5 — Real Action Executors
Wire the stubs. Preserve authorization gate, HMAC, TOCTOU, undo.
- `act_send_message`: Gmail send + Sendblue send (first-party OAuth already encrypted in KV)
- `act_draft`: Gmail draft
- `act_search`: web search (Brave or similar first-party)
- `act_remind`: scheduled reminder via `this.schedule()`
- IRREVERSIBLE class actions use Workflow `waitForApproval` + `needsApproval` + fibers (not in-memory setTimeout)
- **Gate:** demo clause 2 (draft-first, real send) passes live. Each executor covered by a contract test that verifies capability class + TOCTOU + audit + auto-episodic.

### Phase 6 — Sub-Agent Spawn + Cancel/Retry
- Replace text-parsed `parseDelegation()` signal with native `subAgent()` spawn (Agents SDK current API)
- Per-spawn tool scoping (execution agent only sees tools it needs)
- Cancel + retry surface exposed to dashboard
- Heartbeat with 15-minute stuck-agent auto-fail (boop pattern)
- **Gate:** demo clause 6 (sub-agent visibility + cancel from dashboard) passes live.

### Phase 7 — User Automations
- Automation CRUD tools: `create_automation`, `list_automations`, `toggle_automation`, `delete_automation`
- Backed by Agents SDK `this.schedule()`, timezone-aware (default: America/Los_Angeles for Matt; user-settable)
- Each fires a scoped agent run
- Chat-to-automation: dispatcher recognizes automation intent from natural language ("every weekday 8am brief me")
- **Sendblue Free Tier caveat:** the shared-number plan only allows outbound within a 24h reply window of an inbound message. Automations that fire outside this window will be rejected by Sendblue. Do NOT try to work around this by rate-limit heuristics or the "typing indicator" endpoint. Instead: (a) if delivery attempt returns a Sendblue rejection, the automation logs a `skipped_outside_reply_window` event visible in the dashboard, does NOT retry, and Matt can text the brain to re-open the window; (b) surface this constraint in the automation manager UI (WS9) so Matt understands why an automation didn't fire; (c) note in Phase 7 lessons that upgrading to AI Agent plan removes this limit (Matt's call, not Fable's).
- **Gate:** demo clause 5 (automation created from chat, fires next window while reply window is open, delivers via iMessage) passes live.

### Phase 8 — Dream / Janitor / Consolidation Loop
Replaces Hindsight reflection. Implements as Workflows + Queues.
- Nightly cycle: ingest audit → entity extraction → edge extraction → contradiction detection → supersession detection → promotion review → compiled view refresh → retrieval health → gap discovery
- Outputs are reviewable proposals, not silent mutations
- Soft-delete/supersede; no hard delete by default
- Report-only mode ships first; promotion after review or strict deterministic thresholds ships second
- Morning brief includes previous night's dream cycle summary
- **Gate:** demo clause 9 (nightly dream cycle report in morning brief) passes live after one overnight run.

### Phase 9 — Sessions/Think Working Context
- Adopt Agents SDK Sessions API for active conversation state (already scoped in prior spec)
- Sessions non-canonical: flow session messages + close summaries into canonical Postgres as `evidence` events
- Think for structured reasoning; write reasoning traces AES-GCM encrypted (Law 2)
- Context assembly hooks pull prepared bundles from Phase 2 retrieval broker
- **Gate:** demo clauses 3 + 4 (Claude Code + Codex round-trip) pass live. External-client rollout (specs 9.3/9.4) works against the new Sessions-backed working context.

### Phase 10 — Compiled Markdown / Wiki Compiler
- Compiled Markdown views regenerable from canonical data
- Frontmatter with canonical IDs, source count, freshness, review status
- Compiled pages cite canonical sources; deletable + rebuildable
- Optional: browsable in Obsidian/Drive via export
- **Gate:** at least three compiled pages generated (per-person, per-project, per-topic) and readable in the dashboard.

### Phase 11 — Dashboard (Full 8 Panels)
- Memory browser + graph traversal
- Agent timeline w/ cancel-retry
- Consolidation reasoning viewer (dream cycle proposals + review inbox)
- Automations manager
- Connections/integrations manager (with tenant OAuth flows)
- Usage/cost dashboard (from AI Gateway metadata)
- Live agent status/heartbeat
- Retrieval-trace inspector (drill into any composed bundle: what was retrieved, why, with what authority)
- Served from same Worker via Workers Static Assets (Phase 4 of CF modernization plan)
- **Gate:** demo clause 7 (all 8 panels visible and functional). CF Access still enforced on dashboard routes.

### Phase 12 — Memory Decay + Multimodal
- Adaptive decay/forgetting pass: importance × access-count reinforcement, archive/prune thresholds
- Operates on metadata + encrypted refs; never decrypts content just to rank
- Multimodal image ingestion complete (was seeded in Phase 4)
- **Gate:** decay pass runs on a fixture, low-value items archived, high-value reinforced. Multimodal already covered by demo clause 8 in Phase 4.

### Phase 13 — Final Cutover, Ops Hardening, Full-Demo Smoke
- All secrets moved to CF Secrets Store bindings (per modernization plan Phase 5)
- Analytics Engine metadata-only, sampling explicit
- Rebuild procedures documented for pgvector, AI Search projection (if adopted), compiled Markdown
- Canary tests running on cron for: capture, recall, graph traversal, contradiction surfacing, compiled regen, session evidence capture
- Full demo runs end-to-end: all 10 clauses of §3 pass in a single verified session, screenshots + traces captured in `docs/lessons/phase-13-demo-verification.md`
- **Final gate:** the mission is not complete until clause 1-10 pass live in one session.

## 9. Phase Gate Protocol

At every phase gate, before proceeding:

1. **`npm run checkout` passes.** Wraps postflight + tests + manifest regen + spec lifecycle.
2. **Fresh-context verifier subagent** (not self-review) reviews the phase diff against the phase's acceptance criteria. Returns pass/fail with evidence citations: file:line, command output, or dashboard screenshot. **A bare "pass" is not acceptable — verdict must cite specific artifacts.**
3. **CF-docs verification pass** if the phase touched a CF primitive: subagent confirms usage matches current `developers.cloudflare.com` docs. Reports any deprecation or renamed API.
4. **Law-2 audit subagent** for any phase touching write/read paths, cron, or storage: audits that no new plaintext leaks into D1/KV/Analytics/logs/audit records.
5. **Live smoke** if the phase declares a live demo clause: run the smoke against the deployed worker, capture the trace, attach to the phase gate lessons file.
6. **Degenerate-output check on any structured-output subagent fan-out**: verify per-item byte size and field cardinality, not just schema validity. If a per-item output is <30% of the median size or missing >50% of expected fields, treat as degenerate and re-run with a different lens.
7. **Two verifier warnings** (either "fail" or "plausible but unverified") → fix, re-verify. Do not proceed on a warning.
8. **Update handoff docs**: `MANIFEST.md` (via checkout), `SESSION_LOG.md` entry, `docs/lessons/phase-N-*.md` for anything worth remembering.
9. **One commit** on `haetsal-mission`. Message format: `Phase N complete: <what shipped>`. Tag `phase-N-complete` for deploy phases.
10. **Prod deploys**: for phases that touch prod (Phases 3, 4, 5, 8, 11, 13), Fable prepares the deploy but pauses at the deploy step to write a deploy-readiness memo (`docs/lessons/phase-N-prod-deploy-memo.md`) and then proceeds with `wrangler deploy` against prod. Rollback tag `deploy-phase-N-prev` captured before deploy.

## 10. Stop Conditions

Pause the run and surface (do not guess) if any of these hit:

- **S1.** A change would violate any of the three Laws or require modifying them (as opposed to shifting a boundary within them, e.g., Phase 3's Law 2 language update, which is a boundary shift and is fine).
- **S2.** The same phase gate check fails twice in a row on one phase. Investigate root cause; do not brute-force.
- **S3.** A CF platform semantics claim in code disagrees with `developers.cloudflare.com` current docs.
- **S4.** A scope change would require a real architecture decision Matt didn't authorize (e.g., "actually we need a Graph DB after all", "actually we need Composio").
- **S5.** Missing credentials or access this run doesn't have: Sendblue not provisioned by Phase 4 gate, CF prod deploy token missing, Neon connection string wrong, Google OAuth for Gmail not configured.
- **S6.** A Law-2 audit subagent flags plaintext leaking into a disallowed store and the fix isn't obvious in <10 minutes.
- **S7.** The Hindsight data export in Phase 3 reveals data that would be lost by removal and has no canonical destination.
- **S8.** A prod deploy fails post-cutover and rollback tag doesn't restore green.
- **S9.** Any TMK/KEK/webhook secret / DB URL / OAuth token appears in a diff, log, test output, or commit — even by accident.

**Do NOT** stop for reversible actions that follow from this brief. Do not stop to ask "should I..." on work already scoped. Do not stop because a phase touches more files than expected.

## 11. Lessons System For This Run

`docs/lessons/` (create it) is the only memory dir this run writes to. Do NOT write to the global `~/.claude/projects/*/memory/` directory. One file per lesson, kebab-case:

- `docs/lessons/phase-<N>-<slug>.md` for phase-specific findings
- `docs/lessons/law-2-audit-<slug>.md` for Law 2 findings
- `docs/lessons/cf-docs-<primitive>.md` for CF platform notes worth keeping

Discipline: same signal-gate as product-memory. Stable + load-bearing + specific + non-redundant. If it fits in a commit message, put it there instead.

## 12. Effort & Delegation Routing

- **`effort: max`** — Phase-scoping decisions, architecture translation calls (e.g., how Hindsight's semantic recall becomes broker + pgvector + AI Search), Law-2 boundary shifts, ADR-worthy decisions.
- **`effort: high`** — Normal implementation, non-trivial test design, integration wiring, dream cycle logic, dashboard component architecture.
- **`effort: medium`** — Routine mechanical work within a bounded module (schema edits, wrangler config, doc updates).
- **Cheap-model subagents (Sonnet or Haiku) in parallel:**
  - Doc drafting/extraction (roadmap notes → phase lessons)
  - Fresh-context verifier passes at phase gates (Sonnet default; Opus for Phase 3/4 Law-2 audits specifically)
  - Cross-cutting grep/impact passes via codegraph
  - Deprecated-CF-API scans

Prefer async dispatch. Long-lived subagents that carry context across related subtasks save wall-clock. Use codegraph for every impact/rename/delete decision on Hindsight — grep-and-hope wastes hours.

## 13. Communication Style

- Outcome-first at gate boundaries. No mid-turn reasoning transcription.
- Never echo internal reasoning as response text (safety-classifier risk).
- If Matt reads a phase-gate report, he should be able to tell what shipped, what was verified, and where the artifacts are, in under 90 seconds.
- Commit messages describe what the phase shipped. Lessons files describe what was learned. `MANIFEST.md` describes what exists.
- No emojis in code or docs unless Matt requests them.

## 14. Non-Goals

Explicitly out of scope for this run:
- **N1.** Frontier reasoning tier via BYOK (Claude/OpenAI). Workers AI tiers only via AI Gateway.
- **N2.** Composio integration. Design integration layer to accept a Composio adapter later, but no Composio code this run.
- **N3.** Graphiti. Removed in Phase 3 alongside Hindsight. Postgres-native graph traversal is the only graph path.
- **N4.** Multi-tenant onboarding for other users. One tenant, Matt.
- **N5.** EU jurisdiction (D1_EU currently points at same DB; Phase 5+ TODO in wrangler is not this mission's problem).
- **N6.** Rewriting the app on top of `cloudflare-workspace-agent`.
- **N7.** New Containers other than any already deployed. Sandbox SDK stays deferred unless a concrete need emerges.
- **N8.** Voice channel. Text + image only.

## 15. Autonomous Operation Reminder

The user is not watching in real time. For reversible actions that follow from this brief, proceed without asking. Before ending a turn, check your last paragraph: if it is a plan, an analysis, a question, or a promise about work you have not done, do that work now. End your turn only at a committed phase gate or a stop condition.

You have ample context. Do not stop, summarize, or suggest a new session on account of context limits. Continue the work.

## 16. Kick-Off

Your first action: run `git status` and `git branch --show-current`. Verify you are on `haetsal-mission`; if not, switch. Verify `pre-haetsal-mission` tag exists on `master`. Then read `ARCHITECTURE.md`, `.claude/governance.md`, and the three planning docs in §6. Then begin Phase 0.

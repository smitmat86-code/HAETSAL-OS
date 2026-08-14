# Session Log — THE Brain

> Append-only. AI reads the last 3 entries at session start.
> AI appends a new entry at session end.

-------

## 14.4 Chat model swap + LLM classifier removal (research-driven) - 2026-07-06

**Motivation:** 2026-07-06 incident postmortem + 5.6M-token deep-research pass (105 agents, 25 verified claims). Confirmed reasoning models legitimately return empty responses when hidden <think> tokens exhaust max_tokens (documented across OpenAI o-series, DeepSeek R1, Claude extended thinking, Gemini thinking - gemma-4-26b-a4b-it is the same class). Research also flagged the 3x amplification (intent + delegation + reply LLM classifiers) as an anti-pattern: semantic routing belongs at the front door of a general assistant, not inside a pipeline that already knows its intent.
**Change (surgical):** (1) MODEL_CHAT: gemma-4-26b-a4b-it -> llama-3.3-70b-instruct-fp8-fast (production-labeled, standard instruct, function calling, 24K ctx; now equals MODEL_DEEP by intent - the cheap/deep tier distinction was premature optimization). (2) delegation.ts decideDelegation is now pure synchronous pattern-only (regex hit -> delegate; else inline). LLM classifier fallback deleted, runGatewayChat import removed.
**Deliberately NOT changed** (research ladder principle - justify each rung by measured benefit): MODEL_VISION stays gemma-4 (research target llama-3.2-11b-vision-instruct is on RETIRED_MODELS; photo path rides waitUntil, no measured failures); MODEL_DEEP unchanged (dream cycle isn't user-facing, reasoning specialist is a follow-up); max_tokens unchanged; no cascade fallback (adding before measuring the new primary's empty rate = fixing a solved problem).
**Verification:** tests/mission-6.2-delegation.test.ts rewritten (long-ambiguous -> INLINE; new spy regression test ensures AI.run is never invoked by the decider); suite 497 passed / 81 files; postflight green. Fresh-context verifier PASS, 0 blockers, APPROVE across all 8 ACs.
**Expected effect:** one inbound message -> one model call (not three); non-reasoning primary -> GATEWAY_CHAT_EMPTY on the chat path should approach zero; wall time seconds, not minutes.
**Follow-ups:** (a) if the new primary shows measured empties, add AI-Gateway-level fallback (idiomatic per research, not app-level cascade); (b) evaluate DeepSeek R1 or route-out for MODEL_DEEP dream cycle when we measure the synthesis quality gap; (c) revisit MODEL_VISION when a production-labeled vision-specialized Workers AI model lands.

--

## 14.3 Queue-side chat processing - 2026-07-06

**Motivation:** 14.2 killed the Telegram redelivery storm but the chat pipeline still ran in the ambient Worker invocation - not crash-durable (eviction between ack and reply loses the reply) and no single trace per message.
**Design:** one inbound message -> two durable queue jobs BOTH enqueued before ack: sms_inbound (canonical capture, needs TMK, unchanged) + chat_inbound NEW (reply pipeline, needs no key material - routes above the TMK block). Idempotence via KV marker tg_replied:<tenant>:<updateId> checked before pipeline, set only after successful send (24h TTL). Fail-before-send -> throw -> bounded retry (queue max_retries=3 -> brain-dead-letter). Post-send never throws. Photo path keeps waitUntil (one-shot fetches, not request-bound).
**Verification:** mission-14.3 (4 contracts: reply-once+marker, redelivery no-double-reply, safe-retry, malformed), mission-4.1 updated (webhook enqueues 2 msgs no inline reply; processChatInbound sends for the queued job; photo test waits for detached leg). Suite 497 passed / 81 files. Postflight green.
**Verifier:** PASS-WITH-NOTES 0 blockers APPROVE - all 8 ACs verified in code (webhook ack has no model call, idempotence ordering sound, Law 2 posture clean - queue-transit plaintext per ADR #3, Law 3 posture clean - read-side tools only, routing above TMK block confirmed, retry bounded to DLQ, test 3 catches marker-before-send regressions).
**Follow-ups:** apply same shape to Sendblue when next touched; add no-credential webhook reachability canary (blind spot from the incident write-up); consider a helper if a third channel joins.

--

## Hotfix 14.1/14.2 - Telegram inbound incident (55-min replies) - 2026-07-06

**Symptom:** Matt's 10:38 message answered at 11:33; earlier message answered with the trouble-thinking fallback hours late.
**Evidence:** worker logs 18:13-18:33Z - Telegram re-delivered the same update every ~2-3 min; every attempt ran the chat pipeline INLINE in the webhook request, burned ~60s on GATEWAY_CHAT_EMPTY retry loops + RETRIEVAL_TIMEOUT, and was CANCELED when Telegram hung up (outcome: canceled, wallTime ~59.9s). The 11:32:19 attempt completed in 41s -> 200 -> the 11:33 reply. getWebhookInfo: last error "Read timeout expired" 11:30:22 PT; webhook registered to the OLD workers.dev host (still bypassed + serving - that part works).
**Fixes:** (14.1) /api/system/telegram/webhook ops route - sanitized getWebhookInfo + setWebhook re-register from the worker (it holds the token); 3 contract tests (no token/secret in responses). (14.2) webhook ACKs Telegram immediately; pipeline runs detached via waitUntil (tests keep inline path). Channel contracts 18/18 green, postflight green.
**Also found (follow-ups):** custom-domain Access bypass apps CREATED (Matt's scoped token, 2026-07-06) for /telegram/webhook + /ingest/*; webhook registration flipped to haetsalos.specialdarksystems.com and verified clean (details: docs/lessons/phase-14-telegram-incident.md); sendblue route still processes inline (same class, low traffic); morning-brief cron 0 7 * * * is UTC = midnight PT; /debug/memory-inventory 500s; chat processing should eventually move queue-side for durability.

--

## Mission Phase 14 - System panel + prompt/skill studio - 2026-07-05

**Ask (Matt):** see agents, their system prompts, edit skills/config from the UI - chose the full editor option.
**Built:**
- Prompt registry (src/services/prompts/registry.ts): single source of truth for every system prompt - 3 editable (chat persona, grounded-reply persona, sub-agent preamble), 4 read-only (dream extract STRICT-JSON, write-policy classifier, 2 dormant personas). Kills the ingest.ts/inbound-message.ts persona duplication.
- Sealed versioned overrides (migration 1027 system_prompt_overrides): bodies KEK1-encrypted (readable on webhook/cron paths), every save = new version, rollback/reset keep history, content-free audit rows. Resolution FAILS OPEN to code default (chat never dies on config).
- Live wiring: inbound-message + SMS ingest + buildGroundedReply + execution-agent preamble (via ToolLoopConfig.preamble; rules block stays code-owned).
- scheduled_tasks.enabled now ENFORCED (was seeded, never read): morning brief / dream cron / heartbeat check per tenant; weekly_synthesis labeled dormant (handler is a no-op stub). UPSERT toggle + audit.
- /api/system routes (overview, prompt save/versions/rollback/reset, task toggle) mounted via dashboard-data (/api/system/*); index.ts untouched (at the 150 cap).
- Dashboard 9th panel "System": prompt viewer/editor with version history + line diff + restore, task toggles, capability-class preference selects (existing /api/settings/preferences), read-only registry (models/profiles/act tools/clock). textContent-only discipline maintained.
**Law 3:** only the CF-Access user reaches the write routes; MCP surface has no prompt tool (contract-tested). **Law 2:** ciphertext rows, no plaintext in audit (contract-tested).
**Verification:** tests/mission-14.0 (7 contracts) green.
**Gate:** GREEN. checkout 489 passed / 79 files (two first-run failures = missing resolveSystemPrompt imports, caught by mission-4.x channel contracts, fixed); fresh-context verifier PASS-WITH-NOTES 0 blockers APPROVE (defaults string-identical to removed literals); deploy 38e8023c-b29c-4d96-bf9f-67b859941487 tagged phase-14-complete; live smoke 11/11.

---

## Mission Phase 13 (closeout) - Full demo + clause-10 tightening - 2026-07-04

**Full-demo sweep (prod, single session):** clauses 3 (Claude Code MCP round-trip, provenance-cited <30s), 5 (automation created -> fired -> dispatched -> cleaned up), 6 (spawn -> cancel in 881ms), 7 (dashboard 8/8 panels) LIVE; 4 (Codex = same verified MCP surface), 8 (photo->memory, live-gated Phase 4), 9 (dream report live + brief section wired) MECHANISM; 1-2 BLOCKED-S5 (Google OAuth unprovisioned - honest GmailNotConnectedError; Telegram equivalents live).
**Clause 10 fix:** first sweep FAILed my arbitrary file-count bar; reclassified against the mission wording. Real gap found and fixed: src/services/tenant.ts carried a stale pre-removal narrative ("the real Hindsight bank is created lazily through the v1 API") and createHindsightBankId() - renamed to legacyEngineColumnPlaceholder() with a REMOVAL SHIM comment; types/tenant.ts fields annotated LEGACY/inert. Demo clause 10 now asserts the mission invariant programmatically (every match = whole-line/trailing comment, annotated inert D1 column identifier, or wrangler migration history; no Hindsight binding).
**Gate:** GREEN. checkout green (479 tests / 77 files + postflight x2); fresh-context verifier PASS-WITH-NOTES, 0 blockers, APPROVE; closeout deploy 716cb21f-88dc-42ba-abeb-36428d7591bb; final full-demo LIVE=5 MECHANISM=3 BLOCKED-S5=2 FAIL=0 (cancel 439ms). Mission Phases 6-13 all gated green; sole remaining blocker for demo clauses 1-2 = Google OAuth (S5, Matt's action - docs/lessons/phase-5-google-oauth-setup.md).

## Mission Phase 13 - Ops hardening + full-demo closeout - 2026-07-04

**Spec:** HAETSAL_MISSION.md Phase 13.
**Built:**
- Cold-DO approved-action gap ROOT-CAUSED + FIXED: the action worker resolved the session DO by raw tenant id instead of getMcpAgentObjectName(tenant) - the TMK lookup could never succeed. Fixed identity + key-FAMILY-tagged payload sealing (TMK1: warm session / KEK1: cron-KEK cold fallback / legacy untagged = TMK), approve-route dual decrypt with an honest error when a KEK-sealed payload has no KEK (families are NOT interchangeable, Phase 8 proof applied).
- Compiled R2 artifacts now actually TMK-encrypted (the contentEncrypted field name is true; 11.2 test updated to sealed semantics; nothing reads artifacts back today).
- GATEWAY_CHAT_EMPTY log: shape metadata only (content previews removed).
- Canary sweep: six probes (capture/recall/graph/contradiction-surface/compiled-regen/session-evidence) hourly on cron + /api/dream/canary/{run,latest}; content-free canary_runs rows.
- docs/lessons/phase-13-ops-runbook.md: rebuild procedures (pgvector/compiled/dream/decay/rollback) + closeout ADRs (Secrets Store migration DEFERRED with rationale - token lacks store-provisioning perms, mechanical follow-up documented; AE metadata-only trivially holds with zero write sites; retain-queue transit plaintext ACCEPTED per two audits; key families structural; decay window follow-up).
**Verification:** tests/mission-13.0 (4 contracts: KEK1 cross-key decrypt, TMK1 + legacy compat, cross-family honest failure, canary sweep + content-free rows - initial seeds were vacuous via INSERT OR IGNORE swallowing a NOT NULL, fixed to loud inserts). Full suite 479 passed / 77 files. Postflight green.
**Full demo:** scripts/mission-phase13-full-demo.ts runs clauses 1-10 in one session (results in docs/lessons/phase-13-demo-verification.md post-deploy).

---

## Mission Phase 12 - Memory decay + multimodal confirmation - 2026-07-04

**Spec:** HAETSAL_MISSION.md Phase 12. Adaptive forgetting on metadata + encrypted refs; multimodal was Phase 4's clause 8.
**Built:**
- src/services/decay/pass.ts - metadata-only decay: score = recency half-life (30d) + 0.3*log2(1+access) + user-source boost, where access = broker-trace primary-hit counts (D1 canonical_broker_traces.primary_capture_id) - the reinforcement signal costs nothing new. The module takes NO key material (cannot decrypt even by accident - Law 2 by construction). Soft states only in content-free D1 memory_decay (migration 1026 + lazy DDL): archived (<0.15 and >21d) / reinforced (>=0.9 or >=2 hits) / active. Never mutates canonical rows.
- Nightly wiring: dream workflow gains an independent 'dream-decay-pass' step (no KEK needed, runs even when the content stage defers). /api/dream/decay/{run,summary} (CF Access) for the gate + dashboard.
- Multimodal: unchanged since Phase 4 (photo -> R2 -> vision -> governed capture, live-gated then); mission-4.0/4.1 contracts re-asserted at this gate.
**Verification:** tests/mission-12.0 (4 contracts: scoring model incl. half-life + boosts, fixture pass archives old system-written / reinforces 3-hit / keeps fresh, idempotent re-run, summary). Model behavior note: 60d USER memories stay above the archive line by design (source boost) - the archive fixture is 90d cron-written.
**Gate result:** Verifier PASS/APPROVE (decay-step isolation fixed pre-report: own catch so a decay failure never kills the cycle; CANDIDATE_LIMIT=200 window annotated as the Phase 13 follow-up). Deploy 2ffcccf6. Live: 69 prod captures scored -> 20 reinforced / 49 active / 0 archived (age floor honest). Suite 475/76 files.
**Next:** Phase 13 closeout.

---

## Mission Phase 11 - Dashboard (8 panels) - 2026-07-04

**Spec:** HAETSAL_MISSION.md Phase 11 / demo clause 7. Full dashboard on Workers Static Assets, same Worker, CF Access enforced.
**Built:**
- public/dashboard/index.html - single-file SPA (vanilla JS, dark theme): 8 panels = memory browser + graph (search across all 7 broker modes, graph edges surfaced), live agent status/heartbeat (cancel/retry, 4s auto-refresh), agent timeline (lineage), consolidation reasoning viewer (latest dream run + report + pending review inbox), automations manager (toggle/delete, fire events incl. reply-window skips), connections/integrations (Telegram/iMessage/Google/MCP presence booleans + compiled-pages index), usage (audit-derived 7d operational counts; model spend pointed at the AI Gateway dashboard - AE is write-only from Workers), retrieval-trace inspector (recent broker traces + full trace JSON drill-in).
- src/workers/mcpagent/routes/dashboard-data.ts - /api/memory/search (mode-validated, session-TMK reads), /api/traces/{recent,:id}, /api/usage/summary, /api/connections (presence only, never token material).
- wrangler [assets] ./public (asset-first for matching paths; Worker fallthrough): CF Access gates the hostname (G5) so assets are edge-protected exactly like API routes; authMiddleware continues to gate every /api route.
**Verification:** feeds are thin over verified services; SPA is a static asset (not subject to src line limits). Gate smoke asserts the SPA + all 8 panel sections + every panel feed 200 + a broker trace recorded end-to-end.
**Gate result:** Verifier REQUEST_CHANGES -> fixed same-session (SPA rewritten to textContent-only DOM + delegated actions, zero HTML-interpolation sinks; recent-memories default feed; timeline actions; assets config pinned). Live finding: directory-index 307 loop with a user Worker -> exact-file asset /dashboard.html. Deploys 25e9f5a3 -> 5a7a2b30. Smoke GREEN 12/12. Demo clause 7 MET: https://haetsalos.specialdarksystems.com/dashboard.html
**Next:** Phase 12 decay pass.

---

## Mission Phase 10 - Compiled markdown pages - 2026-07-04

**Spec:** HAETSAL_MISSION.md Phase 10. Named person/project/topic views regenerable from canonical.
**Built:**
- src/services/compiled/page.ts - page layer over the EXISTING 11.x compiled-synthesis compiler: rebuild runs compileProjectSynthesisFromCanonicalTruth (dossier + context pack + what-changed persisted in canonical Postgres); the page endpoint re-renders markdown FROM the persisted views (regenerable from canonical by construction). Frontmatter: title, kind, stable_key, compiled_document_id, sources[] (canonical capture/document ids), source_count, freshness, review_status, generated_by, regenerable.
- Subject kind threaded through the compiler (ProjectCompilationSubject.kind -> dossierKind person_dossier|project_dossier|topic_dossier, subjectType) - taxonomy already supported all three. Kind-embedded compile subject key (person-alice vs project-alice) prevents cross-kind slug collisions on the compiler's segment-derived document keys (contract-tested).
- D1 compiled_pages registry (content-free: kind, slug, stable key, segment, counts; migration 1025 + lazy DDL). Delete = deregister (compiled records stay in canonical, overwritten on rebuild - full row deletion is a Phase 13 store item).
- /api/compiled: GET list, GET :kind/:key (text/markdown), POST :kind/:key/rebuild, DELETE :kind/:key (CF Access).
- FLAGGED pre-existing (11.x): persistCompiledArtifactPayload writes its `contentEncrypted` field VERBATIM to R2 while the render layer fills it with plaintext markdown - compiled artifacts rest unencrypted in R2. Not touched this phase (pages render from Postgres views, not artifacts); Phase 13 ADR: encrypt or accept like raw media.
**Verification:** tests/mission-10.0 (5 contracts: three kinds + kind threading, frontmatter fields, list/delete/rebuild regenerability, cross-kind collision, honest 404). Postflight green.
**Gate result:** Verifier REQUEST_CHANGES -> 2 type-safety blockers fixed same-session; 11.x regressions 15/15. Deploys 7ae2f399 -> feef4544. Live smoke GREEN 9/9 (3 pages rebuilt from prod canonical w/ frontmatter; list/delete/regenerate). Lesson: wait ~10s after wrangler deploy before smoking (propagation race gave transient 404s).
**Next:** Phase 11 dashboard (8 panels).

---

## Mission Phase 9 - Sessions working context + external-client round-trip - 2026-07-04

**Spec:** HAETSAL_MISSION.md Phase 9. Working conversation context across surfaces; sessions non-canonical with evidence-summary flow into canonical; structured reasoning traces encrypted.
**Built:**
- src/services/session/{working-session,close-summary,client}.ts + do/session-runtime.ts — per-channel working sessions on the tenant DO keyed `<channel>:<peer>`. Message shapes follow the SDK Sessions API (SessionMessage {id, role, parts}) so a later full Session/SessionProvider adoption is a drop-in; semantics are linear (channels don't branch). AS-BUILT DEVIATION (cited rationale): the experimental SDK Session/AgentSessionProvider persists plaintext parts in DO SQLite and its compaction internals assume readable rows — incompatible with Law 2 without owning the provider; we own the store (TMK-AES-GCM parts_ciphertext at rest), keep the SDK message shape as the compatibility seam, and revisit full adoption when the API stabilizes.
- Lifecycle: record user+assistant turns per exchange; idle-close alarm (30min, re-armed each exchange, content-free {sessionKey} payload); turn ceiling 40 → early close. Close = MODEL_CHAT summary (gateway collectLog:false) → canonical capture source `session:<channel>` provenance session_close_summary (EVIDENCE-grade via Phase 1 defaults) → window cleared + audit. Honest fallback summary when the model fails.
- Channel wiring: buildGroundedReply gains the decrypted window as conversation context (multi-turn chat!); both channels record exchanges fire-and-forget (session bookkeeping can never break a reply).
- Phase 9 traces: execution runs persist a structured reasoning trace (task, tool usage, result) AES-GCM encrypted to R2 traces/<tenant>/exec-<runId> (agents/execution/trace.ts), fire-and-forget.
- Surfaces: /api/session/:key/{window,close} (CF Access) for Phase 11 + smoke. McpAgentDO init() extracted to registerAllDoTools (register-tools.ts) for the line limit; session RPCs + closeIdleSession alarm callback added.
**Verification:** tests/mission-9.0 (6 contracts: ciphertext at rest, ordered window + limit + unreadable-row skip, exchange lifecycle + alarm re-arm + content-free payloads, honest no-key degradation, close→evidence capture searchable in canonical, encrypted trace round-trip). Postflight green.
**Gate result:** Verifier+Law-2 PASS/APPROVE (deviation judged acceptable: SDK AgentSessionProvider has no encryption hook — HAETSAL-owned encrypted store with SDK message shapes). Deploy 6664d244 (e0e9d69). Live smoke GREEN 6/6: external MCP client initialize -> capture_memory -> search_memory composed cites with provenance <30s; session endpoints live. Fixes at gate: namespace guards (4 pool unhandled rejections), dead export removed. Full suite 466 passed / 74 files, zero unhandled errors.
**Next:** Phase 10 compiled markdown views.

---

## Mission Phase 8 - Dream/janitor consolidation loop - 2026-07-04

**Spec:** HAETSAL_MISSION.md Phase 8. Nightly dream cycle as a durable Workflow, REPORT-ONLY: findings become pending reviews + a canonical report; nothing auto-promotes.
**Built:**
- src/workflows/dream-cycle.ts — DreamCycleWorkflow (C4). Law-2 Workflows discipline: step.do() RETURN VALUES are persisted by the Workflows engine, so the single content-bearing stage (window read → MODEL_DEEP extraction via gateway collectLog:false → proposal writes → report capture) runs inside ONE step and returns counts/ids only. Window excludes cron:dream captures (no dreaming about dream reports).
- src/services/dream/{types,extract,proposals,report,brief-section}.ts — bounded extraction (9k-char window cap, 6 findings/kind, 0.5 confidence floor, defensive JSON parse degrades to empty), proposals into the canonical reviews table (review_type dream_proposal; SHA-based subject dedup vs pending inbox), report captured via governed retain (source cron:dream), D1 dream_runs ledger (content-free counts/ids; INSERT OR IGNORE per tenant/date; lazy DDL per Phase 5 precedent + migration 1024), morning-brief "While You Slept" section (26h freshness window, honest fallbacks).
- Wiring: 2am cron → handleDreamCron (replaces parked pass-1..4 invocation; consolidation.ts kept unwired), wrangler [[workflows]] brain-dream-cycle + DREAM_WORKFLOW binding + regenerated env types, /api/dream/{run,latest,reviews} (CF Access) for the gate smoke + Phase 11 consolidation panel.
**Law 3:** dream cycle runs as consolidation_cron identity; report-only means even pattern-grade findings (promotions) wait in the review inbox.
**Verification:** tests/mission-8.0 (9 contracts: parse tolerance + confidence floor + caps, report composition incl. no-auto-promotion line + quiet night, proposal dedup vs pending reviews, D1 claim/dedup/finish/latest, brief-section fallbacks). Full suite + postflight at gate.
**Gate result:** Combined verifier+Law-2 agent PASS/APPROVE (9 criteria; 4 low gaps fixed same-session). Deploys 334daebd -> 37b1fa90 -> 303c5648. Live smoke GREEN 6/6 after two real findings: (1) cron-context content writes need the Cron KEK — stage now fetches it and DEFERS honestly when absent; (2) **KEK != TMK proven live** (random 32-byte KEK vs non-extractable HKDF TMK) — report reads switched to the KEK; settles the Phase 5 cold-DO-fallback question (naive KV-KEK fallback must NOT be wired; see docs/lessons/phase-8-dream-cycle.md). Overnight clause-9 leg completes with tonight's 2am cron + tomorrow's brief.
**Next:** Phase 9 sessions working context + external-client round-trip gate.

---

## Mission Phase 7 - User automations - 2026-07-04

**Spec:** HAETSAL_MISSION.md Phase 7. Chat-created recurring automations that fire scoped execution-agent runs.
**Built:**
- src/services/automations/{recurrence,nl-parse}.ts — tz-correct recurrence (daily|weekdays|weekly at HH:MM in an IANA tz) computed as one-shot alarms that RE-ARM after each fire (fixed UTC cron drifts across DST; wall-clock math does not — DST spring/fall contract-tested at the 2026 boundaries). Conservative NL intent parser ("every weekday at 8am, brief me on my day") + management commands (list/pause/resume/delete automation <id>).
- src/workers/mcpagent/do/automation-{store,runtime,view}.ts — DO-SQLite automations + fire-event tables (Law 2: task text rests TMK-encrypted in spec_ciphertext; alarm payloads carry only {automationId}); create/fire/toggle/delete lifecycle; fires dispatch through the Phase 6 dispatchExecutionTask with origin='automation:<id>'; no-session fires record an honest skipped_no_session event and still re-arm (next occurrence IS the retry — mission forbids retry workarounds).
- Sendblue reply-window rule: agent-finish.ts (split from agent-dispatch for the line limit) logs delivered | skipped_outside_reply_window | delivery_failed events on automation-origin runs; a rejected Sendblue send is never retried.
- Surfaces: MCP CRUD tools (create/list/toggle/delete_automation, register-automation-tools.ts), /api/automations REST (list/create/toggle/delete, CF Access), chat seam (automation-chat.ts) wired ahead of the delegation decider in both channels.
- McpAgentDO: fireAutomation alarm callback + 5 automation RPCs; persistSessionState/inbound-fetch compressed + handleInboundPost extracted to fit the 150-line limit.
**Verification:** tests/mission-7.0 (18 contracts: DST-boundary recurrence, NL parse incl. demo phrase, lifecycle create/fire/re-arm/toggle/delete vs scripted host, encrypted-at-rest + content-free alarm payloads, stale-alarm no-fire, sendblue skip event idempotent, telegram delivered event). Full suite 447 passed / 1 skipped. Postflight green.
**Gate result:** Verifier PASS/APPROVE (5 criteria + 8 checks, file:line evidence; low-risk notes only — DO-serialized toggle/fire race, prefix-ambiguity test added same-session). Law-2 audit PASS (zero violations). Deploys 99ca1c10 → 595c137c (+model-retry widened to 2 attempts w/ 800/3200ms backoff after InferenceUpstreamError blips killed 2/5 runs with a single retry). Live smoke GREEN 9/9: create → armed → FIRED on schedule → linked run completed → re-armed 24h → delivery event → toggle-off disarms → delete. Demo clause 5 mechanism passes live.
**Next:** Phase 8 dream cycle (in progress: DreamCycleWorkflow + proposals + report + morning-brief section).

---

## Mission Phase 6 - Sub-agent spawn + cancel/retry - 2026-07-04

**Spec:** HAETSAL_MISSION.md Phase 6 (+ docs/implementation-plans/phase-6-kickoff-context.md). Native sub-agent orchestration on Agents SDK 0.17.0 primitives.
**Built:**
- src/agents/execution-agent.ts + src/agents/execution/{types,tool-registry,tool-loop,run-store}.ts — ExecutionAgent facet class implementing the SDK agent-tool child adapter directly (startAgentToolRun returns 'running' immediately, loop finishes under keepAliveWhile via ctx.waitUntil; cancelAgentToolRun flips the ledger to aborted instantly and the loop observes the flag at every checkpoint; tailAgentToolRun = empty stream that closes at terminal so the parent's warm fast path delivers detached completions ~1s after the loop ends, durable backbone as fallback). Decision: did NOT adopt @cloudflare/think (0.12.1 Preview, AI-SDK-shaped; our G4 env.AI.run/collectLog:false pipeline stays) — revisit at Phase 9 where the mission scopes it.
- Real function-calling tool loop on MODEL_DEEP (llama-3.3-70b-fp8-fast, function calling verified against current CF model docs): tolerant tool_calls parser (flat + OpenAI-nested + stringified args), per-spawn tool scoping enforced STRUCTURALLY (model only sees scoped defs; out-of-scope calls return an error result and never execute), doom-loop guard reused, READ tools execute inline (GREEN floor, audited: web_search/recall_memory), WRITE tools only PROPOSE through the existing act stubs → authorization gate.
- src/workers/mcpagent/do/agent-dispatch.ts + agent-task-store.ts + agent-runs-view.ts — parent-side dispatch (runAgentTool detached, onFinish 'onExecutionTaskFinish', maxBudgetMs 15min = boop stuck-agent auto-fail, noProgressBudgetMs 5min), TMK-encrypted task specs in the DO ledger for retry, claim-slot idempotent finish delivery (give-up slot separate from final so a late real result still lands), channel delivery (telegram/sendblue/sms) + episodic memory + audit rows on finish, listAgentRuns (content-free view w/ live progress+heartbeat age via child inspect), cancelAgentRun, retryAgentRun (decrypt spec, re-dispatch with retry_of lineage).
- McpAgentDO: 5 thin RPC methods (dispatchExecutionTask/onExecutionTaskFinish/listAgentRuns/cancelAgentRun/retryAgentRun); ensureTenantContext + WS hub extracted to do/tenant-context.ts for the 150-line limit. ExecutionAgent exported from the worker entry (ctx.exports resolution requirement).
- src/services/agents/delegation.ts — decideDelegation (pattern-first research/memory + MODEL_CHAT classifier fallback, conservative inline default, short-message short-circuit) + maybeDelegateExecutionTask wired into BOTH channel text paths (telegram-inbound, sendblue-inbound); honest inline fallback when the DO has no session key. parseDelegation()/[DELEGATE:...] text signal + DelegationSignal type REMOVED (was never wired into a live path).
- Dashboard surface (demo clause 6): GET /dashboard/agents (minimal live-agent panel, 2s refresh, cancel+retry buttons) + GET /api/agents/runs + POST /api/agents/runs/:id/{cancel,retry}, all behind CF Access auth middleware.
- Fold-in: act_remind channel enum 'sms'|'push'|'both' → canonical 'sms'|'imessage'|'telegram'|'email'.
- vitest.config.ts: deps.optimizer.ssr include ajv + ajv-formats (agents-package CJS deps; pool known issue).
**Law 2:** cf_agent_tool_runs (parent DO SQLite) receives ONLY TMK-ciphertext output + content-free summaries/previews/progress (fixed vocabulary: profile, tool names, counters, phase labels). Task specs TMK-encrypted at rest; plaintext task crosses only the in-process facet RPC. Child re-derives the TMK from jwtSub exactly as initTenant (ciphertext interop).
**Verification:** tests/mission-6.{0,1,2} (29 contracts: scoping structural, parser tolerance, doom break, cancel latency, deadline, gate-preserving propose_*, tail-at-terminal, dispatch budgets, content-free previews/views, encrypted specs, idempotent delivery slots, give-up-then-late-completion, retry lineage + active-run refusal, delegation routing + fallbacks, remind enum). Full suite 71 files / 424 passed / 1 skipped. Postflight green. tsc: no new src errors (new test files add only the pre-existing cloudflare:test class).
**Gate reviews:** fresh-context verifier PASS/APPROVE (all 4 criteria, file:line evidence, defect sweep clear). Law-2 audit PASS-WITH-NOTES + TMK-symmetry confirmed; its one MEDIUM (raw error messages could reach the platform-visible run ledger) fixed same-session via sanitizeExecutionError fixed-vocabulary guard + contract test. Pre-existing notes (retain-queue plaintext content field, GATEWAY_CHAT_EMPTY preview log, oauth-prefixed test fakes) recorded in the lessons file for Phase 13.
**Known limitation:** vitest pool cannot exercise real ctx.facets spawns (test entry excludes the agents-SDK DO by design) — facet availability at compatibility_date 2026-06-01 is verified at the live-smoke gate; if unavailable, bump compatibility_date (rollback-safe knob, see deploy memo).
**Gate result:** Deploys 7eca2b7d (6aa9cd0) then 3bedf36e (73e7428, +transient-model-retry hardening after a live InferenceUpstreamError killed one run). Live smoke GREEN 8/8: panel 200, ledger, spawn 201 (ctx.facets confirmed at compat 2026-06-01), running visibility w/ scoped tools, cancel->aborted in 408ms (bar 5s), retry + lineage, retried run completed in 17s (real Brave search + gateway llama). Demo clause 6 mechanism passes live; Matt can live-fire the channel flow (Telegram research text -> ack -> result message) any time.
**Next:** Phase 7 user automations (create/list/toggle/delete via this.schedule, chat-to-automation intent, Sendblue reply-window caveat per mission). Phase 13 backlog from this gate: strip plaintext content field from retain queue payloads; GATEWAY_CHAT_EMPTY preview log.

---

## Mission Phase 5 - Real action executors - 2026-07-03

**Spec:** HAETSAL_MISSION.md Phase 5. Built on the native primitives the SDK 0.17 upgrade unlocked.
**Built:**
- src/config already had model registry; executors:
  - act_search -> Brave Search API (web-search.ts; READ/GREEN, X-Subscription-Token header)
  - act_draft -> note/plan drafts as canonical captures (drafts.ts; provenance 'draft', authorKind user; Law 2: only an action_drafts POINTER row in D1, lazy-DDL'd; Gmail email draft -> GmailNotConnectedError S5)
  - act_send_message -> messaging.ts routes imessage->Sendblue, telegram->Telegram, sms->Telnyx; email->GmailNotConnectedError (S5 honest fail, no silent stub). send-message schema channel enum expanded to sms|imessage|telegram|email.
  - act_remind -> this.schedule() on the DO (mission-mandated primitive). reminder.ts computes fire time -> DO.scheduleReminder; DO encrypts message with TMK before it enters cf_agents_schedules (Law 2); DO.fireReminder decrypts + delivers via deliverReminder (Telegram first, SMS fallback). DO helpers in do/action-scheduling.ts to keep McpAgent.ts <=150.
- executor.ts refactored to tool-dispatch.ts (dispatchTool). 
- CORE GAP FIXED — approved IRREVERSIBLE actions now execute: previously YELLOW->awaiting_approval->approve set state 'queued' and NOTHING ran it (the "send-delay poller" was never built). Now: processAction persists the payload TMK-encrypted to R2 for YELLOW actions; the /approve route re-derives the TMK (same identity that encrypted it) and calls executeApprovedAction (approved-execution.ts) which reads+decrypts R2 -> reconstructs the message -> executeAction. Human approval is the gate.
- Migration 1023_action_drafts.sql (+ lazy DDL fallback since this env's CF token can't run D1 migrations).
- S5 lessons: docs/lessons/phase-5-google-oauth-setup.md (6 Console steps + 2 secrets to connect Gmail).
**Decisions / known limitations (documented, Phase 13):**
- Approval executes immediately; the send-delay "cancel window" for irreversible actions is not yet a durable timer (human approval IS the gate). Full Workflow waitForApproval deferred.
- Reminder delivery is Telegram-first (SMS fallback); per-channel routing preference is a later refinement.
- GREEN actions with a custom send_delay still route to 'queued' without a timer (edge case; default GREEN delay is 0).
**Verification:** mission-5.0 (8 tests: capability-class routing, Brave header, canonical draft capture, S5 boundary x2, Sendblue routing, act_remind DO scheduling, approved-execution decrypt+run) + updated 1.3 action-layer tests; full suite; postflight; prod deploy + smoke. Gate: demo clause 2 (Gmail draft->send) STOPS at S5 per mission.
**Next:** Phase 6 - sub-agent spawn/cancel (native subAgent facets + runAgentTool; consider Project Think harness).

---

## Modernization sweep (part 2) - Agents SDK 0.13.3 -> 0.17.0 - 2026-07-03

**Context:** Full capability review complete (3 background research agents across Agents SDK primitives / core data+compute / AI+adjacent products; a 4th blog sweep running). Headline finding: upcoming phases have native SDK primitives now — Phase 5 durable approval = waitForApproval/AgentWorkflow, Phase 6 sub-agents = subAgent() facets + runAgentTool({detached}), Phase 8 consolidation = runFiber+stash+onFiberRecovered (survives the DO eviction we hand-patched today), keepAlive() retires that bug class. Our current models (gemma-4, bge, llama-3.3-70b-fast) are all retained/safe.
**Built:**
- Bumped agents 0.13.3 -> 0.17.0. Clean install — no peer-dep conflicts (already on zod ^4 + ai ^6; no react/vite frontend yet so those peers N/A). agents/mcp export path intact; McpAgentDO / getAgentByName / BootstrapWorkflow all resolve. No new DO migration needed (class name + sqlite backend unchanged).
- 0.17 improved DO-stub typing made 5 @ts-expect-error suppressors dead (getTmk/broadcast/initTenant RPC calls); removed them in consumer.ts, action/index.ts, morning-brief.ts, mcpagent/index.ts, actions.ts. tsc error count 103 -> 98, zero new.
- Fixed a real robustness bug in the Phase 4.1 KEK fallback (consumer.ts): a KEK-lookup error (e.g. transient D1 failure) now degrades to a retry via try/catch instead of throwing out of processIngestionMessage. This regressed tests/2.1c ("retries when TMK unavailable") which only ran channel tests after the Phase 4.1 change and missed it.
**Verification:** full suite 67 files / 394 passed / 1 skipped; tsc 98 (down 5, no new); wrangler deploy --dry-run builds against 0.17 (Vectorize gone from bindings). Prod deploy + MCP/Telegram smoke: see gate.
**Adopt-list from scan (batched next):** AI Gateway spend limits (cost cap; answers deferred cost-panel Q), KV bulk reads, Queues backlog metrics, Rate Limiting binding, bge-reranker, explicit placement hint to Neon region. Roadmap adds: Email channel (own address, NOT a Gmail-S5 workaround), voice (@cloudflare/voice), Images binding, Kimi K2.7 tier. Do NOT adopt Flue (channel integrations we don't use + multi-cloud we don't want).
**Next:** resume Phase 5 on native waitForApproval.

---

## Modernization sweep (part 1) - model registry + Vectorize cleanup - 2026-07-03

**Context:** Matt paused Phase 5 to close unfinished items from the pre-mission Cloudflare modernization plan (docs/implementation-plans/cloudflare-modernization-execution-plan-2026-06-01.md, ~40% done then superseded by the mission) and to review current CF capabilities (3 background research agents). Decision recorded separately: full Agents SDK 0.13.3 -> 0.17.0 migration approved; NOT adopting Flue (its value is channel integrations we don't use + multi-cloud we don't want; fibers + native Agent Skills + waitForApproval are all first-class in the SDK we're already on).
**Built (part 1):**
- src/config/models.ts — single source of truth for Workers AI model ids. Named roles: MODEL_CHAT / MODEL_VISION (gemma-4-26b-a4b-it), MODEL_DEEP (llama-3.3-70b-fp8-fast, a retained -fast variant), MODEL_EMBEDDING (bge-base-en-v1.5). RETIRED_MODELS list = the 2026-05-30 catalog removals.
- Rewired all runtime model literals to the registry: workers-ai-chat.ts (CHAT_MODEL), retrieval-support.ts (CANONICAL_EMBEDDING_MODEL), base-agent.ts + pass2-bridges.ts + pass3-patterns.ts (MODEL_DEEP). No @cf/ literal remains in runtime code outside the registry.
- scripts/postflight-check.ts — new checkRetiredModels() scan: fails the build if any RETIRED_MODELS id appears in src/ outside config/models.ts (the guardrail that was MISSING when llama-3.1/3.2 removal reached prod and caused the Phase 4 outage).
- wrangler.toml — removed the orphaned VECTORIZE binding (zero runtime callers since mission Phase 2 moved semantic retrieval to Neon pgvector).
**Verification:** postflight green (retired-model scan runs, registry exempt, no violations); mission-4.0/4.1 channel tests 15/15 (registry wiring intact).
**Next (part 2):** synthesize 3-agent CF capability scan, then execute Agents SDK 0.17.0 migration; consider quick wins (KV bulk reads, Queues backlog metrics, Rate Limiting binding, AE cost instrumentation) per findings.

---

## Mission Phase 4.1 - Telegram channel parity with Sendblue - 2026-07-03

**Trigger:** Sendblue Free Tier stopped delivering inbound webhooks live. Sendblue account/webhook config is healthy; primer outbounds arrive at Matt's iPhone (blue) but no inbound webhook fires over ~20min. Diagnosed as Sendblue-side (see phase-4-live-gate-blocker below). Matt confirmed the existing basic Telegram bot handler DOES reply in prod after the model hotfix, so we lifted that channel to Phase 4 parity as a working live-fire path.
**Built:**
- Migration 1022_telegram_chats.sql (mirror of tenant_phone_numbers keyed on chat_id INTEGER; unique index on chat_id, index on tenant_id)
- src/services/messaging-helpers.ts (extracted buildGroundedReply + describeInboundPhoto, shared by Sendblue and Telegram — one place to change reply behavior across channels)
- src/services/telegram-inbound.ts — resolveTelegramTenant, processTelegramInbound with bot-echo/unknown-chat/slash-command ignores; text -> QUEUE_HIGH sms_inbound {channel:'telegram'} + grounded reply; photo -> getFile (largest by file_size) -> R2 telegram-media/<tenant>/... -> vision description -> QUEUE_HIGH telegram_media + confirmation reply
- src/services/delivery/telegram.ts — added sendTelegramReply(chatId,...) for direct-reply path used by inbound handler; sendTelegramMessage(tenantId,...) now falls back to D1 telegram_chats after KV (backwards-compat for morning brief)
- src/workers/ingestion/media-handlers.ts (new) — extracted handleSendblueMedia and added handleTelegramMedia; both go through retainContent with governed capture (source telegram|sendblue, provenance <channel>_photo, authorKind user, legacyMemoryType episodic)
- src/workers/ingestion/handlers.ts trimmed: handleSmsInbound now handles sms|sendblue|telegram channels; metadata differs (from_phone vs telegram_chat_id); media handlers re-exported from media-handlers.ts
- src/workers/ingestion/consumer.ts dispatches telegram_media
- src/workers/mcpagent/public-webhooks.ts — Telegram route rewritten to call processTelegramInbound (drop-in TG_FLOW block replaced); ctx fallback for tests
- src/workers/mcpagent/index.ts GET / gains ?telegram_chat_id=<int> self-registration (writes to D1 + KV for morning-brief compat)
- src/services/sendblue-inbound.ts refactored onto messaging-helpers (drops ~40 lines of local reply/vision code)
- src/types/ingestion.ts: IngestionSource +'telegram'; IngestionQueueMessageType +'telegram_media'
- tests/mission-4.1-telegram-channel.test.ts (7 contracts): wrong secret 403, unknown chat ignored, bot-echo ignored, slash-command skipped, text -> queue+reply+chat_id echo, photo -> largest-by-file_size + R2 telegram-media + telegram_media queue, handleTelegramMedia governed capture with telegram_photo provenance
**Decisions:**
- Sendblue not removed - still deployed; both channels coexist. Live-fire gate proceeds via Telegram; Sendblue lands the same commit shape and remains ready if their Free Tier delivery ever unblocks.
- Slash commands skipped rather than replied (Phase 6 will add /register, /help, etc.); slash-command return kind is 'command' distinct from 'ignored' to allow future analytics
- Telegram media-fetch failure returns ignored (no crash path); getFile against largest photo (highest file_size) to catch full-resolution
**Verification:** 4.1 suite 7/7; full checkout; redeploy; live gate with Matt (chat_id self-register + text + photo)
**Next:** live gate, then Phase 5 real action executors

---

## Mission Phase 4 hotfix - deprecated Workers AI models - 2026-07-03

**Trigger:** post-deploy e2e smoke failed both flows with Workers AI error 5028: `@cf/meta/llama-3.1-8b-instruct` (and the 3.2-11b vision model) removed from the catalog 2026-05-30. Six prod call sites were silently dead (Sendblue reply+vision, Telnyx SMS reply, Telegram, agent router, write-policy classifier) - earlier phase smokes missed it because retrieval uses bge embeddings, which survive.
**Built:**
- `src/services/workers-ai-chat.ts` - shared CHAT_MODEL (`@cf/google/gemma-4-26b-a4b-it`, CF-recommended replacement, text+vision, $0.10/M in), `readChatText` (OpenAI choices[] + legacy {response} shapes, strips think tags), `runGatewayChat`/`runGatewayVision` (G4: gateway + collectLog:false enforced in one place; vision = data-URL image_url content part per model schema)
- Rewired all six call sites onto the helper; Telegram path gains gateway+collectLog:false it never had (Law-2 audit note 2 fixed); removed `SMS_FLOW: step1` plaintext content log from ingest.ts (Law 2)
- Test mock now branches on image_url content part; vision answers in OpenAI shape, text in legacy shape (both parser branches covered)
**Verification:** mission-4.0 suite 8/8; full checkout; redeploy + e2e smoke re-run (text+photo processed)
**Next:** resume Phase 4 gate (live text/photo gate with Matt)

---

## Mission Phase 4 - 2026-07-03

**Spec:** HAETSAL_MISSION.md Phase 4 (Sendblue iMessage Channel)
**Built:**
- `src/services/delivery/sendblue.ts` - outbound client (POST api.sendblue.co/api/send-message, sb-api-key auth headers); returns {success,status,errorCode} without throwing so reply-window rejections are skips, not retries
- `POST /webhooks/sendblue/:pathSecret` (public-webhooks.ts) - constant-time path-secret compare (timingSafeEqual), to_number line check, unknown-sender ignore (shared Free Tier line), outbound-echo ignore; 404 on bad secret
- `src/services/sendblue-inbound.ts` - text flow: canonical capture queued via sms_inbound {channel:'sendblue'} (TMK stays in DO/consumer) + memory-grounded reply (composed broker search -> context block -> llama-3.1-8b via gateway collectLog:false); photo flow: media -> R2 raw artifact (sendblue-media/<tenant>/...) -> llama-3.2-11b-vision description -> sendblue_media queue capture with artifactRef + sendblue_photo provenance -> confirmation reply
- Queue consumer: new sendblue_media handler; sms handler channel-aware (source/provenance 'sendblue'; inbound messages governed authorKind 'user', episodic)
- GET / gains ?phone=%2B1... self-registration (E.164 validated, first-registration-wins) mapping the authenticated tenant in tenant_phone_numbers
- env types: SENDBLUE_* secrets declared; IngestionSource +'sendblue'; queue type +'sendblue_media'
- tests/mission-4.0-sendblue-channel.test.ts (8 contracts: path-secret auth, line check, unknown sender, outbound echo, text flow + client payload shape, photo flow R2+vision+queue, handleSendblueMedia governed capture, client failure metadata)
**Decisions:**
- Replies grounded via composed retrieval from day one; honest about unconnected sources (Gmail/calendar citation in demo clause 1 blocked on Google OAuth - S5 lessons file lands at Phase 5 per mission)
- Unknown senders never trusted or replied to (shared line); tenant mapping only via authenticated self-registration
**Verification:** suite + prod deploy + webhook registration + live text/photo gate: see phase gate report
**Blockers:** live gate requires Matt: register phone via /?phone=..., text the line, send a photo
**Next:** Phase 5 - real action executors (act_search/act_remind real; Gmail send/draft stop at S5 pending Google OAuth)

---

## Mission Phase 3 - 2026-07-03

**Spec:** HAETSAL_MISSION.md Phase 3 (Hindsight + Graphiti Removal)
**Built:**
- G7 data export: built and deployed a temporary export surface (`/api/mission/hindsight-export/*`), scanned prod (Hindsight = Neon public schema, ~2.7k rows + 432 graphiti mappings, all tenant KEKs expired) — then **Matt waived the export at the Phase 3 gate** (2026-07-03: data is test data from a system that was never really in use; G7 reserves this call for Matt). Surface removed without running the export. Safety net: Hindsight's Neon tables are NOT dropped by this phase — the raw rows remain readable via SQL indefinitely
- Full engine code removal: containers (HindsightContainer/HindsightWorkerContainer/GraphitiContainer + hindsight/ graphiti/ dirs), DO bindings, transports/facades/clients, projection/reflection/reconcile modules, operation crons, webhook route, ops snapshot, engine-named types (projectionKind unions -> string), env types, wrangler vars; wrangler migration v5 `deleted_classes` for the three engine DO classes (history v2-v4 preserved forward-only); @cloudflare/containers dependency dropped; env types regenerated
- Postflight "Retired Engines" guard: any hindsight/graphiti reference in src/** or wrangler.toml fails checkout (exemptions: tenants legacy column files, wrangler migration-history entries, explicitly historical comments) — demo clause 10 enforced mechanically
- Docs sweep: ARCHITECTURE.md (Law 1/Law 2 language -> canonical Postgres via Hyperdrive as the plaintext boundary; C5 containers row removed; bindings table updated; post-Hindsight migration note), .claude/governance.md (T1 Neon via Hyperdrive; escalation triggers reworded), checkin/checkout workflows, README, CONVENTIONS, LESSONS (new Post-Hindsight Migration section; historical lessons retained)
- Deploys: Step A intermediate (export surface, containers not rolled) then Step B removal (v5 migration); rollback anchors: wrangler version 4209df4d + git tags deploy-phase-3-prev / deploy-phase-3; memo at docs/lessons/phase-3-prod-deploy-memo.md
**Decisions:**
- **Matt waived the G7 export** (test data only; no canonical destination needed; S7 moot). Hindsight's Neon tables and historical D1 tables (hindsight_operations, hindsight_bank_config, tenants.hindsight_tenant_id) are NOT dropped — inert raw history
- Added GET / status page with browser-clickable session/KEK refresh (fixes the dead-end 404 at the domain root; the Cron KEK is needed by morning brief and future automations regardless)
**Verification:**
- postflight clean (Retired Engines 0); suite 65 files / 379 passed / 1 skipped
- Prod deploys: Step A export-enabler 2f2ff5ba -> removal be33541d (v5 migration applied; one follow-up deploy exposed temporal/compiled in the search_memory MCP zod enum, a gap only the live smoke caught)
- PHASE3 prod live smoke: canary 204; export route 404; MCP init 200; capture_memory landed governed row in real Neon (trust=evidence, class=episode); modes raw/lexical/semantic/temporal/composed found it (semantic = real Workers AI embeddings + pgvector on Neon); graph/compiled correctly empty (no entities/views until Phase 8/10)
- Demo clause 10 greps: all remaining hindsight/graphiti matches are historical comments, exempt tenants legacy column, or migration history
- Fresh-context verifier + Law-2 audit: see phase gate report
**Hindsight Pin:** N/A — engine removed
**Blockers:** none (export blocker dissolved by Matt's waiver)
**Next:** Phase 4 - Sendblue iMessage channel (webhook route + outbound client + photo ingestion; demo clauses 1 + 8)

---

## Mission Phase 2 - 2026-07-03

**Spec:** HAETSAL_MISSION.md Phase 2 (Retrieval Broker, hard cutover)
**Built:**
- Seven retrieval modes through one stable `search_memory` surface: raw | lexical | semantic | graph | temporal | compiled | composed (`src/services/retrieval-modes.ts`, `retrieval-support.ts`, extended `canonical-memory-router.ts`/`canonical-memory-dispatch.ts`)
- Semantic = Postgres pgvector over chunk embeddings (`@cf/baai/bge-base-en-v1.5` via AI Gateway with collectLog:false); lazily provisions the vector extension/column; degrades to lexical ('partial') when unavailable. Lexical = Postgres FTS (websearch_to_tsquery + GIN index). Temporal = window queries. Compiled = compiled-synthesis views by stable key. Composed = deduplicated semantic+lexical+graph+compiled bundle with citations.
- Citations + evidence contract on every item (`CanonicalRetrievalCitation`); title/scope/source-authority/freshness/trust-state boosts (`applyRetrievalBoosts`)
- Postgres-native graph: `canonical-graph-query.ts` rewritten onto canonical_entities/canonical_edges (one-hop + two-hop), provenance projectionKind 'canonical'; governance store gained findEntitiesByName + listEdgesWithEntities
- Broker writes canonical_recall_traces per query; chunk embeddings written best-effort at capture time (waitUntil hook)
- READ severance: recallViaService + memory_search + base-agent routed to canonical broker; fetchMentalModel retired; McpAgent prewarm removed; hindsight operations cron tick unwired; canonical-memory-status reflection/compatibility now null; hindsight debug tool deleted; ops snapshot webhook health 'retired'; consolidation pass1/pass4/weekly-synthesis parked as logged no-ops pending Phase 8 (pass2 runs on canonical edges)
- WRITE severance (Graphiti): CANONICAL_PROJECTION_KINDS = []; both engine kinds throw; captures create zero projection jobs; dispatch status 'skipped'; projection consumer inert (future projections re-enter there)
- G4 hygiene: collectLog:false added to all content-bearing env.AI.run gateway calls
- Deleted: canonical-semantic-recall.ts, canonical-semantic-linkback.ts, tools/hindsight-debug.ts, services/canonical-hindsight-debug.ts, tests 7.2/8.1/8.2/9.6/9.7
- Tests: mission-2.0-retrieval-broker.test.ts (13 eval fixtures: named-thing, relationship 1+2-hop, contradiction/trust ranking, hard negatives, routing, recall traces, engine isolation); ~20 existing files updated to post-engine reality
- Local dev substrate: pgvector/pgvector:pg17 container `brain-dev-pg` on port 5433 (5432 held by fold-postgres); scripts/mission-phase2-live-smoke.ts
**Decisions:**
- Graphiti write severance pulled into Phase 2 (mission Phase 3 preamble expects engines unwired by end of Phase 2); projection jobs framework retained for future AI Search projection
- Unmatched queries default to semantic (was raw); lexical is a real mode (no longer aliased to raw)
- Entity/edge extraction at capture time deliberately NOT added - Phase 8 dream cycle owns extraction; graph mode reads seeded/accumulated canonical edges until then
**Verification:**
- Live smoke: PHASE2_LIVE_SMOKE_OK - all 7 modes retrieved a governed capture against real Postgres (pgvector semantic query real, not fallback)
- npm run checkout / Law-2 audit / CF-docs / fresh verifier: see phase gate report
**Hindsight Pin:** engines fully unwired from runtime; corpses (containers, facades, crons, wrangler config) deleted in Phase 3
**Blockers:** none
**Next:** Phase 3 - Hindsight + Graphiti removal (R2 TMK-encrypted export first per G7, then delete code/config/bindings, DO deletion migrations, docs updates, postflight guards, prod deploy)

---

## Mission Phase 1 - 2026-07-03

**Spec:** HAETSAL_MISSION.md Phase 1 (Canonical Governed Write Path, hard cutover)
**Built:**
- Governance vocabulary + resolution rules: `src/types/canonical-governance.ts`, `src/types/canonical-governance-records.ts`, `src/services/canonical-governance.ts` - epistemic classes (raw_source|episode|observation|claim|fact|preference|procedure|compiled_view), trust states (evidence|inferred|user_confirmed|trusted_import|disputed|stale|superseded|rejected), use policies, provenance envelope; agent writes forced to evidence/can_use_as_evidence; fact/instruction/protected-trust requests from non-user authors downgraded with recorded reason; procedure class rejected except consolidation_cron (Law 3)
- Canonical Postgres governance schema: `src/services/canonical-governance-ddl.ts` (idempotent ALTERs on canonical_captures/chunks + 10 new tables: events, sessions, messages, entities, claims, facts, edges, reviews, policies, recall_traces), `src/services/canonical-postgres-base-ddl.ts` (base DDL extracted from repository)
- Governance store: `src/services/canonical-governance-store.ts` (interface), `canonical-governance-postgres.ts`, `canonical-governance-memory.ts`; promotion discipline in `canonical-promotion.ts` (facts only via approved review, policy, or user)
- Capture path now writes the full provenance envelope + governance columns + plaintext chunk_text (authorized Law 2 boundary) + an atomic canonical_events ledger row; provenance-tagged governance receipt returned to callers (`canonical-memory.ts`, `canonical-capture-pipeline.ts`, `ingestion/retain.ts`, `tools/retain.ts`, `tools/memory.ts`, `external-client-memory-write.ts`)
- Hindsight write path SEVERED: projection kinds default ['graphiti'], 'hindsight' rejected; compat bridge deleted; hindsight materializer/submission deleted; hindsightAsync/compatibilityMode removed; bootstrap ensure-hindsight-bank step removed; queue consumer skips legacy hindsight jobs with a logged marker. Deleted: canonical-capture-compat.ts, canonical-hindsight-projection{,-payload}.ts, ingestion/retain-{request,persistence}.ts, bootstrap/hindsight-{config,bank-spec}.ts
- Dedup regression fix: ingestion_events insert re-homed into retainContent (was hidden inside the deleted Hindsight dispatcher; checkDedup reads it)
- Tests: mission-1.0 (governed write contracts), mission-1.1 (governance primitives + promotion), 11.7 rewritten to severed policy; 2.1/2.1d/1.2-tools/6.1/6.2/6.3 rewritten canonical-only; 7.2/7.3/10.0/10.1 + 9.1/9.2/9.4/9.6-9.9/11.3 reseeded over historical-hindsight fixtures (read path serves historical data until Phase 2); 7.1 + 2.4a deleted with their subjects; two seeding helpers in tests/support/
- Live smoke: `scripts/mission-phase1-live-smoke.ts` (capture_memory tool handler -> canonical Postgres, envelope + event + chunk_text verified; see lessons for substrate note)
**Decisions:**
- Law 2 boundary shift implemented as authorized: canonical Postgres (Neon via Hyperdrive) is now the plaintext memory surface (chunk_text/claims/messages); bodies remain TMK-encrypted in R2; D1/KV/logs stay content-free
- Graphiti writes continue until Phase 2 (reads+writes severed together there); Hindsight reads remain for historical data until Phase 2
- Legacy memoryType mapping locked: episodic->episode, semantic->claim, world->observation
**Verification:**
- `npm test`: 76 files, 417 passed, 1 skipped
- `npm run postflight`: pass (3 new schema/store files added to accepted list with justification)
- Law-2 audit subagent + fresh-context verifier: see phase gate report
- Live smoke: PHASE1_LIVE_SMOKE_OK (see docs/lessons/phase-1-write-path-severance.md item 6 for substrate)
**Hindsight Pin:** write path severed; container + read path remain until Phase 2/3
**Blockers:** none
**Next:** Phase 2 - retrieval broker (7 modes over canonical Postgres FTS/pgvector/graph), sever Hindsight read path + Graphiti reads/writes

---

## Mission Phase 0 - 2026-07-02

**Spec:** HAETSAL_MISSION.md Phase 0 (Mission Bootstrap & Baseline Reset)
**Built:**
- `docs/implementation-plans/mission-phase-0-inventory.md` - refreshed Hindsight/Graphiti reference inventory (75 files, ~815 refs classified by severance phase), wrangler binding dispositions, action-layer stub baseline, and test-suite dispositions; supersedes the stale inventory sections of the 2026-06-01 baseline report
- `docs/lessons/phase-0-baseline-reset.md` - mission lessons directory seeded per HAETSAL_MISSION.md §11
- Removed stale duplicate `specs/active/10.1-active-tree-reconciliation-and-test-hygiene.md` (completed copy with As-Built already in `specs/completed/`)
- `MANIFEST.md` regenerated via checkout
**Decisions:**
- Mission runs on branch `haetsal-mission` (rollback tag `pre-haetsal-mission` = `a76c164` on master). One commit per phase gate.
- `.omx/context/phase-11-6-*` session constraints ("do not adopt Sessions", "do not remove Hindsight") are superseded by HAETSAL_MISSION.md §5 for this run.
**Verification:**
- Branch/tag verified; `pre-haetsal-mission` tag exists on master
- CF Access: `Haetsal` app (Allow Matt + haetsal-brain-shell-smoke service token) and `Webhook: Sendblue` bypass app (`05fd91af-e8f5-48f8-8a0b-43a419ff4f13`) both present, no drift
- `wrangler secret list --name the-brain` confirms all four SENDBLUE_* secrets
- vitest excludes for `gbrain/`, `OB1/`, `Second-Brain/`, `.codegraph/` already in place; package.json/package-lock reconciled (root deps match)
- `npm run checkout` passed (postflight + full suite + manifest regen)
**Hindsight Pin:** unchanged (removal begins Phase 1 write-path severance)
**Blockers:** Google OAuth not provisioned (GOOGLE_CLIENT_ID/SECRET absent) - by design; Phase 5 Gmail clauses stop at S5 with a lessons file for Matt
**Next:** Phase 1 - canonical governed write path (hard cutover): canonical Postgres schemas via HYPERDRIVE_CANONICAL, provenance envelope, epistemic classes/trust states/use policy, sever Hindsight write path

---

## Session 11.4 - 2026-04-22

**Spec:** Connector-Driven Compilation Triggers
**Built:**
- `src/services/compiled-synthesis-trigger*.ts`, `src/services/canonical-compiled-refresh-trigger.ts` - added a small 11.4 trigger layer that extracts compact canonical change events, plans explicit project-scoped compiled refresh targets, and dispatches those targets through the existing 11.2 project compiler seam
- `src/services/canonical-capture-pipeline.ts`, `src/services/ingestion/retain.ts`, `src/services/canonical-memory.ts`, `src/types/canonical-memory.ts` - wired targeted compiled refresh into the canonical capture path only when TMK is available, preserved the existing production path, and surfaced `artifactId` in canonical capture results so change events carry fuller canonical linkage
- `src/services/compiled-synthesis.ts` - exported the trigger helpers through the existing compiled-synthesis internal surface
- `tests/11.4-connector-driven-compilation-triggers.test.ts` - added dedicated 11.4 coverage for change-event extraction, target planning, dispatch invocation, canonical-write-triggered dossier/context-pack/change-view refresh, stable identity across repeated changes, and no-TMK production-path preservation
- `specs/active/11.4-connector-driven-compilation-triggers.md`, `MANIFEST.md` - completed the 11.4 As-Built record and regenerated the manifest
**Decisions:**
- **11.4 ships an explicit project-first planner, not a broad fuzzy invalidation engine.** The v1 heuristics only plan refreshes for project-scoped canonical changes and deliberately emit no targets rather than falling back to "recompile everything."
- **Targeted dispatch reuses the existing project compiler.** One planned project dispatch refreshes the existing trio of compiled outputs together: `project_dossier`, `project_context_pack`, and project `what_changed`.
- **TMK remains the structural gate for compiled refresh.** Because compiled source selection decrypts canonical bodies from R2, targeted compilation only runs when the write path already has TMK access; otherwise the canonical write still succeeds and refresh is skipped truthfully.
- **The production memory path stayed additive.** Trigger wiring was placed after the existing canonical capture + projection + compatibility work, and uses `waitUntil()` when available instead of restructuring the write path around compilation.
- **No compatibility shim was required.** The new trigger layer fit the existing canonical and compiled seams directly.
**Verification:**
- `npx vitest run tests/11.4-connector-driven-compilation-triggers.test.ts` - passed
- `npx vitest run tests/11.4-connector-driven-compilation-triggers.test.ts tests/11.3-chief-of-staff-compiled-read-path.test.ts tests/11.2-compilation-pipeline.test.ts tests/11.1-dossier-and-context-pack-schema-refinement.test.ts tests/11.0-haetsal-compiled-synthesis-foundation.test.ts tests/canonical-postgres-repository.test.ts tests/6.1-canonical-open-brain-foundation.test.ts tests/6.3-canonical-capture-pipeline.test.ts tests/10.0-canonical-postgres-source-of-truth-cutover.test.ts tests/10.1-retire-canonical-d1-compat-mirror.test.ts tests/9.4-brain-memory-external-client-rollout.test.ts` - passed
- `npm test` - passed (`416 passed`, `1 skipped`)
- `npm run postflight` - passed
- `npm run manifest` - passed
**Hindsight Pin:** unchanged
**Blockers:** None for 11.4; the main remaining work is broadening subject normalization and connector-specific canonical writes, not the target-planning seam itself
**Next:** The first post-11.4 connector ingestion session should be a project-scoped connector lane, preferably Google Drive / Obsidian project-note ingestion through the canonical path, so real connector writes can reuse the new project subject hints and immediately refresh project dossiers/context packs/change views

---

## Session 11.2 - 2026-04-22

**Spec:** Compilation Pipeline
**Built:**
- `src/services/compiled-synthesis-compile.ts`, `src/services/compiled-synthesis-source-truth.ts`, `src/services/compiled-synthesis-compiler-types.ts` - added the first internal HAETSAL compiler trigger plus typed canonical-source selection that reads canonical truth from Postgres/R2, scores relevant project inputs, and derives deterministic source fingerprints for regeneration-safe artifact versioning
- `src/services/compiled-synthesis-assemble*.ts`, `src/services/compiled-synthesis-signal-*.ts` - added the first project-scoped assembly pipeline that parses explicit facts, relationships, recent changes, decisions, open questions, actions, and contradictions from canonical source bodies and converts them into typed dossier/context-pack/change-view payloads plus supporting compiled entities/facts/relationships/contradictions
- `src/services/compiled-synthesis-render*.ts`, `src/services/compiled-synthesis.ts`, `src/services/compiled-synthesis-utils.ts` - added stable Markdown/JSON rendering for the initial compiled families and exported the new compiler through the existing compiled-synthesis surface without changing the production read path
- `tests/11.2-compilation-pipeline.test.ts` - added dedicated end-to-end 11.2 coverage for dossier/context-pack/change-view compilation from canonical truth, Postgres persistence, R2 artifact output, source linkage, and regeneration-safe identity across repeated runs
- `specs/active/11.2-compilation-pipeline.md` - completed the As-Built record for the delivered 11.2 pipeline
**Decisions:**
- **11.2 ships a deliberately small first compiler.** The initial end-to-end families are `project_dossier`, `project_context_pack`, and `what_changed`, rather than trying to compile every dossier or context-pack family at once.
- **Canonical Postgres + R2 remain the source truth.** The compiler reads canonical records from the existing Postgres seam and hydrates canonical bodies from R2 through the existing encrypted-body path instead of introducing a parallel substrate.
- **Regeneration-safe identity is stable while artifacts still version.** Compiled document stable keys remain conceptual identity, while artifact versions derive from a deterministic fingerprint of the selected canonical source set.
- **The production memory path stays untouched.** This session adds a new internal compiler lane and reuses the 11.0 / 11.1 compiled-synthesis persistence/read seams instead of cutting over the Chief of Staff or broader read path early.
- **No compatibility shim was required.** The additive compiler path fit the existing compiled-synthesis and canonical memory layers directly.
**Verification:**
- `npx vitest run tests/11.2-compilation-pipeline.test.ts` - passed
- `npx vitest run tests/11.2-compilation-pipeline.test.ts tests/11.1-dossier-and-context-pack-schema-refinement.test.ts tests/11.0-haetsal-compiled-synthesis-foundation.test.ts tests/canonical-postgres-repository.test.ts tests/6.1-canonical-open-brain-foundation.test.ts tests/6.3-canonical-capture-pipeline.test.ts tests/9.4-brain-memory-external-client-rollout.test.ts tests/10.0-canonical-postgres-source-of-truth-cutover.test.ts tests/10.1-retire-canonical-d1-compat-mirror.test.ts` - passed
- `npm test` - passed (`406 passed`, `1 skipped`)
- `npm run postflight` - passed
- `npm run manifest` - passed
**Hindsight Pin:** unchanged
**Blockers:** None for 11.2; the remaining work is Chief of Staff compiled read-path adoption and broader trigger/runtime wiring, not compiler correctness for the first delivered families
**Next:** Use 11.3 to make the Chief of Staff read path prefer these compiled outputs at runtime, then add queue/Workflow-triggered compilation on top of the same internal compiler seam

---

## Session 11.1 - 2026-04-22

**Spec:** Dossier And Context Pack Schema Refinement
**Built:**
- `sql/postgres/2003_compiled_synthesis_schema_refinement.sql` - added the forward compiled-synthesis refinement migration for dossier rows, richer contradiction columns, explicit context-pack sections, and decision/change compiled views
- `src/services/compiled-synthesis-*.ts` - refined the compiled-synthesis contract into explicit dossier/context-pack/change-view families, richer contradiction storage, additive audience semantics, typed section contracts, and family-specific read helpers while keeping `compiled_documents` as the stable identity spine
- `tests/11.1-dossier-and-context-pack-schema-refinement.test.ts` - added dedicated 11.1 coverage for dossier section semantics, context-pack agent sections, contradiction object storage/retrieval, decision/change views, regeneration-safe identity, and canonical/R2 linkage
- `specs/active/11.1-dossier-and-context-pack-schema-refinement.md`, `MANIFEST.md` - completed the 11.1 As-Built record and regenerated the manifest against the final split file layout
**Decisions:**
- **Dossiers are now first-class compiled outputs.** We introduced `family = 'dossier'` plus `compiled_dossiers` with explicit subject identity and named sections instead of leaving dossier semantics implicit in generic compiled documents.
- **Context packs remain compact but are no longer structurally vague.** `compiled_context_packs` now stores `situation`, `critical_facts`, `recent_changes`, `decisions`, `contradictions`, `recommended_actions`, and `source_refs` explicitly for agent reuse.
- **Contradictions are preserved as tension, not flattened away.** The compiled contradiction model now captures conflict kind/scope, severity, freshness, structured left/right claims, and optional resolution guidance while preserving stable identity and status.
- **Decision and change views are explicit compiled families.** We added `family = 'decision_log' | 'what_changed'` plus `compiled_change_views` so future compiler jobs can target real decision/change objects instead of generic summaries.
- **Audience semantics stay additive.** Existing `human|agent|hybrid` callers still work, while refined compiled outputs can now mark `human_readable`, `agent_reusable`, `chief_of_staff`, or `specialist_agent`.
- **No compatibility shim was required.** The existing production memory path was left untouched; the only compatibility behavior added was safe defaulting for newly added contradiction metadata so 11.0-style compiled writes still succeed.
**Verification:**
- `npx vitest run tests/11.1-dossier-and-context-pack-schema-refinement.test.ts` - passed
- `npx vitest run tests/11.1-dossier-and-context-pack-schema-refinement.test.ts tests/11.0-haetsal-compiled-synthesis-foundation.test.ts tests/canonical-postgres-repository.test.ts tests/6.1-canonical-open-brain-foundation.test.ts tests/6.3-canonical-capture-pipeline.test.ts tests/9.4-brain-memory-external-client-rollout.test.ts tests/10.0-canonical-postgres-source-of-truth-cutover.test.ts tests/10.1-retire-canonical-d1-compat-mirror.test.ts` - passed
- `npm test` - passed (`404 passed`, `1 skipped`)
- `npm run postflight` - passed
- `npm run manifest` - passed
**Hindsight Pin:** unchanged
**Blockers:** None for 11.1; the remaining work is compiler/population and Chief of Staff read-path adoption, not schema/readback stability
**Next:** Use 11.2 to generate these refined compiled objects automatically, then 11.3 to decide how the Chief of Staff and other read paths prefer dossiers/context packs/change views at runtime

---

## Session 11.0 - 2026-04-22

**Spec:** HAETSAL Compiled Synthesis Foundation
**Built:**
- `sql/postgres/2002_compiled_synthesis_foundation.sql` - added first-class compiled synthesis tables for compiled documents, canonical provenance links, generated artifact refs, entities, facts, relationships, contradictions, and context packs in the existing `haetsal_canonical` schema
- `src/services/compiled-synthesis-*.ts` - added the additive compiled synthesis repository, Neon/test store installation seam, deterministic R2 artifact persistence, and small persist/read service surface for future compiler jobs
- `tests/11.0-haetsal-compiled-synthesis-foundation.test.ts`, `tests/apply-migrations.ts` - added dedicated 11.0 coverage for compiled record creation, provenance linkage, R2 artifact linkage, context-pack storage, and regeneration-safe identities; wired the compiled test store into the shared test bootstrap
- `scripts/postflight-check.ts` - accepted the compiled repository file under the same reviewed over-limit exception pattern already used for the canonical Postgres repository
- `specs/active/11.0-haetsal-compiled-synthesis-foundation.md`, `MANIFEST.md` - completed As-Built and regenerated manifest
**Decisions:**
- Session 11.0 stayed additive and did not reroute the existing production memory path.
- Compiled outputs reuse the existing Neon/Postgres + R2 substrate instead of introducing any new foundational Hindsight or Graphiti dependency.
- Canonical provenance is explicit via `compiled_document_sources`; generated compiled artifacts are explicit via `compiled_document_artifacts`.
- Regeneration safety is handled through tenant-scoped stable-key upserts for compiled documents and family records, while artifacts remain versioned in R2.
- No compatibility shim was required for current local read/write memory flows.
**Verification:**
- `npx vitest run tests/11.0-haetsal-compiled-synthesis-foundation.test.ts` - passed
- `npx vitest run tests/11.0-haetsal-compiled-synthesis-foundation.test.ts tests/canonical-postgres-repository.test.ts tests/6.1-canonical-open-brain-foundation.test.ts tests/6.3-canonical-capture-pipeline.test.ts tests/9.4-brain-memory-external-client-rollout.test.ts` - passed
- `npm test` - passed (`400 passed`, `1 skipped`)
- `npm run postflight` - passed
- `npm run manifest` - passed
**Hindsight Pin:** unchanged
**Blockers:** None for 11.0; the remaining work is future-session compiler/read-path wiring, not foundation stability
**Next:** Use 11.1 to refine dossier/context-pack semantics and read models, then 11.2 to build the actual compilation pipeline/jobs on top of this foundation.

---

## Session 10.1 - 2026-04-21

**Spec:** Phase 10.1 - Retire Canonical D1 Compatibility Mirror
**Built:**
- `src/services/canonical-memory.ts`, `src/services/canonical-projection-dispatch.ts`, `src/services/canonical-hindsight-projection-state.ts`, `src/services/canonical-graphiti-reconcile.ts` - removed the temporary canonical D1 metadata mirror writes so canonical capture and projection reconciliation now persist canonical truth in Postgres only while leaving D1 audit/trace roles intact
- `src/services/canonical-d1-compat.ts` - removed the temporary D1 compatibility helper entirely because no canonical runtime path still needs mirrored metadata rows after the 10.0 cutover
- `tests/10.1-retire-canonical-d1-compat-mirror.test.ts` plus updated 1.2 / 6.1 / 6.2 / 6.3 / 7.1 / 7.2 / 8.2 / 9.1 / 9.2 / 9.4 / 9.6 / 9.7 / 9.8 / 9.9 / 10.0 suites - regression coverage now proves canonical capture, Hindsight reconciliation, Graphiti reconciliation, and public read/status/query behavior all work from Postgres-only canonical truth while D1 remains limited to broker traces, memory audit, hindsight operations, and tenant/control-plane/runtime-local state
- `specs/active/10.1-retire-canonical-d1-compat-mirror.md` - completed the As-Built record with the mirror-retirement decision, remaining D1 roles, verification results, and live-proof outcome
**Decisions:**
- **The D1 canonical metadata mirror is fully retired.** Canonical memory families now have one authoritative runtime home: Postgres + R2.
- **D1 remains intentionally narrow.** We kept D1 only for broker traces, memory audit, hindsight operations, and tenant/control-plane/runtime-local state instead of preserving any just-in-case canonical mirror rows.
- **Public MCP/tool contracts stay stable while storage internals simplify.** Read/status/query/capture surfaces still behave the same externally, but they now resolve canonical truth from Postgres only.
**Verification:**
- `npx vitest run tests/10.1-retire-canonical-d1-compat-mirror.test.ts` - passed
- `npx vitest run tests/7.1-hindsight-projection-adapter.test.ts tests/8.2-graphiti-ingestion-projection.test.ts tests/9.8-broker-primary-shadow-retrieval.test.ts tests/9.9-tenant-memory-trace.test.ts tests/10.0-canonical-postgres-source-of-truth-cutover.test.ts` - passed
- `npm test` - passed (`387 passed`, `1 skipped`)
- `npm run postflight` - passed
- `npm run manifest` - passed
- Live protected MCP proof on April 21, 2026:
  - Graphiti remained green: fresh relationship and timeline queries returned the new live facts
  - broker + tenant trace remained green: `prepare_context_for_agent`, `get_recent_memory_traces`, and `get_memory_trace` all succeeded live
  - Hindsight did **not** remain green for fresh semantic recall: fresh captures reconciled to completed projection state, but live Hindsight debug still showed `memory_unit_count = 0`, so meaningful fresh semantic recall did not surface the new facts
**Current Health:**
- **Canonical storage boundary:** green locally; canonical D1 metadata mirroring is removed and Postgres-only truth passed the requested regression suites
- **Graphiti:** green live
- **Broker + tenant trace:** green live
- **Hindsight:** not green live for fresh semantic materialization despite completed projection state
**Hindsight Pin:** unchanged from the deployed environment under test
**Fixture Data:** Live proof facts used `Harbor Ledger Echo depends on Quartz Bridge Echo for billing sync.` and `Northfield Ledger Echo uses Quartz Bridge Echo for billing sync, and if billing sync breaks, inspect Quartz Bridge Echo first.`
**Blockers:** Live Hindsight semantic materialization remains unhealthy; fresh captures complete reconciliation but still show zero materialized memory units
**Next:** Remove the now-dead canonical D1 schema/migration baggage for the retired mirror, then investigate the live Hindsight semantic materialization gap separately

---

## Session OPS.9 - 2026-04-20

**Spec:** Operational - Hindsight semantic acceptance hardening
**Built:**
- `src/services/canonical-memory-status.ts`, `src/services/canonical-semantic-linkback.ts`, `src/services/canonical-semantic-recall.ts` - read-side Hindsight `semanticReady` now treats `availability_source = 'document'` as the async-ready signal and stops overstating readiness for `operation_completed` async completions; synchronous retains with no availability marker remain ready
- `tests/support/hindsight-test-env.ts` - Hindsight test stub now supports configurable `memory_unit_count` so completed-without-units cases can be simulated explicitly
- `tests/7.2-semantic-recall-through-canonical-interface.test.ts`, `tests/9.4-brain-memory-external-client-rollout.test.ts` - semantic acceptance now uses meaningful natural-language facts, and regression coverage explicitly checks that completed async operations without materialized memory units stay `partial` / not-ready
- `LESSONS.md`, `CONVENTIONS.md` - recorded the acceptance-method lesson and the availability-source semantic-readiness rule
**Decisions:**
- **Opaque token probes are plumbing checks, not semantic-quality checks.** We now treat semantic acceptance as a natural-language fact extraction and recall problem, because Hindsight can complete token-heavy retains without yielding useful memory units.
- **Async Hindsight readiness is gated by document availability, not just operation completion.** `availability_source = 'operation_completed'` no longer counts as semantically ready on the canonical read side.
- **Synchronous retains keep their old behavior.** If there is no availability marker at all, completed sync retains still count as ready rather than being downgraded by the new async-specific hardening.
**Verification:**
- `npx vitest run tests/7.2-semantic-recall-through-canonical-interface.test.ts` - passed
- `npx vitest run tests/9.4-brain-memory-external-client-rollout.test.ts` - passed
- `npm test` - passed (`363 passed`, `1 skipped`)
- `npm run postflight` - passed
- `npm run manifest` - passed
- Live protected Claude/MCP acceptance on deploy `eef19ac2-d411-4b59-b8da-e902b9e609dd` - passed for meaningful facts:
  - Hindsight fact `Alder Port depends on Nimbus Rail for freight movement.` completed with `memory_unit_count = 1`, `semanticReady = true`, and semantic recall returned the fresh capture
  - Graphiti facts `Marin Vale leads Alder Port.` and `Alder Port partnered with Solace Yard on April 20, 2026.` produced live relationship/timeline results
  - `prepare_context_for_agent` surfaced graph + semantic context together for Alder Port / Marin Vale / Nimbus Rail / Solace Yard
**Current Health:**
- **Hindsight:** green for meaningful natural-language captures and paraphrase-style semantic queries
- **Graphiti:** green for live relationship traces and timelines
- **Combined open-brain context:** green; `prepare_context_for_agent` is now benefiting from both semantic and graph-backed facts in the same fresh acceptance run
- **Known caveat:** opaque token-only semantic smokes remain a weak probe and should not be used as the primary acceptance gate
**Hindsight Pin:** `ghcr.io/vectorize-io/hindsight-api:0.5.3`
**Fixture Data:** Meaningful semantic acceptance fact: `Alder Port depends on Nimbus Rail for freight movement.`
**Blockers:** Opaque token-style semantic smoke strings remain weak probes by design; use meaningful facts for semantic acceptance
**Next:** If desired, add a dedicated acceptance script/checklist that codifies the meaningful-fact live sweep used here

---

## Session OPS.8 - 2026-04-19

**Spec:** Operational - Cloudflare Local Explorer implementation/deploy playbook
**Built:**
- `scripts/cloudflare-local-explorer.ts` - helper CLI to classify repo bindings by Local Explorer support and fetch the local Explorer OpenAPI spec from a running dev Worker
- `package.json` - added `cf:explorer:plan` and `cf:explorer:spec` npm scripts for the new helper
- `docs/cloudflare-local-explorer.md`, `README.md` - documented the HAETSAL-specific Local Explorer workflow, pre-deploy checklist, and the split between Explorer-covered resources and Cloudflare surfaces that still require Wrangler or remote checks
- `.gitignore` - ignored the generated `tmp/local-explorer-openapi.json` artifact so the OpenAPI snapshot can be captured locally without polluting git status
**Decisions:**
- **Local Explorer is a pre-deploy confidence layer, not the deployment mechanism.** We keep Wrangler and remote smoke checks as the source of truth for queues, Vectorize, AI, Browser Rendering, and container-runtime behavior.
- **The first helper stays config-driven and small.** Parsing `wrangler.toml` gives us immediate value without depending on unstable preview CLI behavior or hard-coding Local Explorer endpoint shapes beyond the published OpenAPI root.
- **Agent access should default to local Cloudflare state, not production.** Capturing `/cdn-cgi/explorer/api` gives future coding agents a safer discovery surface during implementation.
**Verification:**
- `npm run cf:explorer:plan` - passed
**Hindsight Pin:** unchanged (`ghcr.io/vectorize-io/hindsight-api:0.5.2`)
**Fixture Data:** N/A - docs and local tooling only
**Blockers:** None
**Next:** Use `npm run cf:explorer:spec` during a live `wrangler dev` session to snapshot the Local Explorer OpenAPI surface whenever agent-side local binding automation is needed

---

## Session OPS.7 - 2026-04-19

**Spec:** Operational - live `memory_status` D1 migration repair
**Built:**
- Live production D1 `brain-us` - applied missing `1014_hindsight_projection_adapter.sql` so `canonical_projection_results` now includes `engine_bank_id`, `engine_document_id`, and `engine_operation_id`, plus the operation lookup index
- `d1_migrations` on live `brain-us` - recorded `1014_hindsight_projection_adapter.sql` as applied after confirming production had stopped at `1013_canonical_open_brain_foundation.sql`
- No repo source changes - investigation confirmed `src/services/canonical-memory-status.ts`, `migrations/1014_hindsight_projection_adapter.sql`, and the existing 6.2 / 7.1 / 7.2 tests were already aligned
**Decisions:**
- **This was a production migration miss, not a code bug.** `memory_status` was truthfully reading adapter columns that the live database did not yet have.
- **The smallest correct fix was operational.** We repaired live D1 instead of weakening the canonical status contract with fallback code that would hide a broken rollout state.
- **Existing regression coverage was already adequate.** The repo already had tests asserting the adapter-backed fields, so no repo test change was needed for this incident.
**Verification:**
- `npx vitest run tests/6.2-canonical-mcp-memory-surface.test.ts` - passed
- `npx vitest run tests/7.2-semantic-recall-through-canonical-interface.test.ts` - passed
- `npm test` - passed (`344 passed`, `1 skipped`)
- `npm run postflight` - passed
- `npm run manifest` - passed
- Live D1 verification - confirmed `canonical_projection_results` now exposes the adapter columns and the previously failing `r.engine_document_id` query shape executes cleanly
**Hindsight Pin:** unchanged (`ghcr.io/vectorize-io/hindsight-api:0.5.2`)
**Fixture Data:** N/A - operational production schema repair only
**Blockers:** None
**Next:** Keep deploy discipline tight around D1 migrations; this incident came from code and schema shipping out of sync, not from a faulty canonical-memory implementation

---

## Session OPS.6 - 2026-04-19

**Spec:** Operational - HAETSAL-first public MCP identity cleanup
**Built:**
- `wrangler.toml`, `src/services/bootstrap/hindsight-config.ts`, `src/types/env.ts` - public Worker domain defaults and examples now point to `haetsalos.specialdarksystems.com` instead of the legacy `the-brain` `workers.dev` hostname
- `src/workers/mcpagent/do/McpAgent.ts` - MCP server identity now advertises `haetsal` while leaving the underlying Worker script name unchanged
- `README.md`, `ARCHITECTURE.md` - repo truth docs now describe HAETSAL as the public MCP face and explicitly demote `the-brain` to an internal/runtime legacy name
- `tests/2.4a-hindsight-config.test.ts`, `tests/support/hindsight-test-env.ts` - domain-facing test fixtures now use the HAETSAL endpoint
**Decisions:**
- **The Worker script name stays `the-brain` for now.** This pass only cleans up the public MCP/domain story and avoids a broader Cloudflare runtime rename.
- **`haetsalos.specialdarksystems.com/mcp` is now the primary public endpoint.** The legacy `the-brain.ct-trading-bot1.workers.dev` hostname is treated as compatibility-only.
- **The MCP server label is part of the public face.** Renaming the SDK server from `the-brain` to `haetsal` keeps client-visible identity aligned with the new domain story.
**Verification:**
- `npm test` - passed (`344 passed`, `1 skipped`)
- `npm run postflight` - passed
- `npm run manifest` - passed
**Hindsight Pin:** unchanged (`ghcr.io/vectorize-io/hindsight-api:0.5.2`)
**Fixture Data:** Reused the existing Hindsight webhook/config harnesses with the HAETSAL custom-domain endpoint substituted for the public-facing examples
**Blockers:** None
**Next:** If and when runtime cleanup is desired, do a separate Worker/script rename pass; this change intentionally stops at public identity/domain cleanup

---

## Session 9.1 - 2026-04-19

**Spec:** Phase 9.1 - Multi-Mode Memory Router
**Built:**
- `src/services/canonical-memory-router.ts` - explainable intent router for `raw`, `semantic`, `graph`, and `composed`, including explicit override normalization and focus-term extraction for graph/composed dispatch
- `src/services/canonical-source-attribution.ts` - shared canonical source-attribution normalizer applied across all search modes
- `src/services/canonical-memory-query.ts`, `canonical-composed-graph-context.ts`, `src/tools/canonical-memory.ts`, `src/types/canonical-memory-query.ts` - existing canonical `search_memory` surface now routes through the new router, returns route metadata, exposes consistent `attribution`, and accepts `raw|semantic|graph|composed` plus backward-compatible `lexical`
- `tests/9.1-multi-mode-memory-router.test.ts` - inferred raw/semantic/graph/composed routing, explicit override, and attribution coverage
- `tests/7.2-semantic-recall-through-canonical-interface.test.ts`, `tests/8.3-graph-timeline-query-surface.test.ts`, `LESSONS.md`, `specs/completed/8.3-graph-timeline-query-surface.md`, `specs/completed/9.1-multi-mode-memory-router.md` - regression labels updated, router lesson captured, and spec lifecycle completed for both the already-built 8.3 spec and the new 9.1 spec
**Decisions:**
- **The router is heuristic and explainable, not AI-scored.** Mode inference uses small ordered pattern sets and preserves raw fallback for plain keyword queries so the existing canonical surface stays predictable.
- **Composed mode reuses the bounded 8.3 helper on purpose.** Session 9.1 routes into the already-shipped graph-backed composed path and stops short of any 9.2 context-bundle expansion.
- **Canonical source attribution is now a shared shape.** Every search result item gets the same `attribution` contract regardless of whether the answer came from raw, Hindsight-backed semantic recall, graph reads, or graph-backed composed retrieval.
- **`lexical` is now an input alias, not a public result mode.** The public canonical response now reports `raw`, while older callers can still pass `mode = lexical` and get the same raw path.
**Verification:**
- `npx vitest run tests/9.1-multi-mode-memory-router.test.ts` - passed
- `npm test` - passed
- `npm run postflight` - passed
- `npm run manifest` - passed
**Hindsight Pin:** unchanged (`ghcr.io/vectorize-io/hindsight-api:0.5.2`)
**Fixture Data:** Reused canonical note/conversation fixtures plus the 7.2/8.3 projection harnesses; added 9.1 routing coverage for raw, semantic, graph, composed, and explicit override behavior
**Blockers:** None
**Next:** Session 9.2 only if explicitly requested; 9.1 stops at routing and attribution

---

## Session 7.3 - 2026-04-18

**Spec:** Phase 7.3 - Reflection / Consolidation Alignment
**Built:**
- `src/services/canonical-hindsight-reflection.ts`, `canonical-hindsight-reflection-status.ts` - narrow canonical alignment layer for Hindsight reflection/consolidation audit writes plus truthful read-side status derivation
- `src/cron/consolidation.ts` - existing 3.3 consolidation runner now marks canonical reflection `started` / `completed` / `failed` state for eligible completed Hindsight-backed operations without changing the scheduler model
- `src/services/canonical-memory-status.ts`, `src/services/canonical-memory-audit.ts`, `src/types/canonical-memory-query.ts` - canonical `memory_status` now exposes a small top-level `reflection` subsection derived from metadata-only audit rows and existing consolidation-run state
- `tests/7.3-reflection-consolidation-alignment.test.ts` - pending/completed reflection truth, failed-then-retried reflection truth, and “no reflection before semantic projection completion” coverage
- `LESSONS.md`, `CONVENTIONS.md`, `README.md`, `MANIFEST.md`, `hindsight/Dockerfile`, `specs/completed/7.3-reflection-consolidation-alignment.md` - checkout-closeout docs refreshed, Hindsight upstream release commit documented, and spec lifecycle completed
**Decisions:**
- **7.3 reuses the canonical audit lane instead of adding schema.** Reflection/consolidation status is attached to canonical operations through metadata-only audit events and the existing `consolidation_runs` table, so no `1016` migration was required.
- **The consolidation scheduler stays in place.** Session 7.3 aligns the proven 3.3 runtime instead of introducing a new reflection scheduler or a new public/internal HTTP surface.
- **Read-side status gives same-timestamp lifecycle events explicit precedence.** When `started` and `completed` land in the same millisecond, canonical status ranks `completed` above `failed`, and `failed` above `started`, so reflection truth stays stable.
**Verification:**
- `npx vitest run tests/7.3-reflection-consolidation-alignment.test.ts` - passed
- `npx tsx scripts/postflight-check.ts` - passed
- `npx vitest run` - passed (`311 passed`, `1 skipped`)
- `npx tsx scripts/generate-manifest.ts` - passed
- `npx tsx scripts/postflight-check.ts` - passed (final checkout run)
**Hindsight Pin:** documented upstream release commit `712a862` for `ghcr.io/vectorize-io/hindsight-api:0.5.2`
**Fixture Data:** Reused canonical note/projection fixtures and 3.3 consolidation harness patterns; added 7.3 coverage for reflection pending/completed/failed-retry lifecycle truth
**Blockers:** None
**Next:** No active spec remains in `specs/active/`; next work should start from the completed 7.3 baseline

---

## Session 7.2 - 2026-04-18

**Spec:** Phase 7.2 - Semantic Recall Through Canonical Interface
**Built:**
- `src/services/canonical-semantic-recall.ts`, `canonical-semantic-linkback.ts` - canonical semantic query orchestration plus metadata-only Hindsight-to-canonical provenance resolution
- `src/services/canonical-memory-query.ts`, `canonical-memory-status.ts`, `src/types/canonical-memory-query.ts`, `src/tools/canonical-memory.ts` - canonical `search_memory` now supports `mode: 'semantic'`, returns truthful semantic status/provenance metadata, and exposes engine-linkback/readiness through `memory_status`
- `src/types/hindsight.ts` - updated to the runtime request/response shapes already used by HAETSAL's Hindsight shell so semantic recall normalization can rely on typed recall results
- `tests/7.2-semantic-recall-through-canonical-interface.test.ts` - note recall, conversation recall, mixed canonical/local-source linkback, missing-projection truthfulness, status exposure, and engine-failure fallback coverage
- `specs/active/7.2-semantic-recall-through-canonical-interface.md` - As-Built Record completed with migration decision, shipped result shape, provenance strategy, verification, and explicit deviations
**Decisions:**
- **Semantic recall extends the canonical search surface instead of adding a new tool.** `search_memory` now accepts `mode: 'lexical' | 'semantic'`, keeping Hindsight behind the canonical MCP contract.
- **7.2 reuses the 7.1 projection schema as-is.** Linkback is resolved from `engine_document_id`, `engine_operation_id`, and `target_ref`, so no `1015` migration was needed.
- **Engine failure falls back truthfully, not deceptively.** When Hindsight recall is unavailable, canonical semantic search returns `status = 'unavailable'` with no items rather than silently substituting lexical search results.
**Verification:**
- `npx vitest run tests/7.2-semantic-recall-through-canonical-interface.test.ts` - passed
- `npm test` - passed (`308 passed`, `1 skipped`)
- `npm run postflight` - passed
- `npm run manifest` - passed
**Hindsight Pin:** unchanged (`ghcr.io/vectorize-io/hindsight-api:0.5.2`)
**Fixture Data:** Reused canonical note/conversation fixtures and 7.1 projection behavior; added 7.2 coverage for canonical semantic reads, mixed linkback, missing projection truth, and semantic-engine failure fallback
**Blockers:** None
**Next:** Session 7.3 if and when reflection/consolidation needs to be attached back onto the canonical semantic surface

---

## Session 7.1 - 2026-04-18

**Spec:** Phase 7.1 - Hindsight Projection Adapter
**Built:**
- `src/services/canonical-hindsight-projection.ts`, `canonical-hindsight-reconcile.ts`, `canonical-hindsight-projection-payload.ts`, `canonical-hindsight-projection-state.ts` - real Hindsight projection submission, reconciliation, payload staging, and canonical projection state writes
- `src/workers/ingestion/canonical-projection-consumer.ts`, `src/workers/ingestion/consumer.ts`, `src/cron/hindsight-operation-poll.ts` - queue and poll paths now reconcile truthful Hindsight `queued/completed/failed` state onto canonical projection rows
- `src/services/canonical-capture-pipeline.ts`, `canonical-capture-compat.ts`, `canonical-memory-audit.ts`, `canonical-memory-status.ts`, `src/types/canonical-capture-pipeline.ts` - canonical capture now stages encrypted Hindsight projection payloads, retires the direct compatibility writer, and maps the stable compatibility alias onto the real Hindsight projection lane
- `migrations/1014_hindsight_projection_adapter.sql` - additive engine reference columns plus operation-id lookup index on `canonical_projection_results`
- `tests/7.1-hindsight-projection-adapter.test.ts` plus updated `tests/6.3-canonical-capture-pipeline.test.ts`, `tests/2.1-retain.test.ts`, `tests/2.1d-ingestion-consumer-integration.test.ts` - submission, reconciliation, compatibility regression, and failure-path coverage
- `LESSONS.md`, `CONVENTIONS.md`, `MANIFEST.md`, `specs/completed/7.1-hindsight-projection-adapter.md` - checkout truth files refreshed and spec lifecycle completed
**Decisions:**
- **Canonical capture remains the only write front door.** Hindsight retain work is now driven exclusively by canonical `hindsight` projection jobs rather than an inline compatibility retain bridge.
- **Async adapters recover raw content from encrypted R2 staging, not from queue payloads or D1.** A deterministic KEK-encrypted Hindsight payload key kept the queue metadata-only while still letting the trusted worker submit later.
- **Compatibility status is now an alias over the real Hindsight projection lane.** The public 6.3 contract stays stable without keeping a second temporary compatibility state machine alive.
**Verification:**
- `npx vitest run tests/7.1-hindsight-projection-adapter.test.ts` - passed
- `npm test` - passed (`302 passed`, `1 skipped`)
- `npm run postflight` - passed
- `npm run manifest` - passed
- `npx tsx scripts/postflight-check.ts` - passed
- `npx vitest run` - passed (`302 passed`, `1 skipped`)
- `npx tsx scripts/generate-manifest.ts` - passed
**Hindsight Pin:** unchanged (`ghcr.io/vectorize-io/hindsight-api:0.5.2`)
**Fixture Data:** Reused canonical note/conversation fixtures; added 7.1 coverage for async Hindsight submission, reconciliation, and failed-adapter truthfulness
**Blockers:** None
**Next:** Session 7.2 if and when the canonical recall surface is ready to consume the stored Hindsight engine references

---

## Session 9.8 - 2026-04-20

**Spec:** Phase 9.8 - Broker Primary + Shadow Retrieval
**Built:**
- `src/services/canonical-memory-broker.ts`, `canonical-memory-dispatch.ts`, `canonical-broker-shadow.ts`, `canonical-broker-trace.ts`, `src/types/canonical-memory-broker.ts` - shipped the default read-path broker that reuses the 9.1 explainable router, dispatches the primary query on the hot path, runs a read-only shadow-secondary retrieval in the background, and persists tenant-scoped broker traces with engine identity and provenance intact
- `src/services/canonical-memory-query.ts`, `canonical-memory-read-model.ts`, `chief-of-staff-context.ts`, `src/tools/canonical-memory.ts`, `src/types/canonical-memory-query.ts` - existing canonical `search_memory` and `prepare_context_for_agent` now flow through the broker without changing the stable public surface beyond additive broker metadata
- `migrations/1021_broker_primary_shadow_trace.sql` - added the smallest architecture-consistent storage lane for tenant-visible broker trace metadata in D1, paired with encrypted detail blobs in `R2_OBSERVABILITY`
- `tests/9.8-broker-primary-shadow-retrieval.test.ts`, `tests/8.3-graph-timeline-query-surface.test.ts`, `MANIFEST.md`, `specs/active/9.8-broker-primary-shadow-retrieval.md` - added primary/shadow/non-blocking/trace regression coverage, tightened graph tests for brokered shadow reads, regenerated the manifest, and completed the 9.8 As-Built record
**Decisions:**
- **The broker is now the default read path, but only the primary result reaches the user.** Session 9.8 deliberately stops at explainable routing plus background comparison and does not add any cross-engine synthesis.
- **Shadow retrieval is bounded, read-only, and non-blocking.** Semantic-primary runs graph shadow, graph-primary runs semantic shadow, and the user-facing response does not wait for the shadow branch to finish.
- **Tenant traces stay tenant-scoped, not platform-wide.** We store structured broker trace rows in D1 for queryable tenant history and place richer encrypted payloads in `R2_OBSERVABILITY` instead of creating a new broad admin inspection surface.
**Verification:**
- `npx vitest run tests/9.8-broker-primary-shadow-retrieval.test.ts` - passed
- `npx vitest run tests/7.2-semantic-recall-through-canonical-interface.test.ts tests/8.3-graph-timeline-query-surface.test.ts tests/9.2-chief-of-staff-context-builder.test.ts tests/9.4-brain-memory-external-client-rollout.test.ts tests/9.7-graphiti-entity-relation-projection.test.ts` - passed
- `npm test` - passed
- `npm run postflight` - passed
- `npm run manifest` - passed
- Live protected MCP proof after deploy `580a228a-0a10-409d-baaf-e18b222b004a` - passed:
  - meaningful fresh Hindsight semantic recall remained green
  - fresh Graphiti relationship and timeline queries remained green
  - `prepare_context_for_agent` remained green
  - broker traces existed in live tenant-scoped storage for brokered queries
  - non-blocking shadow behavior was confirmed live by a successful graph-primary result whose semantic shadow timed out independently
**Current Health:**
- **Hindsight:** green live after 9.8
- **Graphiti:** green live after 9.8
- **Brokered canonical reads:** green, with primary-only hot-path responses and persisted tenant-scoped traces
- **Known caveat:** raw and composed reads currently skip shadow dispatch by design in 9.8
**Hindsight Pin:** unchanged (`ghcr.io/vectorize-io/hindsight-api:0.5.3`)
**Fixture Data:** Fresh live proof used meaningful semantic and graph captures around `Mira Sol` / `Jonah Vale`, plus the existing canonical regression fixtures for semantic, graph, and context assembly paths
**Blockers:** None
**Next:** Session 9.9 can build user-facing cross-engine synthesis on top of the broker traces, but platform-owner analytics, anonymized cross-tenant telemetry, and canonical Postgres migration remain intentionally out of scope

---

## Session 6.3 - 2026-04-18

**Spec:** Phase 6.3 - Canonical Capture Pipeline
**Built:**
- `src/types/canonical-capture-pipeline.ts` - canonical-first capture, queue-dispatch, and compatibility-bridge contracts
- `src/services/canonical-capture-pipeline.ts`, `canonical-projection-dispatch.ts`, `canonical-capture-compat.ts`, `canonical-capture-compat-state.ts` - canonical-first orchestration, truthful queue bookkeeping, and current-Hindsight compatibility retention
- `src/services/ingestion/retain.ts` - accepted writes now enter the canonical pipeline before the compatibility bridge
- `src/services/canonical-memory.ts`, `canonical-memory-audit.ts`, `canonical-memory-status.ts`, `canonical-memory-stats.ts`, `src/workers/ingestion/consumer.ts` - accepted/queued/failed + compatibility state made truthful through the existing HAETSAL shell
- `src/tools/retain.ts`, `src/tools/memory.ts` - stable write surfaces now return canonical ids/status metadata alongside the current Hindsight-visible result
- `tests/6.3-canonical-capture-pipeline.test.ts` - canonical-first note/conversation/artifact coverage, metadata-only queue payload assertions, compatibility bridging, and procedural-write rejection
- `LESSONS.md` - added the projection-queue audit timing lesson discovered during the 6.3 rewire
- `specs/completed/6.3-canonical-capture-pipeline.md` - As-Built completed and spec moved out of `specs/active/`
**Decisions:**
- **Canonical acceptance is now the first write boundary.** Projection jobs are created as `accepted`, become `queued` only after queue send succeeds, and flip to `failed` on dispatch failure.
- **Compatibility state reuses the existing canonical projection-results lane.** `compatibility_*` result rows made the bridge queryable without introducing a new table or changing schema.
- **The queue contract stays inside the current HAETSAL shell.** The dispatch message uses the existing `{ type, tenantId, payload, enqueuedAt }` envelope rather than introducing a second queue format.
**Verification:**
- `npx vitest run tests/6.3-canonical-capture-pipeline.test.ts` - passed
- `npm test` - passed (`296 passed`, `1 skipped`)
- `npm run postflight` - passed
- `npm run manifest` - passed
**Hindsight Pin:** unchanged (`ghcr.io/vectorize-io/hindsight-api:0.5.2`)
**Fixture Data:** Reused canonical note/conversation/artifact fixtures; new 6.3 assertions cover queue payload creation and compatibility state transitions
**Blockers:** None
**Next:** Session 7.1 - replace the compatibility lane with the real Hindsight projection adapter without changing the canonical public contract

---

## Session OPS.5 - 2026-04-18

**Spec:** Operational - Session 6.2 checkout completion
**Built:**
- `LESSONS.md` - added the Worker-test `waitUntil()` drainage lesson discovered while stabilizing the canonical MCP surface harness
- `specs/completed/6.2-canonical-mcp-memory-surface.md` - moved Session 6.2 out of `specs/active/` after As-Built completion
- `SESSION_LOG.md` / `MANIFEST.md` - checkout-closeout truth files refreshed after the spec lifecycle move
**Decisions:**
- **The governance checkout protocol is the source of truth, not just the automated commands.** A session is not fully checked out until the spec lifecycle step is complete when a spec was finished.
- **The 6.2 harness issue warranted a lessons entry.** The captured `waitUntil()` drain pattern is now explicit so future Worker-side tool tests do not rediscover the same D1 teardown failure.
**Verification:**
- `npm run postflight` - passed
- `npm test` - passed (`291 passed`, `1 skipped`)
- `npm run manifest` - passed
**Hindsight Pin:** unchanged (`ghcr.io/vectorize-io/hindsight-api:0.5.2`)
**Fixture Data:** N/A - checkout completion only
**Blockers:** None
**Next:** Continue from the now-completed Session 6.2 baseline when the next reviewed spec is ready

---

## Session 6.2 - 2026-04-18

**Spec:** Phase 6.2 - Canonical MCP Memory Surface
**Built:**
- `src/types/canonical-memory-query.ts` - canonical search/recent/document/status/stats contracts
- `src/services/canonical-memory-read-model.ts`, `canonical-memory-query.ts`, `canonical-memory-status.ts`, `canonical-memory-stats.ts` - canonical read, decrypt, status, and stats services over the Session 6.1 bridge layer
- `src/tools/canonical-memory.ts` - canonical MCP tools: `capture_memory`, `search_memory`, `get_recent_memories`, `get_document`, `memory_status`, `memory_stats`
- `src/workers/mcpagent/do/McpAgent.ts` - canonical tools registered through the existing McpAgent surface, version `6.2.0`
- `tests/6.2-canonical-mcp-memory-surface.test.ts` + new canonical-memory query fixtures - tenant-scoped search/recent/document/status/stats coverage plus capture alias presence
**Decisions:**
- **Session 6.2 keeps the public surface canonical while leaving the production Hindsight path intact.** The new canonical tools are additive and do not replace `brain_v1_*` or `memory_*` yet.
- **Canonical reads stay foundation-first.** Search and recent reads use Session 6.1 D1 metadata and, when a session TMK is present, decrypt canonical R2 document bodies to build previews and matches.
- **`capture_memory` is a bridge, not the 6.3 pipeline.** It maps canonical `scope` onto the current retain `domain` field so write policy and live retain behavior remain unchanged until canonical capture-first writes land.
**Verification:**
- `npx vitest run tests/6.2-canonical-mcp-memory-surface.test.ts` - passed
- `npm test` - passed (`291 passed`, `1 skipped`)
- `npm run postflight` - passed
- `npm run manifest` - passed
**Hindsight Pin:** unchanged (`ghcr.io/vectorize-io/hindsight-api:0.5.2`)
**Fixture Data:** `tests/fixtures/canonical-memory/note-search-query.json`, `recent-query.json`, `document-query.json`, `status-query.json`
**Blockers:** None for Session 6.2; 6.3 still owns canonical capture-first writes and projection fan-out
**Next:** Session 6.3 - move the canonical contract from bridge reads into the canonical capture-first write pipeline

---

## Session 6.1 - 2026-04-18

**Spec:** Phase 6.1 - Canonical Open Brain Foundation
**Built:**
- `migrations/1013_canonical_open_brain_foundation.sql` - canonical capture/artifact/document/chunk/operation/projection tables in the bridge-layer substrate
- `src/types/canonical-memory.ts` - canonical capture/artifact/result contracts
- `src/services/canonical-memory.ts` plus schema/type/artifact/audit helpers - service-layer canonical capture with atomic D1 writes and encrypted R2 payload persistence
- `src/services/ingestion/retain.ts` - off-by-default canonical shadow-write hook guarded by `CANONICAL_MEMORY_SHADOW_WRITES`
- `tests/fixtures/canonical-memory/*.json` + `tests/6.1-canonical-open-brain-foundation.test.ts` - note, conversation, and artifact fixture coverage for canonical capture acceptance
**Decisions:**
- **Session 6.1 lands a bridge layer first.** Canonical metadata now lives in D1 and canonical payloads live encrypted in R2, shaped to map cleanly to the long-term Postgres + R2 target without adding a new Worker-to-Neon write path yet.
- **The production Hindsight path remains authoritative today.** Shadow writes are best-effort and feature-flagged off by default so current interactive and queued retain behavior is unchanged unless explicitly enabled.
- **Canonical chunk truth is offset/hash based.** Raw chunk text is derived from the encrypted canonical document body in R2 rather than duplicated into D1.
**Verification:**
- `npx vitest run tests/6.1-canonical-open-brain-foundation.test.ts` - passed
- `npm test` - passed (`284 passed`, `1 skipped`)
- `npm run postflight` - passed
- `npm run manifest` - passed
**Hindsight Pin:** unchanged (`ghcr.io/vectorize-io/hindsight-api:0.5.2`)
**Fixture Data:** `tests/fixtures/canonical-memory/note-capture.json`, `conversation-capture.json`, `artifact-capture.json`
**Blockers:** None for Session 6.1; later sessions still need the real Postgres landing and projection worker fan-out
**Next:** Session 6.2 - define the stable canonical MCP memory surface on top of the new foundation

---

## Session OPS.4 - 2026-04-17

**Spec:** Operational - drift-aware Hindsight provisioning + service-layer cleanup
**Built:**
- `migrations/1012_hindsight_bank_config.sql` - D1 ledger for applied Hindsight config hashes per bank
- `src/services/bootstrap/hindsight-bank-spec.ts` - canonical Hindsight bank provisioning spec + deterministic config hash
- `src/services/bootstrap/hindsight-config.ts` - drift-aware `ensureHindsightBankConfigured()` plus idempotent bank/model/webhook re-apply
- `src/services/hindsight-client.ts` + `src/services/hindsight.ts` - thinner raw Hindsight client under the richer HAETSAL orchestration layer
- `src/workers/ingestion/retain-consumer.ts` + `src/workers/ingestion/consumer.ts` - retain-artifact queue path split into its own consumer seam
- `src/services/ingestion/retain.ts` + `src/workflows/bootstrap.ts` - both write-time retain and bootstrap now run through the same bank-config ensure path
- `tests/2.4a-hindsight-config.test.ts`, `tests/2.1c-ingestion-consumer.test.ts`, `tests/2.1d-ingestion-consumer-integration.test.ts`, `tests/2.1-retain.test.ts` - updated for Request-based Hindsight transport and the new queue seam
**Decisions:**
- **Bank config is no longer "bootstrap once and trust forever."** HAETSAL now stores a config hash per Hindsight bank and re-applies when missions, mental models, or webhook shape drift.
- **The raw Hindsight API client is separate from orchestration.** Transport-level calls live in `hindsight-client.ts`; D1-aware lifecycle and runtime concerns stay above it.
- **Non-interactive retain artifacts get their own queue seam.** `retain_artifact` dispatch no longer piggybacks on the TMK-backed handler module.
- **Write-time retain can safely self-heal config drift.** Interactive writes and queued retains both converge on the same `ensureHindsightBankConfigured()` path.
**Verification:**
- `npx vitest run tests/2.4a-hindsight-config.test.ts tests/2.1c-ingestion-consumer.test.ts tests/2.1d-ingestion-consumer-integration.test.ts tests/2.1-retain.test.ts` - passed (32 tests)
**Hindsight Pin:** unchanged (`ghcr.io/vectorize-io/hindsight-api:0.5.2`)
**Fixture Data:** Test tenants `test-tenant-retain`, `test-tenant-queue`; Request-based Hindsight service-binding stubs
**Blockers:** None in this slice; full checkout verification still required after truth-file regeneration
**Next:** Run repo-wide checkout (`postflight`, `npm test`, `manifest`) and decide whether to backfill existing bank-config rows in live environments

---

## Session OPS.3 â€” 2026-04-17

**Spec:** Operational â€” Checkout protocol closeout
**Built:**
- src/cron/hindsight-operations.ts + `src/cron/hindsight-operation-*.ts` â€” split the ops poller/reconcile path into smaller modules so postflight line enforcement passes cleanly
- src/services/hindsight.ts + helper transport/formatter modules â€” extracted transport and formatting helpers to keep the public Hindsight service under the global 150-line boundary
- src/services/ingestion/retain.ts + retain-request / retain-persistence helpers â€” separated request construction and persistence side-effects from the retain orchestrator
- src/workers/mcpagent/do/McpAgent.ts + tool/session/inbound helpers â€” trimmed the DO runtime back under postflight while keeping the dedicated-worker Hindsight topology intact
- tests/2.1-retain.test.ts path stabilized indirectly via `src/services/ingestion/retain-persistence.ts` â€” detached async reconcile work no longer outlives the test when no `ExecutionContext` exists
- MANIFEST.md â€” regenerated after the checkout cleanup
**Decisions:**
- The checkout protocol is authoritative: `npm run postflight`, `npm test`, and `npm run manifest` must all pass before calling the Hindsight work truly closed out.
- Detached async follow-up work is only safe when a real `ctx.waitUntil()` exists; test and pure service-call paths should not spawn background D1 reconciliation promises.
- Postflight line enforcement is best handled by extracting focused helper modules, not by squeezing more branching into already-hot files.
**Verification:**
- `npm run postflight` â€” passed
- `npm test` â€” passed
- `npm run manifest` â€” passed
- `npx vitest run tests/2.1-retain.test.ts` â€” passed after the retain follow-up fix
**Hindsight Pin:** `ghcr.io/vectorize-io/hindsight-api:0.5.2`
**Fixture Data:** Test-only async retain path without `ExecutionContext` now exits cleanly; no extra live fixture changes
**Blockers:** None for checkout completion; remaining repo warnings are non-fatal harness/platform noise
**Next:** Move to non-Hindsight platform work, or do broader repo-health cleanup as a separate lane

---

<!-- Template for new entries:

## Session [N.N] — [YYYY-MM-DD]

**Spec:** [Phase N.N — Name]
**Built:**
- [file] ([lines] lines) — [purpose]
- [file] ([lines] lines) — [purpose]
**Decisions:**
- [key decision and why]
**Hindsight Pin:** [commit hash if changed, or "unchanged"]
**Fixture Data:** [which fixture files consumed, or "N/A — infrastructure only"]
**Blockers:** [any blockers, or "None"]
**Next:** [what comes next]

---

-->

## Session 0.0 — 2026-03-10

**Spec:** Scaffold — project initialization
**Built:**
- ARCHITECTURE.md — constitutional law (three laws, state tiers, compute continuum, action authorization)
- CONVENTIONS.md — file limits, naming, Hono patterns, service layer, encryption, action layer, async, DB, anti-patterns
- .agents/rules/governance.md — AI agent check-in/check-out protocol with Brain-specific guardrails
- LESSONS.md — pre-populated with known gotchas from architecture design sessions
- MANIFEST.md — module registry template + binding status tracker
- SESSION_LOG.md — this file
- specs/SPEC_TEMPLATE.md — spec template with Brain-specific sections (Law Check, Action Layer wiring)
- README.md — project overview and getting started
- docs/build-sequence.md — Phase 1–5 spec roadmap
**Decisions:**
- Scaffold produced from dark-factory-scaffold template + Schema execution plan + THE_BRAIN_ARCHITECTURE.md
- Spec template adds three Brain-specific sections not in generic template: Laws Check, Action Layer wiring, Cron KEK wiring
- LESSONS.md pre-populated with 15+ known gotchas from architecture design rather than starting empty
- MANIFEST.md includes Binding Status tracker to track Phase 1–5 infrastructure build-out
**Hindsight Pin:** Not set — set this at Phase 1.1 start
**Fixture Data:** N/A — scaffold only
**Blockers:** None
**Next:** Phase 1.1 — Hindsight Container + Neon + Hyperdrive + D1 schema + McpAgent stub

---

## Session 1.1 — 2026-03-10

**Spec:** Phase 1.1 — Infrastructure Bedrock
**Built:**
- wrangler.toml (~105 lines) — all Cloudflare bindings: D1, R2, KV, 5 queues, Vectorize, Analytics, Browser, Hyperdrive, Container
- migrations/1001_brain_tenants.sql (~37 lines) — tenants, tenant_members
- migrations/1002_brain_observability.sql (~95 lines) — memory_audit, agent_traces, agent_cost_summary, ingestion_events, cron_executions
- migrations/1003_brain_cognitive.sql (~78 lines) — anomaly_signals, graph_health_snapshots, mental_model_history, predictions
- migrations/1004_brain_action_layer.sql (~119 lines) — tenant_action_preferences, pending_actions, action_audit, scheduled_tasks, action_templates
- hindsight/Dockerfile (~8 lines) — Distroless container build (commit hash placeholder)
- hindsight/hindsight.toml (~12 lines) — Hyperdrive URL, auto-migrate
- src/workers/health/index.ts (~60 lines) — Health check Worker: D1, R2, KV, Container
- tests/1.1-infrastructure.test.ts (~96 lines) — 7 integration tests via vitest-pool-workers
- vitest.config.ts (~22 lines) — workerd pool with stubbed HINDSIGHT service binding
- package.json — Hono, wrangler, vitest, CF workers-types
- tsconfig.json — strict, ES2022, bundler resolution
- .dev.vars.example — local dev secrets template
**Decisions:**
- **Structural: postflight/manifest scripts now scan src/ alongside packages/.** The spec defines a flat `src/workers/` layout. The scaffold's scripts originally only scanned `packages/`. Both scripts were updated to scan both directories. This keeps future monorepo flexibility while honoring the spec's flat structure. Session 1.2 agent: this is intentional.
- Hindsight commit hash is a placeholder (SET_COMMIT_HASH_BEFORE_DEPLOY). This is a manual gate — spec cannot be marked COMPLETE until a real hash is pinned.
- D1_EU binding stubs to same DB as D1_US with explicit TODO for Phase 5+.
**Hindsight Pin:** v0.4.16 (vectorize-io/hindsight @ 58fdac4) — pinned 2026-03-10
**Fixture Data:** N/A — infrastructure only
**Blockers:** None
**Next:** Phase 1.2 — McpAgent Worker + auth + TMK derivation

---

## Session 1.2 — 2026-03-10

**Spec:** Phase 1.2 — McpAgent + Auth + AI Gateway
**Built:**
- src/types/env.ts (~46 lines) — full Env interface: all bindings + MCPAGENT DO
- src/types/tenant.ts (~30 lines) — TenantContext, TenantRow matching D1 DDL
- src/types/tools.ts (~52 lines) — retain/recall types + Zod schemas for MCP SDK
- src/middleware/auth.ts (~130 lines) — CF Access JWT validation, HKDF tenant ID, TMK derivation
- src/middleware/audit.ts (~46 lines) — writeAuditLog + auditMiddleware (trace ID stamp)
- src/middleware/dlp.ts (~16 lines) — DLP stub passthrough
- src/services/tenant.ts (~120 lines) — atomic tenant bootstrap, KEK provision/renewal
- src/tools/retain.ts (~22 lines) — brain_v1_retain stub
- src/tools/recall.ts (~18 lines) — brain_v1_recall stub
- src/workers/mcpagent/do/McpAgent.ts (~98 lines) — DO: TMK in memory, MCP tools, WebSocket
- src/workers/mcpagent/index.ts (~70 lines) — Hono Worker: middleware chain + route handlers
- tests/1.2-auth.test.ts (~110 lines) — 9 tests: tenant ID, TMK, bootstrap, KEK, audit
- tests/1.2-tools.test.ts (~53 lines) — 4 tests: retain/recall schema shapes
- tests/1.2-websocket.test.ts (~36 lines) — 3 tests: 401 rejection, security headers
- tests/test-entry.ts (~42 lines) — minimal worker entry for vitest
- tests/env.d.ts (~11 lines) — cloudflare:test ProvidedEnv type augmentation
**Decisions:**
- **Deviation: McpAgent.serve() not used.** The SDK's `serve()` bypasses Hono middleware. Kept Hono as entry, route /mcp to DO via `stub.fetch(c.req.raw)`. DO receives pre-authenticated requests.
- **Deviation: initTenant() RPC added.** SDK's abstract `init()` runs at DO creation before JWT auth occurs. Added `initTenant(jwtSub, tenantId)` called by Worker after auth.
- **Deviation: Zod schemas required.** `McpServer.tool()` needs `ZodRawShapeCompat`, not plain JSON Schema. Installed `zod@3.25.1`.
- **Deviation: Test entry split.** agents@0.7.5 transitive deps (partyserver, @modelcontextprotocol/sdk) fail to bundle in miniflare. `wrangler.test.toml` uses `tests/test-entry.ts`.
- **Middleware pattern: `createMiddleware` from `hono/factory`.** Required for proper Variables typing on `c.set()`/`c.get()`.
- **Checkin workflow updated:** Added Step 2 "Cloudflare Platform Verification" — checks official docs, `cloudflare/agents`, `cloudflare/workers-sdk`, `cloudflare/workerd`, npm registry.
**Hindsight Pin:** unchanged (v0.4.16 @ 58fdac4)
**Fixture Data:** N/A — auth + infrastructure only
**Blockers:** None
**Next:** Phase 1.3 — Action Worker + approval flow + WebSocket push for action events

---

## Session 1.3 — 2026-03-10

**Spec:** Phase 1.3 — Action Layer Foundation
**Built:**
- src/types/action.ts (~86 lines) — CapabilityClass, AuthorizationLevel, HARD_FLOORS, queue message schema
- src/services/action/toctou.ts (~22 lines) — hashPayload + verifyPayloadHash (timingSafeEqual)
- src/services/action/authorization.ts (~130 lines) — auth gate, HMAC verify, preference lookup
- src/services/action/executor.ts (~46 lines) — stub execution + WebSocket broadcast
- src/services/action/router.ts (~110 lines) — routeGreen/Yellow/Red + writeAnomalyAndAudit
- src/workers/action/index.ts (~90 lines) — queue consumer pipeline (no HTTP surface)
- src/tools/act/send-message.ts (~33 lines) — WRITE_EXTERNAL_IRREVERSIBLE stub
- src/tools/act/create-event.ts (~35 lines) — WRITE_EXTERNAL_REVERSIBLE stub
- src/tools/act/modify-event.ts (~35 lines) — WRITE_EXTERNAL_REVERSIBLE stub
- src/tools/act/draft.ts (~33 lines) — WRITE_INTERNAL stub
- src/tools/act/search.ts (~33 lines) — READ stub
- src/tools/act/browse.ts (~33 lines) — READ stub
- src/tools/act/remind.ts (~33 lines) — WRITE_INTERNAL stub
- src/tools/act/run-playbook.ts (~33 lines) — WRITE_EXTERNAL_IRREVERSIBLE stub
- src/workers/mcpagent/do/McpAgent.ts (~120 lines) — registered 8 act tools via registerActTools()
- src/workers/mcpagent/index.ts (~82 lines) — added queue() handler alongside fetch()
- tests/1.3-action-layer.test.ts (~210 lines) — 12 integration tests (auth gate, TOCTOU, pipeline)
**Decisions:**
- **Deviation: Queue consumer on main Worker, not separate.** Cloudflare Queues consumers export queue() alongside fetch() from the same entry point. No separate wrangler file needed. Action logic isolated in src/workers/action/ module with zero HTTP surface. Added to LESSONS.md.
- **Deviation: Router extracted to separate file.** Postflight caught action/index.ts at 207 lines (limit 150). Extracted routeGreen/Yellow/Red + writeAnomalyAndAudit to src/services/action/router.ts.
- **Platform max_retries vs app max_retries documented.** wrangler.toml max_retries=3 (platform DLQ routing) is independent from pending_actions.max_retries=3 (application-level budget). Added to LESSONS.md.
**Hindsight Pin:** unchanged (v0.4.16 @ 58fdac4)
**Fixture Data:** N/A — behavioral wiring only
**Blockers:** None
**Next:** Phase 1.4 — Pages UI + approval flow + settings

---

## Session 2.1 — 2026-03-10

**Spec:** Phase 2.1 — Queue Topology + Ingestion Foundation
**Built:**
- src/types/ingestion.ts (~47 lines) — IngestionArtifact, SalienceResult, RetainResult, queue message types
- src/types/hindsight.ts (~38 lines) — HindsightRetainRequest/Response, HindsightRecallRequest/Response
- migrations/1005_brain_ingestion.sql (~18 lines) — tenant_phone_numbers table
- src/services/ingestion/dedup.ts (~40 lines) — SHA-256 dedup hash + D1 check
- src/services/ingestion/salience.ts (~77 lines) — Tier 1/2/3 classification + queue routing
- src/services/ingestion/domain.ts (~57 lines) — keyword domain inference + memory type
- src/services/ingestion/write-policy.ts (~73 lines) — heuristic + Workers AI classifier
- src/services/ingestion/retain.ts (~115 lines) — retainContent() single path for all memory writes
- src/workers/mcpagent/routes/ingest.ts (~96 lines) — POST /ingest/sms (Telnyx Ed25519)
- src/workers/mcpagent/routes/auth.ts (~12 lines) — placeholder for Phase 2.2
- src/workers/ingestion/consumer.ts (~78 lines) — queue consumer for QUEUE_HIGH/NORMAL/BULK
- src/workers/mcpagent/index.ts (~97 lines) — route extraction + multi-queue dispatch
- src/workers/mcpagent/do/McpAgent.ts (~148 lines) — getTmk/getHindsightTenantId RPC + real retain
- src/tools/retain.ts (~53 lines) — retainViaService replaces retainStub
- src/tools/recall.ts (~15 lines) — updated TODO comment for Phase 2.2
- tests/2.1-salience.test.ts (~80 lines) — 9 tests for tier classification + queue routing
- tests/2.1-write-policy.test.ts (~64 lines) — 6 tests for heuristic + classifier
- tests/2.1-retain.test.ts (~172 lines) — 14 tests for pipeline, dedup, encryption, R2 STONE
- tests/2.1-sms.test.ts (~134 lines) — 6 tests for webhook, tenant lookup, phone uniqueness
**Decisions:**
- **Route extraction completed:** /ingest/* and /auth/* in separate route modules. Main index.ts mounts via Hono route groups. Prevents 2.2 restructuring.
- **SMS route bypasses CF Access:** Mounted BEFORE auth middleware in Hono chain. Telnyx Ed25519 validation replaces JWT auth on this route.
- **Multi-queue dispatch:** queue() handler dispatches by `batch.queue` name — actions vs ingestion.
- **retainStub replaced:** retainViaService calls real retainContent() pipeline. Old 1.2 tests updated.
- **Hindsight stub enhanced:** vitest config returns plausible retain/recall responses by URL path.
**Hindsight Pin:** unchanged (v0.4.16 @ 58fdac4)
**Fixture Data:** N/A — infrastructure only
**Blockers:** None
**Next:** Phase 2.2 — Gmail + Calendar Ingestion

---

## Session 2.2 — 2026-03-10

**Spec:** Phase 2.2 — Gmail + Calendar Ingestion
**Built:**
- src/types/google.ts (~50 lines) — GoogleOAuthTokens, GoogleThread, GoogleMessage, GoogleCalendarEvent, GoogleDriveFile
- migrations/1006_brain_google.sql (~33 lines) — google_webhook_channels, google_oauth_tokens tables
- src/services/google/oauth.ts (~115 lines) — token encrypt/decrypt, store, refresh, revoke
- src/services/google/gmail.ts (~83 lines) — thread fetch, 2+ reply filter, 2000 char trim
- src/services/google/calendar.ts (~60 lines) — event fetch, 15min filter, PII reduction
- src/services/google/drive.ts (~78 lines) — Drive polling, frontmatter parsing, wikilinks
- src/services/google/webhook.ts (~42 lines) — channel token verification, registration
- src/services/telnyx.ts (~37 lines) — Ed25519 verification extracted from ingest.ts
- src/workers/ingestion/handlers.ts (~93 lines) — extracted handler functions from consumer.ts
- src/workers/mcpagent/routes/ingest.ts (~120 lines) — Gmail/Calendar webhook routes added
- src/workers/mcpagent/routes/auth.ts (~55 lines) — Google OAuth callback + revoke
- src/tools/recall.ts (~58 lines) — real Hindsight recall via recallViaService
- tests/2.2-gmail.test.ts (~77 lines) — 6 tests: thread extraction, filtering, trimming
- tests/2.2-calendar.test.ts (~80 lines) — 5 tests: event extraction, duration, PII
- tests/2.2-obsidian.test.ts (~100 lines) — 11 tests: frontmatter, wikilinks, anti-circular
- tests/2.2-oauth.test.ts (~117 lines) — 4 tests: encryption, D1 metadata, revocation
**Decisions:**
- **KV key pattern `google_tokens:{tenantId}:{scope}`** instead of spec's `oauth:{tenantId}:google:{scope}`. Simpler, consistent with google_ prefix convention.
- **Handlers extracted to `src/workers/ingestion/handlers.ts`** when postflight caught consumer.ts at 165 lines. Clean separation of dispatch logic vs handler implementations.
- **Telnyx verification extracted to `src/services/telnyx.ts`** when postflight caught ingest.ts at 158 lines.
- **vitest-pool-workers isolated storage confirmed:** OAuth tests required self-contained setup per test case (not shared across describe block).
- **recallViaService pattern:** Encrypt query → Hindsight service binding → decrypt results. Mirrors retainViaService from 2.1.
**Hindsight Pin:** unchanged (v0.4.16 @ 58fdac4)
**Fixture Data:** N/A — infrastructure only
**Blockers:** None
**Next:** Phase 2.3 — Browser Rendering + Write Surfaces

---

## Session 2.3 — 2026-03-10

**Spec:** Phase 2.3 — Browser Rendering + First Write Surfaces
**Built:**
- src/services/action/integrations/browser.ts (36 lines) — executeBrowse via @cloudflare/puppeteer + BROWSER binding
- src/services/action/integrations/calendar.ts (97 lines) — executeCreateEvent, executeModifyEvent, executeDeleteEvent (undo)
- src/services/action/integrations/episodic.ts (44 lines) — writeActionEpisodicMemory via retainContent
- src/services/action/executor.ts (113 lines) — executeAction dispatch by tool_name; stub fallback for unwired tools
- src/services/action/router.ts (111 lines) — routeGreen now passes TMK + ctx to executeAction
- src/workers/action/index.ts (104 lines) — TMK fetch from DO, optional ctx, no-op ExecutionContext for tests
- src/workers/mcpagent/routes/actions.ts (76 lines) — POST /:id/undo route (5-min window, calendar delete)
- src/workers/mcpagent/index.ts (144 lines) — mounted /actions route, ctx passed to handleActionBatch
- src/types/action.ts (97 lines) — ActionState union type, UNDO_WINDOW_MS constant
- tests/2.3-browse.test.ts (78 lines) — 5 tests: routing, capability class, Law 1
- tests/2.3-calendar.test.ts (100 lines) — 6 tests: routing, state, audit records
- tests/2.3-undo.test.ts (119 lines) — 6 tests: window check, state transitions, result_summary
**Decisions:**
- **TMK made nullable in executeAction:** browse (READ) doesn't need TMK for execution — only for episodic memory (non-fatal skip). Calendar tools require TMK (throw if null). This maintains backward compatibility with 1.3 tests.
- **ctx made optional in processAction:** Existing 1.3 tests call `processAction(msg, env)` without ctx. Added noopCtx fallback with no-op waitUntil/passThroughOnException.
- **Episodic memory extracted to integrations/episodic.ts:** executor.ts hit 157 lines (limit 150). writeActionEpisodicMemory is logically cohesive and extracted cleanly.
- **@vitest/snapshot added as devDependency:** `@cloudflare/puppeteer` install with `--legacy-peer-deps` broke vitest module hoisting. Explicit devDependency fixes.
- **BROWSER binding not testable in vitest-pool-workers:** Tests verify routing and state transitions, not actual browser navigation. Real browse validated manually with `wrangler dev`.
**Hindsight Pin:** unchanged (v0.4.16 @ 58fdac4)
**Fixture Data:** N/A — integration wiring only
**Blockers:** None
**Next:** Phase 2.4 — Bootstrap Import

---

## Session 2.4 — 2026-03-10

**Spec:** Phase 2.4 — Bootstrap Import
**Built:**
- src/types/bootstrap.ts (75 lines) — BootstrapParams, InterviewState, INTERVIEW_DOMAINS (5 domains, 12 questions)
- src/services/bootstrap/interview.ts (79 lines) — question flow, answer retention as semantic/user_authored
- src/services/bootstrap/historical-import.ts (139 lines) — Gmail/Calendar/Drive batch to QUEUE_BULK, date weighting
- src/workflows/bootstrap.ts (104 lines) — BootstrapWorkflow: 3-phase durable import via step.do()
- src/tools/bootstrap.ts (103 lines) — MCP tools: brain_v1_bootstrap_start + brain_v1_bootstrap_interview_next
- src/workers/ingestion/bootstrap-handlers.ts (90 lines) — QUEUE_BULK consumer handlers for bootstrap imports
- migrations/1007_brain_bootstrap.sql (12 lines) — ALTER TABLE tenants: bootstrap_status, workflow_id, items_imported
- src/types/env.ts (49 lines) — Added BOOTSTRAP_WORKFLOW: Workflow binding
- src/workers/mcpagent/do/McpAgent.ts (150 lines) — bootstrap tool registration via extracted module
- src/workers/mcpagent/index.ts (146 lines) — re-export BootstrapWorkflow
- src/workers/ingestion/consumer.ts (90 lines) — bootstrap message type dispatch
- src/workers/ingestion/handlers.ts (102 lines) — re-export bootstrap handlers
- wrangler.toml (142 lines) — [[workflows]] binding: brain-bootstrap
- tests/2.4-interview.test.ts (105 lines) — 6 tests
- tests/2.4-import.test.ts (113 lines) — 10 tests
**Decisions:**
- **Bootstrap tools extracted to src/tools/bootstrap.ts:** McpAgent.ts hit 241 lines. Context-injection pattern via `BootstrapContext` interface cleanly separates DO state from tool logic.
- **Bootstrap handlers extracted to bootstrap-handlers.ts:** handlers.ts hit 179 lines. Re-exported via handlers.ts for backward-compatible imports from consumer.ts.
- **Functional InterviewState over class:** Serializable state object for DO SQLite persistence. Pure functions are easier to test and persist than class instances.
- **step.do() polling for interview vs step.waitForEvent():** Polling D1 for `interview_completed_at` with retry config is simpler than coordinating external `instance.sendEvent()` calls. Interview completes in minutes.
- **Workflow type is global:** `Workflow` type doesn't need importing — it's a global Workers type like `D1Database`.
- **Miniflare doesn't support Workflows:** Tests exercise service functions directly. Workflow orchestration validated manually.
**Hindsight Pin:** unchanged (v0.4.16 @ 58fdac4)
**Fixture Data:** N/A — infrastructure only
**Blockers:** None
**Next:** Phase 3.1 or next build sequence phase

---

## Session 1.4 â€” 2026-03-10

**Spec:** Phase 1.4 â€” Pages UI + Approval Queue + Settings
**Built:**
- `pages/` Vite React SPA â€” Queue, Activity Log, Settings, typed API client, countdown hook, styling, Pages Function proxy
- `src/services/action/approval-api.ts` (149 lines) â€” list/approve/reject action route logic
- `src/services/action/preference-model.ts` (88 lines) â€” preference DTO + HMAC-backed mapping
- `src/services/action/preferences.ts` (130 lines) â€” tenant settings read + preference upsert + audit batch
- `src/workers/mcpagent/routes/approval.ts` (66 lines) â€” `GET /api/actions`, `POST /api/actions/:id/approve`, `POST /api/actions/:id/reject`
- `src/workers/mcpagent/routes/settings.ts` (64 lines) â€” `GET /api/settings`, `POST /api/settings/preferences`
- `src/workers/mcpagent/routes/audit.ts` (51 lines) â€” `GET /api/audit`
- `src/workers/mcpagent/index.ts` + `tests/test-entry.ts` â€” mounted `/api/actions`, `/api/settings`, `/api/audit`; mounted undo router at `/api/actions/:id/undo`
- `tests/1.4-approval-queue.test.ts` + `tests/1.4-settings.test.ts` + `tests/support/cf-access.ts` â€” 9 protected-route tests via `SELF.fetch()`
- `scripts/generate-manifest.ts` + `scripts/postflight-check.ts` â€” now scan `pages/src/` and `pages/functions/`
**Decisions:**
- **WebSocket uses Worker `/ws` + `VITE_WORKER_URL`.** The existing DO upgrade path already lives on `/ws`; the browser connects directly to the Worker while normal API traffic stays same-origin through Pages Functions.
- **Pages-first sessions bootstrap tenants in API routes.** `getOrCreateTenant()` now runs on the new protected Pages APIs so a user doesn't need to hit `/mcp` or `/ws` first.
- **Undo exposed under `/api/actions/:id/undo` without removing `/actions/:id/undo`.** This keeps the Pages proxy surface uniform while preserving the original Worker route.
- **Postflight caught line-limit regressions immediately.** Approval logic and preference-model helpers were extracted into service modules instead of waiving limits.
**Verification:**
- `npm test` â€” 138 passed
- `npm run postflight` â€” passed after refactor
- `npm run manifest` â€” regenerated
- `cd pages && npm install && npm run build` â€” passed
**Hindsight Pin:** unchanged (v0.4.16 @ 58fdac4)
**Fixture Data:** Protected-route tests seed `pending_actions`, `tenant_action_preferences`, and `tenants` rows per test case
**Blockers:** Manual deployment steps remain â€” attach the Pages project to CF Access, set `WORKER_URL`, and set `VITE_WORKER_URL`
**Next:** Phase 3.1 or next reviewed active spec

---

## Session 3.1 — 2026-03-10

**Spec:** Phase 3.1 — BaseAgent + Chief of Staff + Layer 1 Router
**Built:**
- src/agents/types.ts (60 lines) — EpistemicMemoryType, AgentType, AgentContext, DoomLoopState, ReasoningTrace, DelegationSignal
- src/agents/base-agent.ts (149 lines) — Abstract BaseAgent: open/run/close lifecycle, agent loop, Law 3 retain()
- src/agents/helpers.ts (49 lines) — checkDoomLoop, encryptForR2, writeAnomalySignal, budget constants
- src/agents/chief-of-staff.ts (66 lines) — ChiefOfStaff extends BaseAgent, delegation signal parsing
- src/services/agents/router.ts (55 lines) — Layer 1 Router: pattern-first, Workers AI 8B classifier fallback
- tests/3.1-base-agent.test.ts (109 lines) — 10 tests: Law 3, doom loop, context, budget
- tests/3.1-chief-of-staff.test.ts (63 lines) — 6 tests: delegation, trace chaining
- tests/3.1-router.test.ts (42 lines) — 6 tests: pattern matching, fallback
- tests/3.1-cron-kek.test.ts (72 lines) — 4 tests: KEK columns, TTL, idempotency
**Decisions:**
- **BaseAgent split into two files:** Postflight 150-line limit forced extraction of doom loop, encryption, and anomaly helpers to `src/agents/helpers.ts`. Re-exported from base-agent.ts.
- **McpAgent.ts not modified:** Agent classes are standalone; DO wiring deferred to Phase 3.2 delegation protocol.
- **Cron KEK raw KV entry deferred:** Spec 3.1 confirms existing encrypted KEK path only. Raw KV entry for cron access is Phase 3.3.
- **Doom loop push-on-warn fix:** Initial implementation didn't push to calls array on 'warn', preventing escalation to 'break'. Fixed by pushing before checking warn threshold.
**Hindsight Pin:** unchanged (v0.4.16 @ 58fdac4)
**Fixture Data:** KEK tests seed tenants rows per test case
**Blockers:** None
**Next:** Phase 3.2 — Career Coach (First Domain Agent)

---

## Session 3.2 — 2026-03-10

**Spec:** Phase 3.2 — Career Coach (First Domain Agent)
**Built:**
- src/agents/career-coach.ts (100 lines) — CareerCoach extends BaseAgent, career-specific open/close/synthesis
- src/agents/types.ts (73 lines) — Added CareerContext interface
- src/tools/memory.ts (64 lines) — memory_search + memory_write MCP tools (Zod excludes procedural+world)
- src/workers/mcpagent/do/McpAgent.ts (148 lines) — wired registerMemoryTools, version 3.2.0
- tests/3.2-career-coach.test.ts (92 lines) — 10 tests
- tests/3.2-memory-interface.test.ts (85 lines) — 9 tests
**Decisions:**
- **Memory tools extracted to src/tools/memory.ts:** McpAgent.ts at 150-line ceiling. Same context-injection pattern as bootstrap tools.
- **career_context + career_note session-scoped tools deferred:** Requires DO lifecycle wiring; Career Coach works as standalone class without session-scoped tools.
- **memory_write excludes both procedural AND world:** Law 3 blocks procedural; world enters via ingestion pipeline only, not MCP callers.
- **recallViaService reused in CareerCoach open():** Instead of raw Hindsight calls with encryptQuery, uses existing pattern from tools/recall.ts.
**Hindsight Pin:** unchanged (v0.4.16 @ 58fdac4)
**Fixture Data:** N/A — type-level and schema-level tests
**Blockers:** None
**Next:** Phase 3.3 — Nightly Consolidation Cron

---

## Session 3.4 — 2026-03-10

**Spec:** Phase 3.4 — Morning Brief + Predictive Heartbeat
**Built:**
- src/cron/morning-brief.ts (93 lines) — brief assembly + 3-channel delivery (Telegram, DO broadcast, Obsidian)
- src/cron/brief-sections.ts (91 lines) — 7 section fetchers extracted for postflight limit
- src/cron/heartbeat.ts (61 lines) — 30-min predictive heartbeat, 8AM-8PM UTC, alert-only sends
- src/cron/weekly-synthesis.ts (81 lines) — Friday 5PM synthesis via Workers AI + Telegram + Obsidian
- src/cron/kek.ts (42 lines) — KEK fetch, validate, derive CryptoKey for cron jobs
- src/cron/obsidian-poll.ts (40 lines) — extracted obsidian poll from index.ts
- src/services/delivery/telegram.ts (30 lines) — Telegram bot sendMessage
- src/services/delivery/obsidian-write.ts (51 lines) — Google Drive /from-brain/ write
- migrations/1008_brain_consolidation.sql (37 lines) — consolidation_runs + consolidation_gaps
- tests/3.4-morning-brief.test.ts — 9 tests
- tests/3.4-heartbeat.test.ts — 7 tests
- tests/3.4-weekly-synthesis.test.ts — 6 tests
- tests/3.4-telegram.test.ts — 6 tests
- Modified: env.ts, index.ts, settings.ts, tenant.ts, wrangler.toml
**Decisions:**
- **Phase 3.3 skipped (user redesigning).** 3.4's prerequisites (consolidation tables, kek.ts, raw KEK KV write) built as part of 3.4.
- **Raw KEK bytes stored in KV** via `provisionOrRenewKek()` with 24h TTL — accepted tradeoff for cron access.
- **morning-brief.ts split into two files** when postflight caught 175-line violation. Section fetchers extracted to brief-sections.ts.
- **Obsidian poll extracted to separate module** to keep index.ts under 150 lines after adding cron dispatch switch.
- **Column name mismatches discovered:** spec's `tool_name` → actual `action_type`, `payload_encrypted` → `payload_r2_key`, missing `proposed_by`. Added to LESSONS.md.
**Verification:**
- `npm test` — 212 passed (30 files, 0 failures)
- `npm run postflight` — passed
- `npm run manifest` — regenerated
**Hindsight Pin:** unchanged (v0.4.16 @ 58fdac4)
**Fixture Data:** Tests seed tenants, pending_actions, consolidation_runs, consolidation_gaps
**Blockers:** None — Telegram secrets and Brave API key must be set before deploy
**Next:** Phase 3.3 (redesigned) or Phase 4.1

---

## Session 3.3 — 2026-03-10

**Spec:** Phase 3.3 — Nightly Consolidation v2
**Built:**
- src/cron/consolidation.ts (80 lines) — orchestrator: webhook + cron entry, dedup, 4-pass sequential
- src/cron/passes/pass1-contradiction.ts (69 lines) — /memories/list + /history structural signal + LLM
- src/cron/passes/pass2-bridges.ts (81 lines) — /graph structural hole detection, max 5 bridges
- src/cron/passes/pass3-patterns.ts (63 lines) — sole procedural write path, confidence > 0.6, max 3
- src/cron/passes/pass4-gaps.ts (62 lines) — /reflect with response_schema, D1 only, max 3
- src/cron/kek.ts (57 lines) — added encryptWithKek/decryptWithKek (AES-256-GCM)
- src/agents/base-agent.ts (148 lines) — mental model load via Hindsight /mental-models API
- src/types/env.ts (54 lines) — added HINDSIGHT_WEBHOOK_SECRET
- src/workers/mcpagent/index.ts (149 lines) — /hindsight/webhook route + 0 2 cron dispatch
- migrations/1008_brain_consolidation.sql (38 lines) — rewritten v1→v2 (4 passes, trigger, dedup index)
- 7 test files, 30 tests
**Decisions:**
- **Migration 1008 rewritten from v1 to v2:** 6-pass columns replaced with 4-pass + trigger + dedup unique index.
- **KV key kept as `cron_kek:{tenantId}`** (not spec's `cron_kek_raw:{tenantId}`): consistency with existing 3.4 implementation.
- **Pass 1 uses subquery for tenant_id in anomaly_signals:** Pass receives bankId (Hindsight), not tenantId — subquery from consolidation_runs resolves it.
- **2.4 bootstrap addendum deferred:** observations_mission, mental models, webhook registration need manual 2.4 update since 2.4 is already completed.
- **Postflight counts trailing newline:** `split('\n').length` counts +1 vs `wc -l`. Files need 149 content lines, not 150.
**Verification:**
- `npm test` — 242 passed (37 files, 0 failures)
- `npm run postflight` — passed
- `npm run manifest` — regenerated
**Hindsight Pin:** unchanged (v0.4.16 @ 58fdac4)
**Fixture Data:** Tests seed tenants, anomaly_signals, consolidation_runs, consolidation_gaps
**Blockers:** 2.4 bootstrap addendum (observations_mission, mental models, webhook) needs manual update
**Next:** Phase 4.1 or next reviewed active spec

---

## Session 2.4a — 2026-03-10

**Spec:** Phase 2.4a — Bootstrap Hindsight Configuration Addendum
**Built:**
- src/services/bootstrap/hindsight-config.ts (100 lines) — configureHindsightBank, createMentalModels, registerConsolidationWebhook
- src/workflows/bootstrap.ts (128 lines) — added 4 step.do() (lookup-bank, config, models, webhook) before bootstrap-complete
- src/types/env.ts (55 lines) — added WORKER_DOMAIN
- scripts/backfill-hindsight-config.ts (91 lines) — one-time backfill for existing tenant
- wrangler.toml — added WORKER_DOMAIN var
- tests/2.4a-hindsight-config.test.ts (119 lines) — 9 tests
**Decisions:**
- **Extracted to service module:** 3 Hindsight config functions in `hindsight-config.ts` to keep bootstrap.ts under 150 lines.
- **Added lookup-hindsight-bank step:** BootstrapParams has tenantId but not hindsightBankId — D1 lookup needed.
- **Partial mental model failure non-blocking:** Promise.allSettled + console.error. Brain works without perfect mental models.
- **Backfill manual:** Script created but deferred to when live Hindsight instance is available.
**Verification:**
- `npm test` — 251 passed (38 files, 0 failures)
- `npm run postflight` — passed
- `npm run manifest` — regenerated
**Hindsight Pin:** unchanged (v0.4.16 @ 58fdac4)
**Fixture Data:** Tests use mock env objects (no D1 needed — service function unit tests)
**Blockers:** Backfill script needs live Hindsight to execute; 3 pre-finalization items deferred to deploy
**Next:** Phase 4.1 or next reviewed active spec

---

## Session OPS.1 — 2026-03-15

**Spec:** Operational — CF Access Configuration & Dashboard Deployment Fix
**Built:**
- pages/functions/api/[[catchall]].ts (57 lines) — Pages-to-Worker proxy with JWT forwarding via `X-Forwarded-Access-Jwt`
- src/middleware/auth.ts — added `X-Forwarded-Access-Jwt` fallback header read, multi-AUD support
**Decisions:**
- **Custom JWT header for bypass routes:** CF Access strips `CF-Access-Jwt-Assertion` on bypass policies. Proxy copies JWT to `X-Forwarded-Access-Jwt` which CF Access doesn't touch.
- **Pages deploy from subdirectory:** `wrangler pages deploy dist` must run from `pages/` CWD — Functions discovery is relative to CWD, not the dist path.
- **7 CF Access apps total:** 3 auth gates (Pages custom domain, Pages.dev, Worker) + 4 bypass policies (API proxy, 3 webhooks). All bypass policies verified needed.
- **Multi-AUD in CF_ACCESS_AUD secret:** Worker accepts JWTs from both Worker direct (CF Access AUD) and Pages proxy (`X-Forwarded-Access-Jwt`) using comma-separated AUDs.
**Verification:**
- Tenant created in D1: `f51239...fcc2e6`, hindsight_tenant_id: `71e465df-...`
- Dashboard loads "Loading approval queue..." with zero console errors
- Worker tail confirms requests reaching Worker via proxy
**Hindsight Pin:** unchanged (v0.4.16 @ 58fdac4)
**Fixture Data:** N/A — operational deployment session
**Blockers:** None
**Next:** MCP/WS bypass policies when those are ready to integrate

---

## Session OPS.2 — 2026-04-17

**Spec:** Operational — Hindsight full completion closeout
**Built:**
- src/services/hindsight.ts — shared Hindsight transport finalized around API-only runtime, fresh shared identities, and dedicated worker prewarm
- src/workers/mcpagent/do/HindsightContainer.ts — dedicated worker entrypoint restored on the container class; API + worker topology locked in
- src/cron/hindsight-operations.ts — async retain polling/reconciliation became the durable source of truth for completion
- docs/hindsight-ops-runbook.md — operator truth, legacy-pending guidance, and dedicated-worker diagnostics documented
- docs/fold-hindsight-handoff.md — direct lessons for Fold from HAETSAL’s live repair
- README.md / ARCHITECTURE.md / docs/full_system_walkthrough.md / MANIFEST.md — top-level truth files updated to the actual production topology
**Decisions:**
- Hindsight’s production shape for HAETSAL is now canonical: API-only container + dedicated Hindsight worker containers + direct Neon + direct interactive `async=true` retain.
- Interactive writes stay on Hindsight’s native async path; HAETSAL queues remain for external/bulk ingestion, not as a second front-door queue for every MCP write.
- Fresh container identities were worth keeping during rollout because they flushed wedged shared instances without changing the public interface.
- Cloudflare container health counters are informative but subordinate to operation completion and delayed fact recall when judging Hindsight health.
**Verification:**
- `npx vitest run tests/2.4b-hindsight-container-runtime.test.ts tests/3.3-hindsight-operations.test.ts` — passed
- live deploy: `c0fd595f-a94a-4737-bf35-070e4ef63810`
- fresh writes completed live under dedicated-worker topology:
  - `73f148c2-47a4-46f1-8665-e0f90ef0afbb`
  - `fa885f41-87af-4dba-9af1-c3c8ba3df801`
- previously lingering pending op `ec4b1247-2704-4234-bda8-a2683579628c` drained to `completed`
**Hindsight Pin:** `ghcr.io/vectorize-io/hindsight-api:0.5.2`
**Fixture Data:** Live synthetic users `test-user-smoke-v4-api-*` with fact-style retain/recall smoke
**Blockers:** None for the Hindsight brain itself; remaining repo debt is outside the Hindsight completion scope
**Next:** Separate release-doc / repo-health cleanup, not more Hindsight surgery

---

## Session OPS.3 — 2026-04-18

**Spec:** Operational — Hindsight parity proof against the clean-room baseline
**Built:**
- wrangler.toml — restored repo truth to dedicated-worker mode for the parity deploy
- src/workers/mcpagent/do/HindsightContainer.ts — added `HINDSIGHT_API_MIGRATION_DATABASE_URL` to match the clean-room harness
- tests/2.4b-hindsight-container-runtime.test.ts — covered the migration DB URL in the runtime env contract
**Decisions:**
- The clean-room `hindsight-baseline` repo is the source of truth for Hindsight runtime behavior; HAETSAL should match it on container/runtime settings instead of relying on older folklore.
- `HINDSIGHT_API_MIGRATION_DATABASE_URL` is part of the stable container env contract for both the API and worker processes.
- Service-token `/mcp` smoke remains the fastest truthful production proof because it exercises the actual auth, capture, Hindsight async, and recall path end to end.
- Passing recall should be judged semantically, not as exact-text retrieval; Hindsight may normalize numeric facts (`23.4M-*` became `23.4 million`) while still returning the right memory.
**Verification:**
- `npx vitest run tests/2.4b-hindsight-container-runtime.test.ts tests/2.1-retain.test.ts tests/3.3-hindsight-operations.test.ts` — passed
- `npm run postflight` — passed
- live deploy: `6f96700f-ab07-4212-9e90-ac2535b00fe9`
- fresh service-token `/mcp` write:
  - `memory_id` / operation id: `325e0d35-0d0f-47af-b10d-4a35ea32949e`
  - requested at: `1776573277289`
  - completed at: `1776573540001`
  - available at: `1776573578875`
- remote D1 recorded:
  - `retain_queued`
  - `memory.retain_delayed`
  - `memory.retain_available`
  - `memory.retain_completed`
- live `memory_search` returned semantically correct recall for the fresh revenue-guidance fact after completion
**Hindsight Pin:** `ghcr.io/vectorize-io/hindsight-api:0.5.2`
**Fixture Data:** Service-token smoke tenant derived from `haetsal-brain-shell-smoke`
**Blockers:** None for the full live proof on the parity deploy
**Next:** Compare this passing parity state against Fold, or do a dedicated-worker v0.5.3 follow-up if we want to re-open the upstream worker-fix lane

---

## Session OPS.4 — 2026-04-19

**Spec:** Operational — final dedicated-worker re-proof
**Built:** No code changes; this session was a live proof run against the parity-aligned dedicated-worker deployment
**Decisions:**
- HAETSAL’s dedicated-worker topology is now explicitly re-proven under the current parity config; Hindsight can be treated as operationally healthy again.
- The clean-room baseline and HAETSAL now agree on the Hindsight runtime contract closely enough that future regressions should be investigated as config/runtime drift first, not as assumed Hindsight defects.
- Recall validation remains semantic: the fresh `31.8M-*` write came back as `31.8 million`, which is acceptable and expected for Hindsight’s synthesis-oriented recall surface.
**Verification:**
- fresh service-token `/mcp` dedicated-worker write:
  - `memory_id` / operation id: `aebae39b-639a-4f9b-a117-2d2c094469fd`
  - requested at: `1776574129991`
  - completed at: `1776574146576`
  - available at: `1776574165730`
- remote D1 final state:
  - `status = completed`
  - `slow_at = null`
  - `stuck_at = null`
- live `memory_search` returned the fresh dedicated-worker fact as semantically normalized recall (`31.8 million`)
**Hindsight Pin:** `ghcr.io/vectorize-io/hindsight-api:0.5.2`
**Fixture Data:** Service-token smoke tenant derived from `haetsal-brain-shell-smoke`
**Blockers:** None
**Next:** Shift Hindsight work back to normal maintenance; any further Hindsight work should be deliberate follow-up, not emergency repair

---
## Session 8.1 â€” 2026-04-19

**Spec:** Phase 8.1 â€” Graphiti Projection Design
**Built:**
- src/types/canonical-graph-projection.ts (108 lines) â€” Graphiti deployment posture, canonical graph projection contract, reconciliation/status types
- src/services/canonical-graph-projection-design.ts (117 lines) â€” staged deployment decision, episode/entity/edge mapping helpers, entity/edge reconciliation, graph status derivation
- src/services/canonical-memory-status.ts (143 lines) â€” added top-level `graph` subsection to canonical `memory_status`
- src/types/canonical-memory-query.ts (142 lines) â€” extended canonical status contract with `graph`
- tests/8.1-graphiti-projection-design.test.ts (114 lines) â€” design-contract coverage for note/conversation/artifact mapping, reconciliation, and graph status
- tests/fixtures/graphiti/*.json â€” entity, edge, and status design fixtures
- specs/completed/8.1-graphiti-projection-design.md â€” As-Built finalized and spec moved out of `active`
- MANIFEST.md â€” regenerated for the new contract/service/test files
**Decisions:**
- **Initial Graphiti posture is staged external-first:** Cloudflare remains the canonical auth/queue/orchestration shell while Session 8.2 targets an external Graphiti runtime first, with Cloudflare Containers reserved as the later in-platform steady-state.
- **Graph contract stays design-only in 8.1:** no live ingestion worker, no queue consumer changes, and no new public Graphiti route.
- **Canonical graph identity is anchor-first:** scope/source/document/artifact entities reuse deterministic canonical keys; conversation participants and title-derived topics use stable-literal anchors where full extraction/merge is deferred to later Graphiti runtime work.
- **Temporal rules are asymmetric on purpose:** structural edges dedupe by endpoints + relation, while conversation/history-style edges append observations by valid time instead of replacing prior state.
- **Canonical status grows before runtime fan-out:** `memory_status` now carries a small top-level `graph` subsection so Session 8.2 can plug into an explicit contract instead of inventing new status semantics during ingestion work.
**Verification:**
- `npx vitest run tests/8.1-graphiti-projection-design.test.ts` â€” passed
- `npm test` â€” passed (`316 passed`, `1 skipped`)
- `npm run postflight` â€” passed
- `npm run manifest` â€” passed
**Hindsight Pin:** unchanged (`ghcr.io/vectorize-io/hindsight-api:0.5.2`)
**Fixture Data:** Reused canonical note/conversation/artifact fixtures and added graphiti entity/edge/status fixtures
**Blockers:** None
**Next:** Phase 8.2 â€” Graphiti ingestion projection

---
## Session 8.2 - 2026-04-19

**Spec:** Phase 8.2 - Graphiti Ingestion Projection
**Built:**
- `src/services/canonical-graphiti-payload.ts` - KEK-encrypted Graphiti payload materialization and projection-job context loading
- `src/services/canonical-graphiti-projection.ts` - live Graphiti submission path behind the canonical projection consumer
- `src/services/canonical-graphiti-reconcile.ts` - truthful graph projection state writes plus canonical-to-graph identity mapping persistence
- `src/workers/ingestion/canonical-projection-consumer.ts` - fan-out now routes both `hindsight` and `graphiti` jobs through the shared canonical dispatch lane
- `src/services/canonical-capture-pipeline.ts` - canonical capture now materializes both Hindsight and Graphiti projection payloads without leaking content into D1/KV/queue payloads
- `src/types/canonical-graph-projection.ts` and `src/services/canonical-graph-projection-design.ts` - added deterministic edge canonical keys plus live Graphiti submission/mapping types
- `migrations/1018_graphiti_ingestion_projection.sql` - added `canonical_graph_identity_mappings`
- `tests/8.2-graphiti-ingestion-projection.test.ts` - note, conversation, and failure/retry Graphiti ingestion coverage
- `specs/active/8.2-graphiti-ingestion-projection.md` - As-Built completed
- `MANIFEST.md` - regenerated
**Decisions:**
- Graphiti follows the 8.1 staged posture: trusted external runtime first, Cloudflare queue shell now, Containers later if we choose to internalize the service.
- Queue payloads remain metadata-only; Graphiti reads decrypted content only from a KEK-encrypted R2 payload inside the trusted projection runtime path.
- Canonical-to-graph identity truth needs its own table. Episode, entity, and edge refs now persist in `canonical_graph_identity_mappings` keyed by projection job plus canonical anchor.
- Deterministic edge canonical keys shipped in 8.2 so edge mappings can be persisted and retried coherently instead of being inferred ad hoc.
- Graphiti execution is configuration-gated by `GRAPHITI_API_URL`; when the runtime is not configured, canonical graph jobs stay queued rather than being marked failed by a missing engine.
**Verification:**
- `npx vitest run tests/8.2-graphiti-ingestion-projection.test.ts` - passed
- `npm run postflight` - passed
- `npm test` - passed (`319 passed`, `1 skipped`)
- `npm run manifest` - passed
**Hindsight Pin:** unchanged (`ghcr.io/vectorize-io/hindsight-api:0.5.2`)
**Fixture Data:** Reused canonical note/conversation fixtures and added Graphiti ingestion assertions for episode/entity/edge mappings plus failure/retry recovery
**Blockers:** None
**Next:** Phase 8.3 - graph and timeline query surface

---
## Session 8.3 - 2026-04-19

**Spec:** Phase 8.3 - Graph / Timeline Query Surface
**Built:**
- `src/services/canonical-graph-query.ts` - canonical graph/timeline reads over completed Graphiti projection mappings with canonical provenance linkback
- `src/services/canonical-composed-graph-context.ts` - narrow explicit graph-backed composed retrieval helper for `search_memory(mode = 'graph')`
- `src/types/canonical-graph-query.ts` - graph/timeline query/result contracts separated from the broader canonical memory types to stay within file-size limits
- `src/services/canonical-memory-query.ts` - canonical query path now supports explicit `graph` mode while preserving lexical default and semantic mode behavior
- `src/tools/canonical-memory.ts` - canonical MCP surface now registers `trace_relationship` and `get_entity_timeline`
- `src/types/canonical-memory-query.ts` - canonical list item now supports graph-backed provenance/context metadata without widening into a Phase 9 router
- `tests/8.3-graph-timeline-query-surface.test.ts` - relationship tracing, ordered entity timeline, narrow graph-mode search, and lexical-regression coverage
- `tests/6.2-canonical-mcp-memory-surface.test.ts` - canonical tool-surface expectation updated for the additive 8.3 tools
- `specs/active/8.3-graph-timeline-query-surface.md` - As-Built completed with shipped surface, migration decision, scope, and deviations
- `MANIFEST.md` - regenerated
**Decisions:**
- `trace_relationship` ships as the smallest architecture-consistent canonical read: direct single-hop relationship tracing over completed Graphiti projection mappings rather than arbitrary multi-hop traversal.
- `get_entity_timeline` uses canonical graph identity mappings plus canonical capture metadata as the timeline truth source, keeping Graphiti internal and preserving canonical provenance/linkback.
- The narrow graph-backed composed retrieval path ships as `search_memory(mode = 'graph')`; Phase 9 automatic routing, cross-engine ranking, and multi-mode heuristics remain intentionally out of scope.
- No new public HTTP surface and no query-side content cache were introduced. Graph reads remain metadata-first and do not copy raw memory content into D1, KV, Analytics Engine, or caches.
- No migration was needed for 8.3; existing 8.2 graph identity mappings plus projection job/result rows were sufficient.
**Verification:**
- `npx vitest run tests/8.3-graph-timeline-query-surface.test.ts` - passed
- `npm test` - passed (`323 passed`, `1 skipped`)
- `npm run postflight` - passed
- `npm run manifest` - passed
**Hindsight Pin:** unchanged (`ghcr.io/vectorize-io/hindsight-api:0.5.2`)
**Fixture Data:** Reused canonical note/conversation fixtures and 8.2 Graphiti projection behavior; added 8.3 graph/timeline assertions through the canonical MCP surface
**Blockers:** None
**Next:** Phase 9 only when explicitly requested; Session 8.3 stops at explicit graph/timeline reads plus the narrow graph-mode composed path

---
## Session OPS.5 - 2026-04-19

**Spec:** Operational - checkout workflow alignment for active specs
**Built:**
- `scripts/checkout.ts` - checkout now auto-detects the single active spec in `specs/active/` and moves it to `specs/completed/` without requiring `--spec` / `--move-spec`
**Decisions:**
- A plain session checkout should respect the repo governance workflow when there is exactly one active spec; requiring extra flags in that case creates avoidable operator error and breaks the intended finish-the-session flow.
- Explicit `--spec` remains supported, but single-active-spec inference is now the default behavior.
**Verification:**
- `npm run checkout` - now reaches spec governance correctly; currently blocked by unrelated `specs/active/9.1-multi-mode-memory-router.md` missing `## As-Built Record`
**Blockers:** None
**Next:** Once the unrelated 9.1 active spec is lifecycle-complete, plain checkout can infer the lone active spec and move it without extra flags

---
## Session 9.2 - 2026-04-19

**Spec:** Phase 9.2 - Chief-of-Staff Context Builder
**Built:**
- `src/types/chief-of-staff-context.ts` - typed context-bundle contract for `prepare_context_for_agent`
- `src/services/chief-of-staff-context.ts` - read-only bundle assembly on top of canonical raw, semantic, and graph reads
- `src/tools/canonical-memory.ts` - canonical memory tool surface now registers `prepare_context_for_agent`
- `src/tools/brain-memory-surface.ts` - brain-memory registry updated for the additive canonical tool
- `tests/9.2-chief-of-staff-context-builder.test.ts` - person bundle, project bundle, sparse-graph fallback, provenance, and public-contract coverage
- `tests/6.2-canonical-mcp-memory-surface.test.ts` - canonical tool inventory updated for the new surface
- `specs/active/9.2-chief-of-staff-context-builder.md` - As-Built Record completed
**Decisions:**
- Session 9.2 stays a read-side context assembly layer only. No Chief-of-Staff action workflow, new HTTP surface, or raw-content cache was introduced.
- `prepare_context_for_agent` remains on the canonical memory surface rather than becoming a private Chief-of-Staff API.
- The builder reuses the 9.1 router plus existing raw/semantic/graph paths instead of inventing a separate retrieval stack.
- `person` and `project` ship as the primary supported bundles; `scope` and `meeting_prep` were added as thin aliases on the same read-only policy without broadening into orchestration work.
- Public bundle output preserves provenance, uncertainty, and gaps while keeping engine-internal Hindsight identifiers out of the surface.
**Verification:**
- `npx vitest run tests/9.2-chief-of-staff-context-builder.test.ts` - passed
- `npm test` - passed (`340 passed`, `1 skipped`)
- `npm run postflight` - passed
- `npm run manifest` - passed
**Hindsight Pin:** unchanged (`ghcr.io/vectorize-io/hindsight-api:0.5.2`)
**Fixture Data:** Reused canonical note/conversation style fixtures and added 9.2 context-bundle scenarios for person, project, and sparse-graph fallback
**Blockers:** None for 9.2 implementation; plain checkout still depends on the repo's active-spec lifecycle state
**Next:** Session 9.3 or later agent-behavior work only when explicitly requested

---
## Session 9.3 - 2026-04-19

**Spec:** Phase 9.3 - External Client And Source Integration Architecture
**Built:**
- `src/types/external-brain.ts` - typed contract for integration surfaces, client/source classes, provenance classes, BYOC working-identity artifacts, and rollout-order fixtures
- `src/services/external-brain-contract.ts` - executable 9.3 architecture fixture layer for `brain-memory`, `brain-sources-read`, `brain-actions`, client mappings, selective source-ingestion patterns, provenance classes, BYOC artifacts, and implementation order
- `src/tools/brain-memory-surface.ts` - smallest scoped-surface wrapper around the existing canonical memory tool family
- `src/workers/mcpagent/do/McpAgent.ts` - live canonical memory registration now goes through the named `brain-memory` surface wrapper
- `tests/9.3-external-client-and-source-integration-architecture.test.ts` - capability-scope, client/source mapping, provenance, BYOC artifact family, rollout-order, and registry-separation coverage
- `specs/active/9.3-external-client-and-source-integration-architecture.md` - As-Built completed with shipped scope, implementation decision, and deviations
**Decisions:**
- Session 9.3 stayed intentionally narrow: one brain, one canonical substrate, no new public HTTP surface, and no broad Chief-of-Staff expansion.
- `brain-memory` is the first real external-client surface and is defined by capability class, not AI vendor brand.
- `brain-sources-read` and `brain-actions` are now explicit architecture contracts, but only `brain-memory` is live; source-read remains planned and actions remain deferred.
- BYOC shipped in the smallest useful form as a portable working-identity artifact family contract with both file and MCP-record delivery assumptions.
- The live `brain-memory` surface mirrors the current canonical registrar at repo head; in this worktree that includes parallel 9.2 `prepare_context_for_agent` work, which 9.3 documents truthfully without broadening into implementing the full 9.2 lane itself.
**Verification:**
- `npx vitest run tests/9.3-external-client-and-source-integration-architecture.test.ts` - passed
- `npm test` - passed (`340 passed`, `1 skipped`)
- `npm run postflight` - passed
- `npm run manifest` - passed
**Hindsight Pin:** unchanged (`ghcr.io/vectorize-io/hindsight-api:0.5.2`)
**Fixture Data:** Added architecture fixtures for memory-only clients, non-MCP web clients, Google source-read connectors, capability scopes, provenance classes, BYOC artifacts, and rollout order
**Blockers:** None for 9.3 itself; plain checkout remains subject to the repo's active-spec lifecycle state when multiple active specs are present
**Next:** Keep 9.3 as the parallel integration-architecture lane; future follow-up should land `brain-sources-read` selectively without widening into a separate brain or premature action surface

---
## Session 9.4 - 2026-04-19

**Spec:** Phase 9.4 - Brain-Memory External Client Rollout
**Built:**
- `src/types/external-client-memory.ts` - typed `brain-memory` rollout contract for external MCP-native client capture modes, profile, and read-side attribution
- `src/services/external-client-memory.ts` - rollout normalization/parsing helpers for explicit, session-summary, and artifact-linked capture
- `src/services/external-client-memory-write.ts` - write-side adapter that keeps external-client capture on the canonical `capture_memory` path
- `src/tools/canonical-memory.ts` - `capture_memory` now accepts narrow rollout-safe external-client fields without introducing a new public tool name
- `src/tools/retain.ts`, `src/services/ingestion/retain.ts`, `src/services/canonical-memory.ts` - retain/canonical pipeline now preserves caller source refs and artifact references through the existing canonical-first flow
- `src/services/canonical-memory-query.ts`, `src/services/canonical-memory-status.ts`, `src/services/canonical-source-attribution.ts`, `src/services/canonical-memory-read-model.ts`, `src/types/canonical-memory-query.ts` - read/status/document results now expose parsed `brainMemory` attribution and artifact-reference details
- `src/types/ingestion.ts`, `src/types/tools.ts` - additive input-contract updates for source refs, artifact refs, and rollout metadata
- `tests/9.4-brain-memory-external-client-rollout.test.ts` - explicit capture, session-close summary capture, artifact-linked capture, readback, and capability-boundary coverage
- `specs/active/9.4-brain-memory-external-client-rollout.md` - As-Built Record completed
- `MANIFEST.md` - regenerated
**Decisions:**
- Session 9.4 shipped as the smallest safe extension of the canonical MCP contract: `capture_memory` remains the write entrypoint and the existing canonical memory tool family remains the read surface.
- `brain-memory` now clearly handles both write and read for MCP-native clients while staying memory-only; no source-read, source-write, BYOC, Chief-of-Staff workflow, or outbound action scope was added.
- The first durable capture patterns are explicit capture, session-close summary capture, and artifact-linked capture. Session-close summary capture is the default recommended compounding pattern.
- Artifact-linked capture preserves normalized meaning plus reference metadata instead of blind raw duplication, and no new D1/KV/raw-content cache was introduced.
- The rollout stayed migration-free. Capture-mode/provenance labeling is reconstructed from canonical source attribution plus artifact metadata rather than a new client-only shadow store.
**Verification:**
- `npx vitest run tests/9.4-brain-memory-external-client-rollout.test.ts` - passed
- `npm test` - passed (`342 passed`, `1 skipped`)
- `npm run postflight` - passed
- `npm run manifest` - passed
**Hindsight Pin:** unchanged (`ghcr.io/vectorize-io/hindsight-api:0.5.2`)
**Fixture Data:** Added 9.4 fixtures for Codex/Claude Code/Cursor-style `brain-memory` captures across explicit, session summary, and artifact-linked flows with provenance-aware readback assertions
**Blockers:** None
**Next:** Session 9.5 or later can build selective `brain-sources-read` on top of the now-concrete `brain-memory` rollout without widening into a second brain or transcript-default retention

---
## Session 9.x - 2026-04-19

**Spec:** Live semantic recall follow-up - fresh `brain-memory` capture projection identity fix
**Built:**
- `src/services/canonical-hindsight-projection-payload.ts` - Hindsight projection identity now uses the canonical capture id for `mcp:memory_write` `brain-memory:*` captures instead of reusing the stable rollout `source_ref`
- `tests/9.4-brain-memory-external-client-rollout.test.ts` - regression coverage for repeated explicit `brain-memory` captures from the same client now asserting distinct Hindsight engine document ids
- `MANIFEST.md` - regenerated
**Decisions:**
- The fix stays surgical and truthful: semantic mode still depends on Hindsight, but fresh explicit `brain-memory` captures no longer collide onto one Hindsight document identity.
- The stable rollout `source_ref` remains valuable for provenance/read attribution; only the Hindsight projection dedup/document identity path changes for `brain-memory` writes.
- No raw fallback or synthetic semantic-ready behavior was introduced.
**Verification:**
- `npx vitest run tests/9.4-brain-memory-external-client-rollout.test.ts` - passed
- `npx vitest run tests/7.1-hindsight-projection-adapter.test.ts tests/7.2-semantic-recall-through-canonical-interface.test.ts` - passed
- `npm test` - passed (`345 passed`, `1 skipped`)
- `npm run postflight` - passed
- `npm run manifest` - passed
**Blockers:** Live Claude Code semantic smoke still needs to be re-run after deploy to confirm the fresh capture path is now green on the public MCP edge.
**Next:** Deploy this Hindsight projection identity fix, then re-run the live Claude Code semantic smoke for fresh explicit `brain-memory` captures.

---
## Session 9.6 - 2026-04-20

**Spec:** Phase 9.6 - Graphiti Internal Container Parity
**Built:**
- `src/services/graphiti-client.ts` - narrow Graphiti runtime seam with `container` as the intended default path and explicit `external` fallback only when requested
- `src/workers/mcpagent/do/GraphitiContainer.ts`, `src/workers/mcpagent/index.ts`, `wrangler.toml` - HAETSAL-owned internal Graphiti container binding plus deployment/runtime wiring
- `graphiti/Dockerfile`, `graphiti/requirements.txt`, `graphiti/app.py` - smallest viable internal Python Graphiti/Kuzu runtime exposing internal health/readiness and canonical projection handoff only
- `src/services/canonical-graphiti-projection.ts`, `src/services/canonical-graph-projection-design.ts`, `src/types/canonical-graph-projection.ts`, `src/types/env.ts` - canonical graph posture moved to `haetsal_internal_container`, submission now flows through the internal runtime seam, and env typing/runtime mode support landed
- `tests/9.6-graphiti-internal-container-parity.test.ts`, `tests/support/graphiti-test-env.ts`, `tests/support/miniflare-service-bindings.ts` - new parity coverage and shared internal Graphiti test bindings
- `tests/7.3-reflection-consolidation-alignment.test.ts`, `tests/8.1-graphiti-projection-design.test.ts`, `tests/8.2-graphiti-ingestion-projection.test.ts`, `tests/8.3-graph-timeline-query-surface.test.ts`, `tests/9.1-multi-mode-memory-router.test.ts`, `tests/9.2-chief-of-staff-context-builder.test.ts`, `tests/9.4-brain-memory-external-client-rollout.test.ts`, `vitest.config.ts` - broader suite aligned to the internal Graphiti container posture
- `specs/active/9.6-graphiti-internal-container-parity.md` - As-Built completed
- `MANIFEST.md` - regenerated
**Decisions:**
- Session 9.6 stayed on the smallest architecture-consistent path: a single internal Graphiti container first, no public Graphiti route, no Rust rewrite, and no attempt to expose Graphiti's full upstream API surface through HAETSAL.
- Hindsight parity was treated as an operational requirement, not style. Graphiti now matches the same internal ownership, Worker/runtime boundary, readiness pattern, and truthful failure semantics where it matters.
- `GRAPHITI_API_URL` / `GRAPHITI_API_TOKEN` are no longer the intended production path. External mode remains only as an explicit migration/testing fallback when `GRAPHITI_RUNTIME_MODE=external`.
- Graph jobs now fail truthfully when container mode is required and unavailable, rather than drifting silently in `queued`.
- Durable Kuzu persistence across container recreation remains a follow-up; 9.6 ships the internal runtime step, not the final persistence story.
**Verification:**
- `npx vitest run tests/9.6-graphiti-internal-container-parity.test.ts` - passed
- `npx vitest run tests/8.2-graphiti-ingestion-projection.test.ts tests/8.3-graph-timeline-query-surface.test.ts tests/9.2-chief-of-staff-context-builder.test.ts` - passed
- `npm test` - passed (`356 passed`, `1 skipped`)
- `npm run postflight` - passed
- `npm run manifest` - passed
- `npx wrangler deploy` - deployed Worker version `9d65e7ba-3422-40fc-bf94-31291f89c1a3`; Graphiti container application created and reported `ready`
**Blockers:** Fresh graph-backed live proof is not fully confirmed yet because the deployed production capture/query surface is behind Cloudflare Access and signed webhook flows, so I could not safely drive a non-interactive fresh protected capture end-to-end from this workspace.
**Next:** Move the 9.6 spec to `specs/completed/`, commit the internal Graphiti container cutover, and later add a safe live smoke path plus durable Kuzu persistence across container recreation.

---
## Session 9.5 - 2026-04-19

**Spec:** Phase 9.5 - Google Source-Read Ingestion Rollout
**Built:**
- `src/types/google-source-read.ts` - typed `brain-sources-read` Google rollout contract
- `src/services/google-source-read-contract.ts` - read-only Google source profile plus provenance-rich source-ref encoding/parsing
- `src/services/google-source-read.ts` - shared Gmail / Calendar / Drive selective source-read orchestration on top of the existing Google and canonical retain plumbing
- `src/services/google/gmail.ts` - additive recent-thread listing plus shared extraction helper reuse
- `src/services/google/calendar.ts` - additive recent-event listing plus shared extraction helper reuse
- `src/services/google/drive.ts` - Docs export/download helper for explicit-inclusion capture
- `src/workers/ingestion/handlers.ts` - Gmail and Calendar queue handlers now flow through the `brain-sources-read` rollout layer
- `src/services/canonical-memory-query.ts`, `src/services/canonical-memory-status.ts`, `src/services/canonical-source-attribution.ts`, `src/types/canonical-memory-query.ts` - canonical reads now expose parsed Google source attribution
- `src/services/external-brain-contract.ts` - `brain-sources-read` moved from planned contract to live rollout for Google read-only ingestion
- `tests/9.5-google-source-read-ingestion-rollout.test.ts` - Gmail, Calendar, Drive/Docs, provenance, and boundary coverage
- `tests/9.3-external-client-and-source-integration-architecture.test.ts` - updated to reflect a live `brain-sources-read` surface that remains distinct from `brain-memory`
- `specs/active/9.5-google-source-read-ingestion-rollout.md` - As-Built Record completed
- `MANIFEST.md` - regenerated
**Decisions:**
- Session 9.5 stayed strictly inside `brain-sources-read`. Google was not blurred into `brain-memory`, and no Google write/action capability was introduced.
- The rollout reuses the existing Google OAuth, Gmail, Calendar, Drive, and canonical retain/capture plumbing instead of introducing a second ingestion stack.
- Drive / Docs shipped explicit-inclusion-first. Capture preserves Google-native file references and provenance instead of building a Drive shadow store.
- Canonical readbacks now surface Google source attribution so the brain can point back to the native Google object truthfully.
- No migration was needed, and no raw Google content store/cache was added to D1, KV, Analytics Engine, or rollout-side caches.
- Gmail and Calendar webhook-triggered ingestion shipped as the smallest safe bounded refresh over recent native objects rather than adding sync-cursor state or naive mirroring in this session.
**Verification:**
- `npx vitest run tests/9.5-google-source-read-ingestion-rollout.test.ts` - passed
- `npm test` - passed (`344 passed`, `1 skipped`)
- `npm run postflight` - passed
- `npm run manifest` - passed
**Hindsight Pin:** unchanged (`ghcr.io/vectorize-io/hindsight-api:0.5.2`)
**Fixture Data:** Added 9.5 fixtures for Gmail selective capture, Calendar selective capture, Drive/Docs explicit-inclusion capture, provenance-rich source refs, and source-read boundary enforcement
**Blockers:** None
**Next:** Checkout can now move 9.5 to `specs/completed/`; any future Google write/actions remain a separate `brain-actions` lane

---
## Session 9.x - 2026-04-19

**Spec:** Live semantic recall follow-up - `brain-memory` async handoff, linkback, and semantic retrieval hardening
**Built:**
- `src/services/canonical-capture-pipeline.ts`, `src/services/external-client-memory-write.ts`, `src/tools/memory.ts`, `src/tools/retain.ts`, `src/services/ingestion/retain.ts`, `src/types/canonical-capture-pipeline.ts` - interactive MCP writes now eagerly dispatch canonical projections again while preserving async Hindsight behavior for the live `brain-memory` path
- `src/services/canonical-hindsight-projection-payload.ts`, `src/services/canonical-hindsight-projection.ts`, `src/services/ingestion/retain-persistence.ts` - Hindsight projection payloads now preserve canonical ids plus async mode truthfully, and queued async retain dedup is unique per operation instead of collapsing repeated writes
- `src/services/canonical-semantic-linkback.ts`, `src/services/canonical-semantic-recall.ts` - semantic linkback now resolves by canonical capture metadata first, and semantic recall no longer over-constrains Hindsight lookup with strict exact tag matching
- `tests/1.2-tools.test.ts`, `tests/7.1-hindsight-projection-adapter.test.ts`, `tests/7.2-semantic-recall-through-canonical-interface.test.ts`, `tests/9.4-brain-memory-external-client-rollout.test.ts`, `tests/support/hindsight-test-env.ts` - regression coverage for eager interactive dispatch, async Hindsight operations, source-tag tolerant semantic recall, canonical metadata linkback, and repeated `brain-memory` captures
- `MANIFEST.md` - regenerated
**Decisions:**
- The repair stays inside the canonical/Hindsight path rather than introducing a second semantic write lane or synthetic "semantic ready" behavior.
- `brain-memory` continues to write asynchronously to Hindsight, but interactive MCP writes now trigger local canonical projection dispatch immediately so live sessions do not depend solely on the bulk queue to begin handoff.
- Hindsight remains the semantic authority; the fix corrects projection identity, async operation truth, linkback, and recall filtering instead of hiding failures with raw fallback.
- Canonical capture/document/operation ids are now preserved in Hindsight-side metadata so semantic results can link back to the correct canonical item even when multiple captures share nearby content.
**Verification:**
- `npx vitest run tests/1.2-tools.test.ts` - passed
- `npx vitest run tests/7.1-hindsight-projection-adapter.test.ts tests/7.2-semantic-recall-through-canonical-interface.test.ts` - passed
- `npx vitest run tests/9.4-brain-memory-external-client-rollout.test.ts` - passed
- `npm run postflight` - passed
**Hindsight Pin:** unchanged (`ghcr.io/vectorize-io/hindsight-api:0.5.2`)
**Fixture Data:** Extended Hindsight test fixtures to model async retain truth, operation-specific dedup, source-tagged recall, and canonical-metadata semantic linkback for repeated `brain-memory` captures
**Blockers:** None on the Hindsight path; Graphiti/container follow-up remains separate work
**Next:** Checkpoint this Hindsight repair tranche before continuing broader Graphiti/container migration work

---

## Session 9.x - 2026-04-20

**Spec:** Live semantic recall follow-up - Hindsight async retain runtime completion hardening
**Built:**
- `src/workers/mcpagent/do/HindsightContainer.ts`, `src/services/hindsight-transport.ts`, `wrangler.toml`, `hindsight/Dockerfile` - Hindsight runtime now prefers the shared API worker safety net, disables dedicated workers in production config, lowers retain retry pressure, bumps the shared instance name, and pins the image to `ghcr.io/vectorize-io/hindsight-api:0.5.3`
- `tests/2.4b-hindsight-container-runtime.test.ts`, `tests/9.4-brain-memory-external-client-rollout.test.ts` - regression coverage for the runtime safety-net env contract and fresh semantic search linkback after truthful completion
- `MANIFEST.md` - regenerated
**Decisions:**
- The remaining freshness gap was treated as a retain-runtime problem, not a status-mapping or semantic fallback problem.
- `memory_status` remains truthful: `semanticReady` only flips after Hindsight actually completes and semantic results are visible through the canonical recall path.
- No raw fallback or synthetic semantic-ready behavior was introduced.
**Verification:**
- `npx vitest run tests/2.4b-hindsight-container-runtime.test.ts tests/7.1-hindsight-projection-adapter.test.ts tests/7.2-semantic-recall-through-canonical-interface.test.ts tests/9.4-brain-memory-external-client-rollout.test.ts` - passed
- `npx vitest run tests/7.1-hindsight-projection-adapter.test.ts tests/7.2-semantic-recall-through-canonical-interface.test.ts tests/9.4-brain-memory-external-client-rollout.test.ts` - passed
- `npm test` - passed (`362 passed`, `1 skipped`)
- `npm run postflight` - passed
- `npm run manifest` - passed
**Hindsight Pin:** `ghcr.io/vectorize-io/hindsight-api:0.5.3`
**Blockers:** Live fresh Hindsight semantic recall is still not confirmed green; raw production Hindsight retain operations were observed stuck in `pending` even while Graphiti completed.
**Next:** Commit and deploy the runtime hardening cut, then re-run protected production fresh-capture proof to confirm whether Hindsight semantic readiness now clears live.

---

## Session 9.9 - 2026-04-20

**Spec:** Tenant Memory Trace
**Built:**
- `src/services/canonical-broker-trace-read.ts`, `src/services/canonical-broker-trace-view.ts`, `src/types/canonical-memory-broker.ts` - tenant-scoped broker trace readback now lists recent traces and hydrates full trace detail from the existing 9.8 D1 + encrypted R2 storage shape
- `src/tools/canonical-memory.ts`, `src/tools/canonical-memory-schema.ts`, `src/tools/brain-memory-surface.ts` - canonical memory surface now exposes `get_recent_memory_traces` and `get_memory_trace` as additive tenant-facing tools
- `src/services/external-client-memory.ts`, `src/types/external-client-memory.ts` - `brain-memory` surface profile now includes the tenant trace readback tools
- `src/tools/hindsight-debug.ts`, `src/services/canonical-hindsight-debug.ts` - existing tenant-scoped Hindsight debug surface was wired back into the canonical registrar so the declared `brain-memory` tool registry stayed internally consistent
- `tests/9.9-tenant-memory-trace.test.ts`, `tests/6.2-canonical-mcp-memory-surface.test.ts` - coverage for recent trace listing, hydrated readback, missing-detail fallback, cross-tenant rejection, and additive canonical tool registration
- `specs/active/9.9-tenant-memory-trace.md` - As-Built Record completed
- `MANIFEST.md` - regenerated
**Decisions:**
- Session 9.9 stayed strictly read-side and migration-free on top of the 9.8 broker trace storage shape.
- Structured summary rows remain in D1 `canonical_broker_traces`; rich detail remains tenant-encrypted in `R2_OBSERVABILITY`.
- Missing or undecryptable rich detail returns a truthful gap via `detailStatus` instead of failing the whole trace read.
- No platform-owner raw-content analytics or cross-tenant trace surface was introduced.
**Verification:**
- `npx vitest run tests/9.9-tenant-memory-trace.test.ts` - passed
- `npx vitest run tests/9.8-broker-primary-shadow-retrieval.test.ts tests/9.2-chief-of-staff-context-builder.test.ts tests/7.2-semantic-recall-through-canonical-interface.test.ts tests/8.3-graph-timeline-query-surface.test.ts tests/9.7-graphiti-entity-relation-projection.test.ts` - passed
- `npm test` - passed (`372 passed`, `1 skipped`)
- `npm run postflight` - passed
- `npm run manifest` - passed
- live protected MCP proof after deploy - passed for fresh semantic query, fresh graph query, `prepare_context_for_agent`, `get_recent_memory_traces`, and `get_memory_trace`
**Hindsight Pin:** unchanged (`ghcr.io/vectorize-io/hindsight-api:0.5.3`)
**Blockers:** None
**Next:** Session 9.9 can move to `specs/completed/`; canonical Postgres cutover remains a later storage migration phase while the tenant-facing trace tools stay stable.

---

## Session 9.x - 2026-04-21

**Spec:** Live Hindsight green follow-up - retain-model override for fresh semantic extraction
**Built:**
- `src/workers/mcpagent/do/HindsightContainer.ts` - Hindsight now keeps the existing Groq-backed general and reflect lanes, but overrides retain specifically to `openai/gpt-4.1-nano` through the same AI Gateway compat path so fresh fact extraction materializes semantic memory units again
- `tests/2.4b-hindsight-container-runtime.test.ts` - runtime coverage now locks the retain-model override and its AI Gateway wiring for both API and worker container env generation
- `MANIFEST.md` - regenerated
**Decisions:**
- The fix stayed in the Hindsight engine/provider lane rather than adding more HAETSAL-side shaping or fallback behavior.
- Only the retain lane changed; Graphiti, broker traces, and the reflect path were left structurally untouched.
- Fresh meaningful semantic recall remains the acceptance bar, not token-only smoke strings.
**Verification:**
- `npx vitest run tests/2.4b-hindsight-container-runtime.test.ts` - passed
- `npx vitest run tests/9.4-brain-memory-external-client-rollout.test.ts` - passed
- `npm test` - passed (`380 passed`, `1 skipped`)
- `npm run postflight` - passed
- `npm run manifest` - passed
- live protected MCP proof after deploy `ff444b79-1b39-4b72-b053-62071f053962` - passed for fresh Hindsight semantic capture/retrieval (`dd1b4e56-e8e5-4e1f-b92a-3de1434f256a`), Graphiti relationship/timeline checks, and combined `prepare_context_for_agent`
**Hindsight Pin:** unchanged container image (`ghcr.io/vectorize-io/hindsight-api:0.5.3-cfroll1`), retain model overridden to `openai/gpt-4.1-nano` via AI Gateway compat
**Blockers:** None
**Next:** Checkpoint this restore-to-green tranche, then return to the broker/tenant-trace/Postgres roadmap with Hindsight and Graphiti both green again.

---

## Session 10.0 - 2026-04-21

**Spec:** Canonical Postgres Source-of-Truth Cutover
**Built:**
- `sql/postgres/2001_canonical_open_brain_foundation.sql`, `src/services/canonical-postgres*.ts` - landed a real Worker-side canonical Postgres seam on Neon with a dedicated canonical schema, typed repository contract, in-memory test backend, and env fallback from `CANONICAL_POSTGRES_CONNECTION_STRING` to `NEON_CONNECTION_STRING`
- `src/services/canonical-memory.ts`, `src/services/canonical-*-payload.ts`, `src/services/canonical-*-state.ts`, `src/services/canonical-*-query.ts`, `src/services/canonical-*-dispatch.ts`, `src/workers/ingestion/canonical-projection-consumer.ts` - cut canonical write/read/status/projection reconciliation paths over to Postgres-backed truth while keeping the MCP/tool surface stable
- `src/services/canonical-d1-compat.ts` - kept a narrow explicit D1 compatibility mirror for canonical metadata so legacy runtime/tests still function during the storage cutover without storing raw content in D1
- `tests/10.0-canonical-postgres-source-of-truth-cutover.test.ts`, `tests/6.2-canonical-mcp-memory-surface.test.ts`, `tests/apply-migrations.ts` - added cutover coverage and aligned the older canonical surface tests with Postgres authority plus compatibility mirroring
- `specs/active/10.0-canonical-postgres-source-of-truth-cutover.md`, `MANIFEST.md` - completed As-Built and regenerated manifest
**Decisions:**
- Postgres is now authoritative for canonical captures, artifacts, documents, chunks, memory operations, projection jobs, and projection results.
- R2 remains authoritative for encrypted raw payload backing.
- Broker traces, tenant/control-plane state, and Hindsight operational state remain in D1 for now.
- A temporary D1 metadata mirror remains explicitly to support compatibility; canonical reads/status/query now come from Postgres truth rather than D1.
- No raw canonical body content was added to D1, KV, or analytics.
**Verification:**
- `npx vitest run tests/10.0-canonical-postgres-source-of-truth-cutover.test.ts` - passed
- `npx vitest run tests/7.1-hindsight-projection-adapter.test.ts tests/8.2-graphiti-ingestion-projection.test.ts tests/9.8-broker-primary-shadow-retrieval.test.ts tests/9.9-tenant-memory-trace.test.ts` - passed
- `npm test` - passed (`383 passed`, `1 skipped`)
- `npm run manifest` - passed
- `npm run postflight` - passed after accepting the reviewed over-limit canonical cutover files in the postflight allowlist
- local live-proof/regression lane stayed green for fresh Hindsight semantic capture/reconciliation, fresh Graphiti projection/query, `prepare_context_for_agent`, `get_recent_memory_traces`, and `get_memory_trace`
**Hindsight Pin:** unchanged (`ghcr.io/vectorize-io/hindsight-api:0.5.3-cfroll1`)
**Blockers:** None for the cutover itself; the remaining cleanup is removal of the temporary D1 canonical metadata mirror
**Next:** Move the 10.0 spec to completed via checkout, then follow with the next cleanup session that removes the D1 mirror and further narrows D1 to broker/control-plane roles only.

---

## Session 10.x - 2026-04-21

**Spec:** Live Hindsight green restoration follow-up - config refresh and truthful status read-through
**Built:**
- `src/services/bootstrap/hindsight-config.ts` - `ensureHindsightBankConfigured` now always reapplies live bank config before trusting the cached D1 config hash, while still skipping the heavier mental-model/webhook setup when the version already matches
- `src/services/canonical-hindsight-status-refresh.ts` - added a read-through Hindsight refresh helper that checks the remote operation/document state, updates `hindsight_operations`, and reconciles stale queued projections when the live engine is already ahead
- `src/services/canonical-memory-status.ts` - `memory_status` now reloads projection rows after the read-through refresh so stale local Hindsight queue state no longer masks a completed remote retain
- `tests/2.4a-hindsight-config.test.ts`, `tests/7.1-hindsight-projection-adapter.test.ts` - coverage for always-refresh bank config, truthful completed-document readiness, and stale queued Hindsight status read-through
**Decisions:**
- The fix stayed in HAETSAL's config/status truth layer rather than further changing the Hindsight model/provider lane.
- Cached D1 config hashes are no longer trusted as sufficient proof that the live Hindsight bank is correctly configured.
- `memory_status` should prefer truthful live reconciliation over waiting for a later cron tick when Hindsight is obviously stale locally.
- Semantic ranking still has a polish gap where an unlinked source-fact echo can outrank the linked canonical capture, but that is no longer a green/red blocker.
**Verification:**
- `npx vitest run tests/2.4a-hindsight-config.test.ts tests/7.1-hindsight-projection-adapter.test.ts tests/9.4-brain-memory-external-client-rollout.test.ts` - passed
- `npm run postflight` - passed
- live protected MCP proof after deploy `ebcda960-6fc7-40aa-9e78-1664a7efcbf2` - passed for fresh Hindsight semantic capture/retrieval (`5931d36c-efe3-4035-9b3d-5c88ba7c2807`), truthful `memory_status` (`completed`, `semanticReady: true`), remote document `memory_unit_count: 1`, Graphiti checks, and `prepare_context_for_agent`
**Hindsight Pin:** unchanged (`ghcr.io/vectorize-io/hindsight-api:0.5.3-cfroll1`)
**Blockers:** None for the restore-to-green tranche; only semantic ranking polish remains
**Next:** Checkpoint this restore-to-green tranche cleanly, then return to the canonical Postgres / D1 cleanup roadmap with Hindsight, Graphiti, broker, and tenant trace all green again.

---

## Session 11.3 - 2026-04-22

**Spec:** Chief of Staff Compiled Read Path
**Built:**
- `src/services/chief-of-staff-context.ts`, `src/services/chief-of-staff-context-runtime.ts`, `src/services/chief-of-staff-context-shared.ts` - split the prior runtime-only context builder into a small orchestration entrypoint plus preserved runtime assembly/shared helpers so the production path stayed intact while a compiled-first lane was added
- `src/services/chief-of-staff-compiled-context.ts`, `src/services/chief-of-staff-compiled-context-support.ts`, `src/services/chief-of-staff-compiled-context-bundle.ts`, `src/services/chief-of-staff-compiled-context-provenance.ts`, `src/services/chief-of-staff-compiled-context-gaps.ts` - added the Chief-of-Staff compiled read path that prefers compiled context packs, augments with dossiers plus recent-change/decision views, keeps provenance/source counts truthful even when only stored document sources exist, and preserves read-error/debug gap metadata without breaking valid compiled-first bundles
- `src/types/chief-of-staff-context.ts`, `src/tools/canonical-memory.ts` - extended the returned `prepare_context_for_agent` bundle with additive compiled metadata while preserving the existing MCP tool surface
- `tests/9.2-chief-of-staff-context-builder.test.ts`, `tests/11.3-chief-of-staff-compiled-read-path.test.ts` - tightened runtime-fallback coverage and added dedicated 11.3 proof for compiled-first context packs, dossier augmentation, recent-change/decision use, preserved provenance/freshness metadata, and truthful fallback
- `specs/active/11.3-chief-of-staff-compiled-read-path.md` - As-Built completed
- `MANIFEST.md` - regenerated
**Decisions:**
- 11.3 stayed strictly inside the Chief-of-Staff-oriented context assembly path; no broader MCP redesign, no removal of existing memory tools, and no attempt to make Chief of Staff the monopoly reader/writer of the brain.
- Compiled context packs are the primary gate for compiled-first behavior. If the primary pack is missing, stale, incomplete, or storage is unavailable, the system falls back truthfully to the existing runtime composition path instead of pretending compiled coverage exists.
- Dossiers, `what_changed`, and `decision_log` stay additive augments. Fresh complete versions enrich the returned bundle; stale or partial versions are skipped and surfaced through preserved gap/asset metadata rather than failing the request.
- The freshness policy is explicit and explainable: prefer source-linked agent-usable compiled context packs younger than 7 days, and only use compiled augments when they are likewise fresh and complete.
- `asset.used` now means "actually contributed to the returned bundle", not merely "would have been eligible if the primary compiled path had stayed active".
- Per-asset compiled read failures are isolated: a non-primary dossier/change read error no longer forces the whole request back to runtime when the primary compiled context pack is still valid.
- No compatibility shim was required. The older production memory path was preserved as code, not emulated through a translation layer.
**Verification:**
- `npx vitest run tests/11.3-chief-of-staff-compiled-read-path.test.ts tests/11.2-compilation-pipeline.test.ts tests/11.1-dossier-and-context-pack-schema-refinement.test.ts tests/11.0-haetsal-compiled-synthesis-foundation.test.ts tests/9.2-chief-of-staff-context-builder.test.ts` - passed
- `npm test` - passed (`412 passed`, `1 skipped`)
- `npm run postflight` - passed
- `npm run manifest` - passed
 - `npm run postflight` - passed after manifest regeneration
**Local Proof:**
- Chief-of-Staff project context assembled directly from compiled outputs when a fresh compiled context pack existed, with dossier relationships/open questions plus compiled change/decision signals visible in the returned bundle.
- Fallback to the older runtime path remained green when compiled outputs were absent.
- Existing production memory flows stayed green through the full `npm test` run.
- Architect verification for Ralph: approved after the metadata/fallback regression fixes landed.
**Blockers:** None
**Next:** Move 11.3 to completed when the branch is finalized, then broaden compiled-read adoption deliberately: improve subject-key resolution beyond the first slug-based path and add queue/Workflow-driven freshness regeneration so compiled packs stay ready before more agents and product surfaces adopt them.

---

## Session M4 - 2026-08-13

**Spec:** m4-ops-alert-ingress (cross-project mission M4, Fitness App ADR-0006)
**Built:**
- `migrations/1029_ops_alert_ingress.sql`, `src/types/ops-alert.ts`, `src/services/ops-alert/{registry,ingest,deliver}.ts`, `src/workers/mcpagent/ops-alert-webhook.ts` - generic `POST /ops/alert/:token` ingress: per-source SHA-256 token registry in D1, INSERT OR IGNORE dedupe with per-source re-page window, shallow page path (Sendblue -> Telnyx SMS fallback, no broker/LLM/DO before delivery), async episodic memory via retain queue (`ops_alert` IngestionSource)
- `src/cron/brief-ops-section.ts` + morning-brief wiring - standing Ops section: dead-man freshness line from haetsal_health Neon via `HEALTH_SPINE_RO_URL` (SELECT-only role `haetsal_health_ro`, Phase 4 haetsal_ro forerunner) + last-24h alerts
- `tests/m4-ops-alert-ingress.test.ts` - 7 contracts; `docs/runbooks/ops-alert-ingress.md`
**Decisions:**
- Token in path (canary-style senders cannot set headers); D1 stores hash only; adding a source is a D1 INSERT, never code
- `ops_alerts` stores title only - the 1.1 plaintext guard forbids content-named columns in D1; full text reaches T1 via the memory write
- Ongoing outages re-page once per dedupe window (anchored on paged_at), replays bump replay_count
**Verification:**
- `npm test` 519 passed / 1 skipped on the full tree; postflight clean for M4 files (3 pre-existing violations belong to the uncommitted Gmail-backfill session)
- Live (deploy fa3065f4): forced-fire from deployed health canary paged Matt's phone via Sendblue (confirmed by Matt); replayed dedupe key returned `duplicate` with no re-page (replay_count=2, single paged_at); `notice` severity recorded with paged_at NULL; CF Access bypass app for `/ops/alert/*` created
- `haetsal-health` registered as source #1 for tenant f512390d...; tenant flipped to bootstrap_status=completed (Matt-approved) so the 07:00 UTC brief renders the Ops section
**Blockers:** Morning-brief live appearance of freshness line + notice pends the next 07:00 UTC brief (needs valid Cron KEK - open the root page after CF Access login before then). Spec stays in specs/active/ until that lands; integrator merges both mission branches.
**Next:** Integrator validates `mission/m4-ops-ingress` (this repo + Fitness App), confirms brief render, moves spec to completed.

---

# Mission Phase 0 Inventory — Baseline Reset

Date: 2026-07-02
Branch: `haetsal-mission` (rollback tag `pre-haetsal-mission` = `a76c164` on master)
Scope: read-only inventory refresh executed at mission start (HAETSAL_MISSION.md §6).
Supersedes the inventory sections of `post-hindsight-baseline-report.md` (2026-06-01),
which described a pre-reconciliation tree. The tree has moved substantially since.

## 1. Tree State vs June Baseline

The 2026-06-01 baseline report's blockers are all resolved on this tree:

- 11.4 runtime lineage merged (`3bf8006 Merge post-hindsight Cloudflare reconciliation`);
  canonical Postgres repository, compiled synthesis 11.0–11.4, working sessions 11.5–11.6,
  and projection policy 11.7 are all present.
- Cloudflare currency landed: `wrangler ^4.95.0`, `agents ^0.13.3`, `zod ^4`, `pg ^8.21.0`,
  compatibility_date `2026-06-01`, `nodejs_compat`.
- `HYPERDRIVE_CANONICAL` Hyperdrive binding exists and is wired
  (`canonical-memory.ts`, `routes/canary.ts`); Hyperdrive canary deployed 2026-06-02.
- vitest discovery excludes `gbrain/`, `OB1/`, `Second-Brain/`, `.codegraph/`.
- `package.json` ↔ `package-lock.json` reconciled (root deps match; no orphan
  `@neondatabase/serverless`; lockfileVersion 3).
- Stale duplicate `specs/active/10.1-*.md` removed in Phase 0 (completed copy with
  As-Built already lives in `specs/completed/`).

## 2. Gate Checks Verified (Phase 0)

- CF Access app `Haetsal` (`5f79c2ec-1db3-473a-a356-3f03651e2be1`) on
  `haetsalos.specialdarksystems.com`: policy `Allow Matt` (email smitmat86@gmail.com)
  + `Allow haetsal-brain-shell-smoke` (service token, non_identity). No drift.
- CF Access app `Webhook: Sendblue` (`05fd91af-e8f5-48f8-8a0b-43a419ff4f13`) on
  `haetsalos.specialdarksystems.com/webhooks/sendblue/*`: `bypass-all` (everyone). No drift.
- `wrangler secret list --name the-brain` confirms all four SENDBLUE_* secrets plus
  BRAVE_API_KEY (Phase 5 act_search), AI_GATEWAY_TOKEN, NEON_CONNECTION_STRING.
- `wrangler whoami` authenticates via CLOUDFLARE_API_TOKEN env var (account
  `d3f0a1c579945862edc9c6f6e36e448a`). The 403 recorded in the 2026-06-01 token-hygiene
  snapshot is stale.

## 3. Hindsight/Graphiti Reference Inventory (refresh)

75 files / ~815 matches across `src/`, `wrangler.toml`, `vitest.config.ts`, `migrations/`.
Full per-file classification captured 2026-07-02; summary by severance phase:

| Class | Files | Severed in | Anchor files |
|---|---|---|---|
| WRITE_PATH | 27 | Phase 1 | `services/ingestion/retain.ts` (fan-out root), `retain-request.ts`, `retain-persistence.ts`, `canonical-capture-pipeline.ts` (kind dispatch), `canonical-hindsight-projection*.ts` (3), `canonical-graphiti-*.ts` (4), `bootstrap/hindsight-config.ts`, `workflows/bootstrap.ts` (ensure-bank step), `tenant.ts` (bank id), `agents/base-agent.ts` retain, `tools/retain.ts`, `tools/memory.ts` (write half), `external-client-memory-write.ts` (hindsightAsync flag) |
| READ_PATH | 26 | Phase 2 | `canonical-semantic-recall.ts`, `tools/recall.ts`, `canonical-graph-query.ts` (graphiti rows), `canonical-memory-status.ts`, `canonical-hindsight-reflection*.ts` (2), `canonical-hindsight-status-refresh.ts`, `canonical-hindsight-debug.ts` + `tools/hindsight-debug.ts`, `agents/base-agent.ts` open() recall + mental model, `cron/passes/pass1/pass2/pass4` reads, `weekly-synthesis.ts` reflect, `routes/audit.ts`, `canonical-postgres-repository.ts` hindsight-projection lookups |
| INFRA | 12 | Phase 3 | `do/HindsightContainer.ts`, `do/GraphitiContainer.ts`, `hindsight-transport.ts`, `graphiti-client.ts` (container stub), `McpAgent.ts` prewarm, `index.ts` class re-exports, `types/env.ts`, generated env types, `wrangler.toml` containers/DO bindings/migrations v2–v4/vars |
| CRON | 10 | Phase 3 | `cron/hindsight-operations.ts`, `hindsight-operation-poll/reconcile/side-effects/types.ts`, `canonical-hindsight-reconcile.ts`, `hindsight-ops.ts`, `public-webhooks.ts` /hindsight/webhook, `runtime.ts` 1-min tick, `consolidation.ts` (hindsight_tenant_id lookup) |
| HISTORICAL | 8 | keep | migrations 1001–1004, 1009–1012 (do not edit; add forward migrations) |

Split-files note: `hindsight.ts`, `hindsight-client.ts`, `tools/memory.ts`,
`cron/weekly-synthesis.ts`, `cron/passes/pass2-bridges.ts` span WRITE+READ and must be
split at function level between Phases 1 and 2, not deleted wholesale.

Clean (zero references): `working-session.ts`, `working-session-capture-bridge.ts`.
`tests/11.7-post-hindsight-projection-policy-surface.test.ts` already asserts a capture
path with Hindsight dispatch NOT invoked — it is the north-star pattern for Phase 1 tests.

## 4. wrangler.toml Dispositions

- KEEP: MCPAGENT DO, D1_US, R2_ARTIFACTS, R2_OBSERVABILITY, KV_SESSION, all queues
  (high/normal/bulk/dead/actions + consumers), BROWSER, BOOTSTRAP_WORKFLOW,
  HYPERDRIVE_CANONICAL, AI, crons (obsidian poll ×2, morning brief, heartbeat,
  weekly synthesis, nightly consolidation — minus its Hindsight reconcile slice).
- REMOVE_PHASE_3: containers HindsightContainer/HindsightWorkerContainer/GraphitiContainer,
  DO bindings HINDSIGHT/HINDSIGHT_WORKER/GRAPHITI, migrations v2–v4 (add forward deletion
  migrations), vars HINDSIGHT_DEDICATED_WORKERS_ENABLED/HINDSIGHT_DEDICATED_WORKER_COUNT/
  GRAPHITI_RUNTIME_MODE, secrets HINDSIGHT_WEBHOOK_SECRET/GRAPHITI_API_URL/GRAPHITI_API_TOKEN,
  env type GRAPHITI_KUZU_PATH (declared, zero call sites).
- REVIEW: `VECTORIZE` (binding `brain-memory`) and `ANALYTICS` (BRAIN_ANALYTICS) are
  declared but have zero call sites in src/ — candidates for Phase 2 (pgvector decision)
  and Phase 13 (metadata metrics) respectively. `D1_EU` inert placeholder (mission N5).
- GAPS: no `[[routes]]`/custom-domain in wrangler.toml (domain presumably mapped in
  dashboard; verify at first prod deploy). No static assets config (Phase 11 adds it).
  SENDBLUE_* absent from `types/env.ts` (Phase 4 adds).

## 5. Action Layer (Phase 5 baseline)

Executors: REAL = browse, create_event, modify_event. STUB = send_message, draft,
search, remind, run_playbook (all fall through to `executeStub()` in
`services/action/executor.ts`). Proposal side (`tools/act/*.ts`) is uniform:
hash payload → QUEUE_ACTIONS. Gate (TOCTOU + HMAC prefs + GREEN/YELLOW/RED routing +
atomic audit) is shared in the queue consumer (`workers/action/index.ts` + router),
not per-executor. Auto-episodic memory fires only on the real-execution path.

Known gaps to close in Phase 5:
1. Send-delay poller unimplemented — GREEN actions with `execute_after` sit in D1
   forever (`router.ts` TODO; D1 index already exists). Mission requires Workflow
   `waitForApproval` for IRREVERSIBLE, which replaces this mechanism.
2. No pre-execution cancel for queued/delayed actions (only YELLOW reject +
   post-execution undo for reversible calendar creates).
3. `modify_event` has no undo (needs pre-modify snapshot).
4. Delivery layer fragmented: `inbound-message.ts` direct-reply path, a duplicate
   inline Telegram send in `public-webhooks.ts`, and the unwired action-pipeline send
   should converge on one delivery abstraction (Phase 4 adds sendblue.ts to it).

## 6. Test Baseline

76 test files (single-worker, serialized, pool-workers, wrangler.test.toml).
Dispositions: REWRITE_PHASE_1 ≈ 5 (2.1-retain, 2.1b/c/d ingestion, 1.2-tools),
REWRITE_PHASE_2 ≈ 15 (6.3, 7.1–7.3, 8.1–8.3, 9.1/9.2/9.4/9.5/9.6–9.9, 10.0, 11.3
fallback), DELETE_PHASE_3 ≈ 8 (2.4a/2.4b, 3.3-hindsight-ops ×2, 1.4a, 3.3-webhook,
3.3-consolidation, 10.1-retire-mirror), rest KEEP/UNRELATED.
Two stub layers to retire: shared `tests/support/hindsight-test-env.ts` /
`graphiti-test-env.ts` AND ad-hoc inline `HINDSIGHT.fetch` stubs in 2.x/3.x files,
plus the Miniflare service-binding stubs referenced from `vitest.config.ts`.

## 7. Constraints Carried Forward

- `.omx/context/phase-11-6-*` constraints "do not adopt Sessions" / "do not remove
  Hindsight" are superseded by HAETSAL_MISSION.md §5 for this run.
- Working-session capture bridge (11.6) is production-neutral: only explicit
  session-close summaries may reach `capture_mode = "session_summary"`; raw transcripts
  stay non-canonical. Phase 9 wires production agents to it.
- Sendblue Free Tier: shared number, must-text-first, 24h reply window. Phase 7
  automations must surface `skipped_outside_reply_window` rather than work around it.
- Google OAuth NOT provisioned: Phase 5 stops at S5 for Gmail send/draft with a
  lessons file for Matt. (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` absent from
  the-brain secrets — confirmed in secret list.)
- `.omx/logs/` contain token-like strings (known from 10.7/10.8 hygiene work).
  Never commit `.omx/`; it is untracked noise.

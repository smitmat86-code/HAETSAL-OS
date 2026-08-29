# 8. Operations

> **In plain terms:** How changes ship safely, how to tell if the brain is
> healthy, and what to do when something looks wrong. Short version: every
> release passes the full automated suite (479 tests as of Phase 13) plus
> an independent review before it deploys; every deploy is tagged so
> rollback is one command; and the hourly canaries plus the dashboard tell
> you the live truth.

## Is it healthy right now?

1. **Canary check**: `GET /api/dream/canary/latest` — 7/7 probes ok within
   the last hour means capture, recall, graph, review-surface, compiled
   reads, session evidence, and governed artifact intake all work end-to-end.
2. **Dashboard sanity**: Memory panel returns recent captures; Agents
   panel loads runs. If the dashboard is up, Access + Worker + D1 + Neon
   are all answering.
3. **Dream ran last night?** Dream panel (or `GET /api/dream/latest`)
   shows a `completed` run dated overnight.

## When something looks wrong

| Symptom | First move |
|---|---|
| Replies stop citing memory / feel generic | Check canary `recall` probe; semantic search may be degraded to lexical (`status: partial` in traces) — embeddings or pgvector issue |
| Approval says payload can't be decrypted | If it names the KEK: more than 24 h of inactivity passed — reject and re-propose (any authenticated activity re-provisions the KEK) |
| Automation didn't fire | Automations panel → last-fire status; the runtime re-arms alarms even after errors, so check the fire log before assuming it's dead |
| Dashboard 404s | Asset paths must be exact (`/dashboard.html`); directory URLs are deliberately not served |
| Gmail anything | Expected: `GmailNotConnectedError` until OAuth is provisioned |
| Something deeper | `npx wrangler tail`, or the Cloudflare observability MCP tools; logs are content-free by design, so grep for operation names and fixed-vocabulary errors |
| Artifact upload is stuck or expired | Follow the [artifact intake operator runbook](../runbooks/artifact-intake-operations.md); do not delete an R2 object without exact ownership/hash proof |

## Rollback

Every phase deploy is double-tagged in git: `deploy-phase-N-prev` (the
commit *before* the phase, i.e., the rollback point) and
`phase-N-complete`. Deploy memos in `docs/lessons/phase-N-prod-deploy-memo.md`
record the Cloudflare version ids. Fast path:

```
npx wrangler rollback            # to the previous deployed version
# or redeploy a known-good tag:
git checkout phase-12-complete && npx wrangler deploy
```

D1 migrations are forward-only (additive); the R2 archival copies and
regenerable views (compiled pages, decay states, dream reports) mean the
recovery posture is "rebuild from canonical truth," documented per-surface
in the [ops runbook](../lessons/phase-13-ops-runbook.md).

## How changes ship (the gate protocol)

Nothing reaches prod on a green unit test alone. Per phase:

1. **`npm run checkout`** — postflight (repo rules: 150-line source-file
   limit, hygiene checks), the full test suite (479 tests / 77 files as of
   Phase 13), postflight again, and a SESSION_LOG entry check.
2. **Fresh-context verifier** — an independent review agent with no
   knowledge of the implementation session audits the diff against the
   Three Laws and the phase spec. Blockers stop the gate (Phase 11's
   XSS rewrite and Phase 10's type-safety fixes came from this).
3. **Law 2 audit** — explicit pass over every new persistence/log site.
4. **Tagged deploy** — `deploy-phase-N-prev` tag, `wrangler deploy`,
   ~12 s propagation wait.
5. **Live smoke** — a real script against prod (`scripts/mission-phase*-live-smoke.ts`);
   the mission closeout sweep is `scripts/mission-phase13-full-demo.ts`,
   which runs all ten demo clauses in one session.

## Testing model

- **vitest-pool-workers** runs the suite inside the actual Workers
  runtime (real D1/KV/R2 semantics, isolated storage per test — every
  test seeds its own tenant).
- **Contract tests per mission surface** (`tests/mission-N.*.test.ts`)
  pin behaviors that must never regress: key-family decrypt, Law 2
  content-free rows, spawn/cancel/retry, recurrence math (DST anchors),
  governance downgrades.
- **Live smokes** are the only place "it actually works in prod" is
  asserted — tests never claim that.

Hard-won testing lessons (encoded in the suite): `INSERT OR IGNORE`
swallows NOT NULL violations and can make a test vacuously pass — seed
loudly; the agents-SDK DO can't run in the test pool, so client code
guards for the namespace's absence; `return await` (not bare `return`)
inside try/catch, or workerd's unhandled-rejection tracker fails the run.

---

## Under the hood: operational surfaces

| Surface | Where |
|---|---|
| On-demand canary | `POST /api/dream/canary/run` |
| Manual dream run | `POST /api/dream/run` (per-day dedup; manual runs get a suffix) |
| Manual decay pass | `POST /api/dream/decay/run` |
| Compiled rebuild | `POST /api/compiled/{kind}/{key}/rebuild` |
| Agent run controls | `POST /api/agents/runs/{id}/cancel` · `/retry` |
| Audit feed | `src/workers/mcpagent/routes/audit.ts` |
| Deploy memos / runbook / lessons | `docs/lessons/` (the project's institutional memory) |
| Session log | `SESSION_LOG.md` (append-only; last 3 entries read at session start) |
| Artifact lifecycle telemetry | D1 `artifact_intake_events` (content-free states/codes only) |
| Artifact recovery | `docs/runbooks/artifact-intake-operations.md` |

## Why it's built this way

The gate protocol exists because the implementer can't be the approver:
the fresh-context verifier catches what the author's context blinds them
to (it found real XSS, a real DO-identity bug's paper trail, vacuous
tests). Tagged deploys + memos make every prod state reconstructible
months later. And canaries are the ops philosophy in one line: **the
system should be the first to know it's broken** — six probes through the
real code paths, hourly, content-free.

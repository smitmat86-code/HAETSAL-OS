# Spec M4 — Generic Ops-Alert Ingress (cross-project mission M4)

Status: ACTIVE · Branch: `mission/m4-ops-ingress`
Contract: `C:\Users\matth\Documents\Fitness App\missions\M4-haetsal-ops-ingress.md`
Rationale: `C:\Users\matth\Documents\Fitness App\docs\decisions\0006-alerting-via-haetsal-ops-ingress.md`

## Objective

HAETSAL becomes the single alerting substrate for everything Matt builds.
`POST /ops/alert/:token` on the-brain Worker accepts alerts from registered
sources. Severity `page` → immediate iMessage/SMS on a deliberately shallow
path; `notice` → morning brief only. Alerts become episodic memories async.
`haetsal-health` is source #1; future sources are D1 rows, not code.

## Design

### Route + auth (Law 1 / G5)

`POST /ops/alert/:token` registered BEFORE the auth middleware in
`src/workers/mcpagent/index.ts`, exactly like the Sendblue webhook: same
hostname, no new public surface. Auth is a per-source bearer token carried in
the path (sources like the health canary POST plain JSON and cannot set
headers). The token is never stored: D1 holds its SHA-256; verification hashes
the presented token and compares constant-time. Unknown token → 404.

### Payload

```json
{ "source"?: str, "severity"?: "page"|"notice", "title"?: str, "body"?: str,
  "dedupe_key"?: str, "text"?: str }
```

`text`-only payloads (the health canary's shape) are normalized: severity ←
source default, title ← text (truncated), dedupe_key ← sha256(title|body).
Source identity always comes from the token's registry row, never the payload.

### Dedupe (idempotent within window)

`ops_alerts` D1 table, UNIQUE(source_id, dedupe_key). `INSERT OR IGNORE` +
readback: if an existing row paged within `dedupe_window_s` (per-source,
default 6h), the replay bumps `replay_count` and does NOT page again.
Outside the window the same key pages again (a canary firing daily must page
daily).

### Shallow critical path (page)

verify token → normalize → one D1 dedupe roundtrip → deliver
(Sendblue iMessage first, Telnyx SMS fallback — existing delivery clients,
recipient from `tenant_phone_numbers` for the source's tenant). NO memory
broker, NO LLM, NO DO session before delivery. After delivery, via
`waitUntil`: paged_at/channel bookkeeping + `enqueueRetainArtifact` (episodic,
provenance `ops_alert:<source>`; QUEUE_HIGH/NORMAL consumer does the canonical
Postgres write). `notice` skips delivery entirely; same row + memory write.

### Morning brief

New standing section (brief-ops-section.ts):
- Dead-man's freshness line, always present: `health spine: last ingest N.Nh
  ago` — read-only `SELECT max(received_at) FROM raw_ingest` against the
  haetsal_health Neon DB via new secret `HEALTH_SPINE_RO_URL` (a minimal
  SELECT-only role; documented forerunner of Phase 4's `haetsal_ro`). Missing
  secret / query failure → truthful `health spine: freshness unavailable`.
- Last-24h ops alerts (pages marked, notices listed). Surfacing marks
  `brief_surfaced_at`.

### Source registry (config/data, not code)

`ops_alert_sources`: id (source name), tenant_id, token_sha256,
default_severity, dedupe_window_s, enabled, created_at. Registering a future
source = generate token, `wrangler d1 execute` one INSERT. Runbook:
`docs/runbooks/ops-alert-ingress.md`.

## Pre-flight (checkin.md step 3)

- **Law 1**: route lives on the existing Worker/hostname behind the same
  Hono app; exemption mirrors Telnyx/Sendblue. No new public surface. PASS.
- **Law 2**: D1 stores only the alert TITLE (140-char operational label, T2
  like audit/pending_actions rows) — the 1.1 plaintext guard forbids
  content-named columns and alert bodies never land in D1; the full text
  reaches canonical Postgres (T1) via the normal retain path only. No TMK
  available on this unauthenticated path → queue payload carries plaintext in
  transit only, same accepted pattern as sms_inbound (ops runbook ADR #3). PASS.
- **Law 3**: memory write is episodic from a system source — not procedural. PASS.
- **State tiers**: registry+alerts D1 (T2); dedupe in D1 not KV (strong
  consistency); memory T1 via queue.
- **Compute**: ingress is C1 (fast, one D1 roundtrip + one/two fetches);
  memory write C3 (queue).
- **Action layer**: N/A — this is not an agent-proposed action; it is a
  webhook-triggered system notification, same class as inbound-message replies
  (which call sendSmsReply directly). No capability gate on the critical path
  by design (ADR-0006 shallow-path requirement).
- **Audit**: ops_alerts row IS the audit record (metadata only); auth failures
  return 404 without tenant context (mirrors Sendblue).
- **Cron KEK**: brief section reads D1 + external RO Postgres only — no KEK
  dependency; freshness line works even when KEK is expired... (brief itself
  still gates on KEK as today; no new dependency added).

## As-Built Record

Built on `mission/m4-ops-ingress` (2026-08-06):

- `migrations/1029_ops_alert_ingress.sql` — `ops_alert_sources` (registry,
  token SHA-256 only) + `ops_alerts` (dedupe/audit rows; title only — NO body
  column, the 1.1 plaintext guard forbids content-named columns in D1).
- `src/types/ops-alert.ts` — payload/registry/result contracts.
- `src/services/ops-alert/registry.ts` — token → source resolution
  (hash lookup + constant-time compare, Sendblue pattern).
- `src/services/ops-alert/ingest.ts` — normalize (canary `{text}` fallback),
  INSERT OR IGNORE dedupe with per-source re-page window anchored on
  `paged_at`, page orchestration, async episodic memory via
  `enqueueRetainArtifact` (new `ops_alert` IngestionSource).
- `src/services/ops-alert/deliver.ts` — phone from `tenant_phone_numbers`,
  Sendblue first, Telnyx SMS fallback.
- `src/workers/mcpagent/ops-alert-webhook.ts` — `POST /ops/alert/:token`;
  registered from `registerPublicWebhooks` (pre-auth block in index.ts) to
  respect the 150-line postflight limit on index.ts.
- `src/cron/brief-ops-section.ts` + morning-brief wiring — standing Ops
  section: freshness line via `HEALTH_SPINE_RO_URL` (new optional secret in
  env.ts) + last-24h alerts, `brief_surfaced_at` bookkeeping via D1 batch.
- `tests/m4-ops-alert-ingress.test.ts` — 7 tests: unknown/disabled token 404,
  canary-shape page + memory enqueue, in-window replay no double-page,
  post-window re-page, Sendblue→SMS fallback, notice → brief only.
- Fitness App repo: `workers/health-ingest/sql/haetsal_health_ro.sql`
  (SELECT-only role, Phase 4 `haetsal_ro` forerunner) on its own
  `mission/m4-ops-ingress` branch.

Deviations from spec: `ops_alerts.body` dropped entirely (guard above) —
delivery/brief use the live payload and title; dedupe key still derives from
title+body so distinct bodies with identical titles stay distinct.

## Pre-Finalization Checklist

- [ ] npm test green
- [ ] npm run postflight green
- [ ] npm run manifest regenerated
- [ ] Live forced-fire evidence captured (M1 gate 2c)
- [ ] Mission file Evidence block updated in Fitness App repo

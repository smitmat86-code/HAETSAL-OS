# Runbook — Ops-Alert Ingress (`POST /ops/alert/:token`)

M4 cross-project mission (ADR-0006 in the Fitness App repo). HAETSAL is the
single alerting substrate for everything Matt builds. This is the operator
guide; design rationale lives in `specs/active/m4-ops-alert-ingress.md`.

## Contract

`POST https://haetsalos.specialdarksystems.com/ops/alert/<source-token>`

```json
{ "source": "haetsal-health", "severity": "page" | "notice",
  "title": "...", "body": "...", "dedupe_key": "..." }
```

All fields optional. A minimal sender may POST `{ "text": "..." }` — severity
falls back to the source's registered default, dedupe key is derived from the
content. Responses: `paged`, `noticed`, `duplicate`, `page_failed`, or 404
for an unknown/disabled token.

- `page` → immediate iMessage (Sendblue) with Telnyx SMS fallback. Shallow
  path: no memory broker / LLM / DO session before delivery.
- `notice` → morning brief only.
- Replay with the same dedupe key inside the source's window (default 6h)
  does not page again; an ongoing condition re-pages once per window.
- Every first-sighting alert is queued as an episodic memory with provenance
  `ops_alert:<source>`.

## Registering a new source (config/data — never code)

1. Generate a token (do not log it, do not commit it):
   `python -c "import secrets; print(secrets.token_urlsafe(32))"`
2. Compute its SHA-256 hex, then insert the registry row:

```sql
INSERT INTO ops_alert_sources
  (id, tenant_id, token_sha256, default_severity, dedupe_window_s, enabled, created_at)
VALUES ('<source-name>', '<tenant-id>', '<sha256-hex-of-token>', 'page', 21600, 1,
        <unix-ms>);
```

   via `npx wrangler d1 execute brain-us --remote --command "..."`.
3. Hand the token to the source project (as a Worker secret there).
4. Rotation: update `token_sha256`; revocation: set `enabled = 0`.

Registered sources: `haetsal-health` (source #1, Fitness App health spine —
its canary posts `{text}` with `CANARY_WEBHOOK_URL` pointing at the ingress).

## Dead-man's freshness line

The morning brief always renders an Ops section whose first line is
`health spine: last ingest N.Nh ago`, read from the haetsal_health Neon DB
via the `HEALTH_SPINE_RO_URL` secret — a SELECT-only role
(`haetsal_health_ro`, created by
`Fitness App/workers/health-ingest/sql/haetsal_health_ro.sql`). This role is
the documented forerunner of Phase 4's `haetsal_ro`; Phase 4 should absorb it.
If the secret is missing or the read fails, the line degrades truthfully to
`health spine: freshness unavailable (...)` — treat that as an alarm, not
cosmetic noise.

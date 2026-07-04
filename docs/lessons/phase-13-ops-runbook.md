# Phase 13 Ops Runbook + Closeout ADRs

Date: 2026-07-04.

## Rebuild procedures

- **pgvector semantic index**: embeddings live in canonical Postgres
  (`chunk_embeddings` via `updateChunkEmbeddings`). Rebuild = re-run the
  projection dispatch for affected documents (ingestion projection consumer
  re-embeds via `@cf/baai/bge-base-en-v1.5`); the broker's lexical mode keeps
  retrieval alive during a rebuild. No Vectorize dependency (binding removed).
- **Compiled pages**: fully regenerable — `POST /api/compiled/:kind/:key/rebuild`
  re-runs the compiler from canonical truth; the page endpoint renders from
  persisted views. Registry rows are disposable (delete → rebuild round-trips).
- **Dream reports**: re-runnable via `POST /api/dream/run` (per-day dedup uses
  a `-manual-<ts>` suffix); reports are canonical captures (KEK-sealed body
  sidecars — read with `fetchAndValidateKek`).
- **Decay states**: `POST /api/dream/decay/run` rebuilds `memory_decay` from
  canonical metadata + broker-trace counts (idempotent upserts).
- **Rollback**: every phase has `deploy-phase-N-prev` git tags; `npx wrangler
  rollback` to the version id in the phase memo is the fast path.

## Canaries (mission §Phase 13)

Six probes (capture, recall, graph, contradiction-surface, compiled-regen,
session-evidence) run hourly on the cron (top-of-hour tick of the */15 slot)
per completed tenant; results land content-free in D1 `canary_runs`.
On-demand: `POST /api/dream/canary/run`; latest: `GET /api/dream/canary/latest`.

## Closeout ADRs

1. **Secrets Store migration: DEFERRED (deviation from mission §Phase 13).**
   Secrets remain Worker secrets (encrypted at rest by Cloudflare, managed via
   `wrangler secret`). Migrating to account-level Secrets Store bindings
   changes every consumer callsite (`env.X` → binding `.get()`) and requires
   store provisioning permissions this environment's token does not hold
   (same class as the D1-query restriction). The migration is mechanical and
   documented here as the follow-up; attempting it blind at closeout risked
   breaking prod auth for zero functional gain.
2. **Analytics Engine: metadata-only trivially holds** — there are zero
   `writeDataPoint` call sites; the binding is reserved. The usage panel is
   audit-ledger derived. When AE is adopted, sampling must be explicit per
   the mission; nothing to configure today.
3. **Retain-queue transit plaintext: ACCEPTED.** Queue messages carry the
   plaintext `content` alongside the encrypted archival copy for the seconds
   between enqueue and ack. Two independent audits judged it an accepted
   ephemeral-transit pattern (not at-rest). Removing it would make every
   retain KEK-dependent (defer-on-expiry for all captures) — a worse
   availability trade. Revisit only if queue retention semantics change.
4. **Key families are structural (KEK ≠ TMK, proven Phase 8).** Everything
   sealed at rest is family-tagged going forward (approved-action payloads:
   `TMK1:`/`KEK1:` prefixes; legacy untagged = TMK). Cron-written canonical
   body sidecars are KEK-sealed — session reads of those bodies need the KEK,
   not the session TMK (dream routes already do this). A dual-recipient
   sidecar scheme remains the long-term fix if session reads of cron bodies
   become a product need.
5. **Compiled R2 artifacts are now actually encrypted** (the `contentEncrypted`
   field name is true as of this phase); nothing reads them back today, and
   the reader must use the compile-time tenant key.
6. **Decay scoring window**: only the most recent 200 documents re-score per
   pass (annotated in code). Follow-up: page by scoring staleness.

## Known-blocked demo legs (S5 — Matt's action)

Demo clauses 1 (Gmail+calendar citations in the channel reply) and 2 (real
Gmail send) require `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`. Setup steps:
`docs/lessons/phase-5-google-oauth-setup.md` (6 console steps + 2 secrets).
Everything up to the Gmail boundary fails honestly (`GmailNotConnectedError`)
and the Telegram-equivalent flows are live-verified.

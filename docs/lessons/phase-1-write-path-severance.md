# Phase 1 — Canonical Governed Write Path Lessons

Date: 2026-07-03

1. **Dedup was riding on the Hindsight dispatcher.** `checkDedup()` reads
   `ingestion_events.dedup_hash`, but the only writer of `ingestion_events` was
   `retain-persistence.ts` — which ran inside the Hindsight projection
   dispatcher. Severing the write path without re-homing that insert would have
   silently disabled dedup. The insert now lives in `retainContent()` itself,
   anchored to canonical ids. When deleting an "engine-specific" module, check
   what operational side effects hitchhiked on it.

2. **Split-brain modules confirmed and handled.** `hindsight.ts` /
   `hindsight-client.ts` remain for the read path (Phase 2). Files deleted in
   Phase 1 (write-only, verified zero importers with ripgrep before deletion):
   `canonical-capture-compat.ts`, `canonical-hindsight-projection.ts`,
   `canonical-hindsight-projection-payload.ts`, `ingestion/retain-request.ts`,
   `ingestion/retain-persistence.ts`, `bootstrap/hindsight-config.ts`,
   `bootstrap/hindsight-bank-spec.ts`. `canonical-hindsight-projection-state.ts`
   and `canonical-hindsight-reconcile.ts` stay until Phase 2/3 (read/status).

3. **PowerShell `Select-String -Path src\**\*.ts` does NOT recurse.** `**` is
   not a recursive glob in PowerShell paths; early import-graph checks silently
   missed deeply nested files. Use ripgrep (the Grep tool) for anything
   load-bearing.

4. **`@cloudflare/containers` only resolves inside workerd.** Any module graph
   that must load in Node (live-smoke scripts, tsx tooling) cannot statically
   import the Hindsight transport stack. Phase 1 made those edges lazy
   (`hindsight-debug` tool handler, `canonical-semantic-recall`,
   `canonical-hindsight-status-refresh`). Phase 2/3 delete them entirely.

5. **`pg` cannot load inside vitest-pool-workers** (CJS + node-builtin
   resolution fails even with the dep optimizer, wrangler 4.95 / vitest 4.1).
   Live smokes that need real Postgres run under Node (`npx tsx
   scripts/mission-phase1-live-smoke.ts`) driving the real tool handler with
   in-memory Cloudflare binding fakes; the canonical Postgres adapter is the
   surface under test.

6. **Local canonical dev DB is `localhost/brain_dev` per `.dev.vars`; real Neon
   credentials exist only inside Cloudflare** (Hyperdrive `haetsal-canonical-neon`
   → ep-ancient-haze-akoih3jt…neon.tech/neondb, caching disabled, sslmode
   require; password not retrievable via API). Consequence: pre-deploy live
   smokes exercise the local dev substrate; the first Neon-instance end-to-end
   smoke (real MCP client through CF Access) lands at the Phase 3 prod deploy
   gate. Auth middleware is CF-Access-JWT-only — there is no token lane, so no
   headless MCP smoke exists without a deployed worker.
   Phase 1 provisioned that local substrate: PostgreSQL 18.4 (embedded-postgres
   binaries) in the session scratchpad, data dir `scratchpad/pg/data`, started
   via `pg_ctl -o "-p 5432"`, db `brain_dev`, credentials matching `.dev.vars`.
   Docker Desktop would not start headlessly. CAVEAT for Phase 2: this minimal
   build ships no `pgvector` extension — semantic-mode dev/testing must either
   treat vector search as optional locally, vendor pgvector, or rely on FTS
   fixtures locally with pgvector verified against Neon at deploy time.

7. **Two historical-seeding helpers exist in tests/support/** (parallel agents):
   `historical-hindsight-seed.ts` (synthesizes a standalone pre-severance
   capture) and `hindsight-historical-projection-seed.ts` (attaches a hindsight
   projection to an existing capture, plus D1 `hindsight_operations` seeding).
   Both simulate pre-cutover data for read-path tests. Delete both in Phase 3
   with the read path.

8. **Governance defaults are enforced in one place.** `resolveCaptureGovernance`
   (`src/services/canonical-governance.ts`) is the single authority for
   agent-write downgrades (fact→claim, protected trust states→evidence,
   instruction→evidence) and Law 3 procedure rejection. New write surfaces must
   route through `captureCanonicalMemory` (which calls it) rather than
   `store.writeCapture` directly.

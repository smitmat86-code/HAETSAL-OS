# Phase 3 — Hindsight + Graphiti Removal Lessons

Date: 2026-07-03

1. **The G7 export needed no Hindsight API.** Hindsight 0.5.2 stores its data
   in the SAME Neon database (`neondb`) as the canonical schema, under the
   `public` schema (banks, documents, memory_units, chunks, entities,
   memory_links, async_operations, mental_models, unit_entities,
   entity_cooccurrences, webhooks — ~2.7k rows total). The export reads those
   tables generically via Hyperdrive from inside the Worker
   (`/api/mission/hindsight-export/*`, CF-Access-authenticated) — no container
   round-trip. Engine code removal does NOT drop these Postgres tables; they
   remain inert data history alongside the R2 archive.

2. **The Cron KEK is the TMK.** `src/cron/kek.ts`: "The KEK is the TMK raw
   bytes stored in KV with 24h TTL". So KEK-encrypting the export satisfies
   G7's "encrypted with the tenant TMK" literally. KEK provisioning happens
   only in `McpAgent.initTenant` (any authenticated MCP/WS session), keyed to
   the SESSION principal — a service-token session provisions the service
   token's own tenant, never Matt's. Exports of Matt's data therefore require
   Matt to authenticate once within 24h.

3. **Three tenants exist in prod D1**: `f512390d…` (telegram, 2026-03),
   `e3e9d43e…` (sms, 2026-04), `a87a44ab…` (sms, 2026-04 — the
   `haetsal-brain-shell-smoke` service-token tenant; confirmed by provisioning
   its KEK via an MCP initialize). Multiple tenants for one human = principal
   or AUD changes over time; tenant ids derive from HKDF(principal, AUD).
   Only the tenant whose KEK refreshes on Matt's CURRENT login is practically
   recoverable — encrypt archives under that one.

4. **Wrangler DO migrations are forward-only**: v5
   `deleted_classes = [HindsightContainer, HindsightWorkerContainer, GraphitiContainer]`
   deletes the engine DO classes. S8 caveat: after v5 applies, rolling back to
   a version exporting those classes conflicts with migration history —
   restoring would need a NEW forward migration re-adding them. The
   intermediate export deploy (Step A) deliberately carried no such risk.

5. **A postflight "Retired Engines" guard now enforces demo clause 10**
   mechanically: any hindsight/graphiti reference in src/** or wrangler.toml
   fails checkout, with exemptions only for the tenants-table legacy column
   (`tenant.ts` files), wrangler migration-history entries, and comment lines
   explicitly marked historical/retired. The guard doubled as the removal
   worklist (644 violations → 0).

6. **Engine-name type unions were retired to `string`.**
   `CanonicalProjectionKind` and provenance `projectionKind` fields now carry
   plain strings ('canonical' + historical row values + future projection
   kinds like AI Search) so historical Postgres rows stay readable without
   engine-named code.

7. **`fold-postgres` (Matt's other project) auto-binds localhost:5432 when
   Docker Desktop runs** — the brain's local dev Postgres lives on 5433
   (`brain-dev-pg`). Watch for this on any future local-DB work.

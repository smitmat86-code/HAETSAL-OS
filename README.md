# HAETSAL OS

> Personal AI second brain built on Cloudflare + canonical Neon Postgres.
> Private by default. Action-capable. Self-improving.
>
> Public MCP face: `https://haetsalos.specialdarksystems.com/mcp`
> Internal legacy Worker/runtime name: `the-brain`

---

## Architecture Reference

Full system design: `THE_BRAIN_ARCHITECTURE.md` (in project root or reference docs)

Constitutional law for this codebase: `ARCHITECTURE.md`

Long-term advanced open-brain target:
`docs/advanced-open-brain-architecture.md`

---

## Getting Started (AI Coding Agent)

Read these files in order before writing any code:

1. `MANIFEST.md` - module registry and binding status
2. `SESSION_LOG.md` - last 3 session entries
3. `LESSONS.md` - relevant section for your work area
4. `ARCHITECTURE.md` - three laws + state tiers + compute continuum
5. Your active spec in `specs/active/`

---

## The Three Laws

**Law 1 - One Public Face**
McpAgent Worker is the only public surface. Canonical Neon Postgres is internal
only, reachable exclusively through the `HYPERDRIVE_CANONICAL` binding from
HAETSAL's canonical DB adapter running inside the Worker.
The public MCP endpoint is `https://haetsalos.specialdarksystems.com/mcp`;
the Worker can remain named `the-brain` internally.

**Law 2 - Key-Isolated Platform**
Tenant keys stay scoped to authenticated session work. Canonical Postgres via
Hyperdrive receives plaintext memory content through HAETSAL's canonical DB
adapter, while HAETSAL-owned archives, traces, and cron material remain
encrypted at rest with tenant-scoped or cron-scoped keys.

**Law 3 - Agents Write Facts, Crons Write Patterns**
Domain agents write episodic and semantic memories only.
Procedural memories are exclusively written by the consolidation cron.
Enforced structurally in `brain_v1_retain` middleware - not by prompt.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Cloudflare Workers (Hono routing) |
| Memory substrate | Canonical Neon Postgres, reached via Hyperdrive (`HYPERDRIVE_CANONICAL`) through HAETSAL's canonical DB adapter |
| Database | Neon Postgres (pooled via Hyperdrive, no containers) |
| Session state | Cloudflare Durable Objects (McpAgent) |
| Operational metadata | Cloudflare D1 |
| Semantic search | Postgres pgvector (T1) via the 7-mode retrieval broker; Vectorize binding present but unused |
| Artifact storage | Cloudflare R2 (governed, encrypted exact originals and declared derivatives) |
| Async jobs | Cloudflare Queues + Workflows |
| AI routing | Cloudflare AI Gateway (haetsal-brain-gateway) |
| Web UI | Cloudflare Pages |
| Browser automation | Cloudflare Browser Rendering (CDP) |
| SMS / Voice | Telnyx |
| Auth | Cloudflare Access (WebAuthn/passkeys) |

---

## Canonical Memory Substrate

Post-Hindsight (mission Phase 3, 2026-07): the Hindsight engines (API
container + dedicated worker containers) have been removed. Canonical Neon
Postgres, reached through Hyperdrive, is now the only memory substrate.

```
Binding: HYPERDRIVE_CANONICAL
Schema: haetsal_canonical
Access: HAETSAL's canonical DB adapter, inside the Worker only
Retrieval: 7-mode broker (raw | lexical | semantic | graph | temporal | compiled | composed)
Embeddings: Workers AI @cf/baai/bge-base-en-v1.5 via AI Gateway (collectLog: false),
            stored in Postgres pgvector
```

Historical D1 tables (`hindsight_operations`, `hindsight_bank_config`,
`tenants.hindsight_tenant_id`) remain in the schema as inert history and are
not written to. The dream cycle reads authorized canonical Neon chunks and
writes its governed report back through the canonical capture path; compiled
wiki pages remain regenerable projections, not dream-cycle input. See
`ARCHITECTURE.md` for the full migration note and `LESSONS.md` for historical
Hindsight-era lessons (retained for archaeology, no longer operative).

---

## Key Development Commands

```bash
/checkout              # Ask the coding agent to run the repo checkout workflow
npm run checkout      # Full checkout workflow (postflight + tests + manifest + final gate)
npm run postflight    # Convention checks - must pass at session end
npm test              # Integration tests - must pass at session end
npm run manifest      # Regenerate MANIFEST.md module registry
npm run dev           # Local development (wrangler dev)
```

---

## Build Sequence

`docs/build-sequence.md` preserves the original Phase 1-5 roadmap. The current
mission and its live completion gates are tracked in `HAETSAL_MISSION.md`.

**Current phase:** Phase 13 hardening and final cutover
**Last completed:** Governed artifact intake Sessions 1-6, including recovery,
telemetry, canary coverage, and canonical dream-cycle integration
**Next gate:** Session 7 production migration, compatibility rollout, active
cutover, rollback proof, and live channel evidence

---

## Spec Workflow

1. Copy `specs/SPEC_TEMPLATE.md` to `specs/active/[N.N]-[name].md`
2. Complete all sections including the Laws Check and Behavioral Wiring
3. Review spec with Matt before implementation begins
4. Implement with AI coding agent
5. Complete As-Built record in the spec
6. Move completed spec to `specs/completed/`
7. Update SESSION_LOG.md, MANIFEST.md, LESSONS.md

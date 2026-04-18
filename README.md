# THE Brain

> Personal AI second brain built on Cloudflare + Hindsight + Neon Postgres.
> Private by default. Action-capable. Self-improving.

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
McpAgent Worker is the only public surface. Hindsight (Container) and Neon
are internal only, reachable via service binding and direct Postgres secret respectively.

**Law 2 - Key-Isolated Platform**
Tenant keys stay scoped to authenticated session work. Hindsight receives
plaintext through its official API, while HAETSAL-owned archives, traces, and
cron material remain encrypted at rest with tenant-scoped or cron-scoped keys.

**Law 3 - Agents Write Facts, Crons Write Patterns**
Domain agents write episodic and semantic memories only.
Procedural memories are exclusively written by the consolidation cron.
Enforced structurally in `brain_v1_retain` middleware - not by prompt.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Cloudflare Workers (Hono routing) |
| Memory engine | Hindsight API-only container + dedicated Hindsight worker containers |
| Database | Neon Postgres (direct from Hindsight container) |
| Session state | Cloudflare Durable Objects (McpAgent) |
| Operational metadata | Cloudflare D1 |
| Semantic search | Cloudflare Vectorize |
| Artifact storage | Cloudflare R2 |
| Async jobs | Cloudflare Queues + Workflows |
| AI routing | Cloudflare AI Gateway (haetsal-brain-gateway) |
| Web UI | Cloudflare Pages |
| Browser automation | Cloudflare Browser Rendering (CDP) |
| SMS / Voice | Telnyx |
| Auth | Cloudflare Access (WebAuthn/passkeys) |

---

## Hindsight Version Pin

```
Image: ghcr.io/vectorize-io/hindsight-api:0.5.2
Date: 2026-04-17
Reason: API-only runtime for HAETSAL, paired with dedicated Hindsight worker
        containers and direct Neon. This is the production shape for the
        repaired async retain/recall/reflect path.
```

**Before any Hindsight upgrade:**
1. Diff migration files against current Neon schema
2. Test on a Neon branch
3. Update the pin above with date and reason

## Current Hindsight Topology

- API service: Cloudflare Container on port `8888`
- Background processing: dedicated `hindsight-worker` container instances on `8889`
- Database: direct `NEON_CONNECTION_STRING`
- LLM routing: Cloudflare AI Gateway (`haetsal-brain-gateway`)
- Interactive writes: direct Hindsight `async=true` retain with HAETSAL-side
  operation tracking in D1
- External and bulk ingestion: HAETSAL queues feeding the canonical retain pipeline

---

## Key Development Commands

```bash
npm run postflight    # Convention checks - must pass at session end
npm test              # Integration tests - must pass at session end
npm run manifest      # Regenerate MANIFEST.md module registry
npm run dev           # Local development (wrangler dev)
```

---

## Build Sequence

See `docs/build-sequence.md` for the full Phase 1-5 spec roadmap.

**Current phase:** Phase 1 - Foundation
**Last completed:** Session 1.1 - Infrastructure Bedrock
**Next spec:** Session 1.2 - McpAgent Worker + auth + TMK derivation

---

## Spec Workflow

1. Copy `specs/SPEC_TEMPLATE.md` to `specs/active/[N.N]-[name].md`
2. Complete all sections including the Laws Check and Behavioral Wiring
3. Review spec with Matt before implementation begins
4. Implement with AI coding agent
5. Complete As-Built record in the spec
6. Move completed spec to `specs/completed/`
7. Update SESSION_LOG.md, MANIFEST.md, LESSONS.md

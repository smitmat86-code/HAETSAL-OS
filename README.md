# THE Brain

> Personal AI second brain built on Cloudflare + Hindsight + Neon Postgres.
> Zero-knowledge. Action-capable. Self-improving.

---

## Architecture Reference

Full system design: `THE_BRAIN_ARCHITECTURE.md` (in project root or reference docs)

Constitutional law for this codebase: `ARCHITECTURE.md`

---

## Getting Started (AI Coding Agent)

Read these files in order before writing any code:

1. `MANIFEST.md` — module registry and binding status
2. `SESSION_LOG.md` — last 3 session entries
3. `LESSONS.md` — relevant section for your work area
4. `ARCHITECTURE.md` — three laws + state tiers + compute continuum
5. Your active spec in `specs/active/`

---

## The Three Laws

**Law 1 — One Public Face**
McpAgent Worker is the only public surface. Hindsight (Container) and Neon
are internal only, reachable via service binding and Hyperdrive respectively.

**Law 2 — Zero-Knowledge Platform**
All memory content encrypted AES-256-GCM with tenant keys before Neon write.
Cron jobs use a time-bound Cron KEK (provisioned during active session, stored
encrypted in KV). Platform operator never sees plaintext content.

**Law 3 — Agents Write Facts, Crons Write Patterns**
Domain agents write episodic and semantic memories only.
Procedural memories are exclusively written by the consolidation cron.
Enforced structurally in `brain_v1_retain` middleware — not by prompt.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Cloudflare Workers (Hono routing) |
| Memory engine | Hindsight (Cloudflare Container, service binding) |
| Database | Neon Postgres via Cloudflare Hyperdrive |
| Session state | Cloudflare Durable Objects (McpAgent) |
| Operational metadata | Cloudflare D1 |
| Semantic search | Cloudflare Vectorize |
| Artifact storage | Cloudflare R2 |
| Async jobs | Cloudflare Queues + Workflows |
| AI routing | Cloudflare AI Gateway (brain-gateway) |
| Web UI | Cloudflare Pages |
| Browser automation | Cloudflare Browser Rendering (CDP) |
| SMS / Voice | Telnyx |
| Auth | Cloudflare Access (WebAuthn/passkeys) |

---

## Hindsight Version Pin

```
Commit: 58fdac44f78c60afa09871430c375c0459d14cb6
Tag: v0.4.16
Date: 2026-03-10
Reason: Initial pin — latest stable release. Schema migration threading fix,
        GIN index on source_memory_ids, Dependabot security fixes.
```

**Before any Hindsight upgrade:**
1. Diff migration files against current Neon schema
2. Test on a Neon branch
3. Update the pin above with date and reason

---

## Key Development Commands

```bash
npm run postflight    # Convention checks — must pass at session end
npm test              # Integration tests — must pass at session end
npm run manifest      # Regenerate MANIFEST.md module registry
npm run dev           # Local development (wrangler dev)
```

---

## Build Sequence

See `docs/build-sequence.md` for the full Phase 1–5 spec roadmap.

**Current phase:** Phase 1 — Foundation
**Last completed:** Session 1.1 — Infrastructure Bedrock
**Next spec:** Session 1.2 — McpAgent Worker + auth + TMK derivation

---

## Spec Workflow

1. Copy `specs/SPEC_TEMPLATE.md` to `specs/active/[N.N]-[name].md`
2. Complete all sections including the Laws Check and Behavioral Wiring
3. Review spec with Matt before implementation begins
4. Implement with AI coding agent
5. Complete As-Built record in the spec
6. Move completed spec to `specs/completed/`
7. Update SESSION_LOG.md, MANIFEST.md, LESSONS.md

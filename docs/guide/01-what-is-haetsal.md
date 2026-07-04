# 1. What is HAETSAL?

> **In plain terms:** HAETSAL is a private brain that runs on the internet
> instead of your laptop. You feed it — texts, notes, photos, eventually
> email — and it remembers, connects, and retrieves those things for you
> and for your AI tools. It can also *do* things (search, draft, remind,
> message), but anything consequential waits for your explicit approval.
> It runs 24/7 on Cloudflare's edge network; there is no computer at home
> that has to stay on.

## What it is, concretely

- **A memory** you can write to from anywhere — a Telegram message, a
  Claude Code session, an Obsidian note, a photo — and query in plain
  language ("what did I decide about the garage project last month?").
- **An assistant** that answers grounded in that memory, citing which
  memories it used, rather than improvising.
- **An actor** with a permission system: reading the web is automatic;
  sending a message that can't be unsent requires your tap.
- **A colleague that works nights**: a 2am "dream cycle" reviews the day,
  proposes consolidations and flags contradictions, and reports what it
  did in your 7am brief — proposals only, never silent edits.

## What it is not

- Not a chatbot with fake memory: nothing is "remembered" unless it went
  through the capture pipeline with provenance (who said it, when, how
  trustworthy).
- Not an autonomous agent with your credentials: agents cannot write
  "procedures" (instructions that change future behavior), and
  irreversible actions always stop at an approval gate.
- Not a data business: single tenant, your data, one readable copy,
  in a database you control.

## The Three Laws

The whole architecture hangs off three rules (defined in
`HAETSAL_MISSION.md` and `ARCHITECTURE.md`):

**Law 1 — One Public Face.** Exactly one Worker (`the-brain`) is reachable
from the internet, and the entire hostname sits behind Cloudflare Access
(Google sign-in). Everything else — database, queues, storage — is
internal. One door, one lock.

**Law 2 — Zero-Knowledge / Key-Isolated.** Readable memory content exists
in exactly one store: the canonical Postgres database (Neon), reached
through Hyperdrive from inside the Worker. Every other store — the
metadata database (D1), key-value cache (KV), object storage (R2), logs,
analytics — holds ciphertext or content-free metadata. Encryption keys are
derived per-session from your identity or held short-lived for scheduled
jobs; no long-lived master key sits in a config file.

**Law 3 — Agents Write Facts.** AI agents may record *what happened* and
*what is* (episodic, semantic, world memory). They may not write
*procedures* — memory that instructs future behavior. Procedure-class
memory is reserved for you. This is the guard against an agent (or a
prompt injection) teaching the brain bad habits.

## What works today (2026-07-04)

| Capability | Status |
|---|---|
| Capture + search memory (7 modes) from MCP clients | **Live** |
| Telegram chat with grounded, cited replies | **Live** |
| Photo → vision extraction → memory | **Live** (gated with a real photo, Phase 4) |
| Actions: web search, browse, draft, remind, calendar, message | **Live** (send = approval-gated) |
| Sub-agents: spawn, watch, cancel (<1s), retry | **Live** |
| Automations ("every morning at 7…") | **Live** |
| Dream cycle + review inbox + morning brief | **Live** |
| Dashboard (8 panels) | **Live** |
| Memory decay (importance × access aging) | **Live** |
| Hourly canary self-checks | **Live** |
| Gmail/Calendar ingestion, real email send | **Blocked on Google OAuth** ([setup doc](../lessons/phase-5-google-oauth-setup.md)) |
| iMessage inbound | Unreliable (Sendblue free tier); Telegram is primary |

---

## Under the hood

The system is one Cloudflare Worker (`the-brain`, entry
`src/workers/mcpagent/index.ts`) plus one Durable Object class
(`McpAgentDO`) that hosts your session, the MCP server, sub-agent facets,
automations, and per-tenant state. Supporting cast: Neon Postgres (via
`HYPERDRIVE_CANONICAL`) for canonical memory, D1 for metadata, KV for
session/key material, R2 for encrypted artifacts, five Queues for
prioritized async work, two Workflows (bootstrap, dream cycle), Workers AI
through an AI Gateway (`haetsal-brain-gateway`) for all model calls, and
Browser Rendering for the browse action.

"Single tenant" is a soft constraint: every table, key, and route is
tenant-scoped (`tenant_id` everywhere, per-tenant keys), so the design is
multi-tenant-shaped, but exactly one tenant (you) exists, derived from
your Cloudflare Access identity.

## Why it's built this way

The predecessor design ran memory in a third-party engine (Hindsight)
inside containers. It was buggy, opaque, and — worse — it was the
plaintext boundary. The mission (June–July 2026) replaced it with a
substrate you can reason about: plain Postgres you own, one plaintext
boundary inside the Worker, and everything else key-isolated. The Three
Laws are the distilled lessons: one attack surface (Law 1), one readable
copy (Law 2), and no self-modifying agent behavior (Law 3).

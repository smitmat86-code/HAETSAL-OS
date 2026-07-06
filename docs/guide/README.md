# The HAETSAL OS Guide

HAETSAL OS ("the brain") is your personal AI operating system: a hosted,
always-on second brain that lives at `haetsalos.specialdarksystems.com`,
remembers what you tell it, acts on your behalf with your approval, and
works while you sleep. This guide serves two readers at once:

- **You, day to day.** Every chapter opens with a plain-language section —
  what it does, how to use it, no jargon. If that's all you want, read the
  top of each chapter and stop at the "Under the hood" divider.
- **You (or anyone technical), when you want the machinery.** Below each
  divider: how it actually works, file-level pointers, and *why* it was
  built that way.

## Chapters

| # | Chapter | Read this when you want to know… |
|---|---------|----------------------------------|
| 1 | [What is HAETSAL?](01-what-is-haetsal.md) | What this system is, the Three Laws, what works today |
| 2 | [Daily use](02-daily-use.md) | How to talk to it — Telegram, Claude Code, the dashboard, approving actions |
| 3 | [Feeding the brain](03-feeding-the-brain.md) | Every way to get things IN — notes, photos, chats, email — and what happens to them |
| 4 | [Nights & weekends](04-nights-and-weekends.md) | What it does on its own: the clock, the dream cycle, the morning brief |
| 5 | [Architecture](05-architecture.md) | The system design — one Worker, Durable Objects, queues, workflows |
| 6 | [The memory model](06-memory-model.md) | How memories are stored, trusted, retrieved, compiled, and aged |
| 7 | [Security](07-security.md) | The Three Laws enforced — keys, encryption, action authorization |
| 8 | [Operations](08-operations.md) | Deploys, rollback, tests, canaries, troubleshooting |
| 9 | [Reference](09-reference.md) | Tables of everything: tools, endpoints, crons, stores, migrations |
| 10 | [Connecting your tools](10-connecting-clients.md) | Step-by-step: claude.ai, Claude Code, Codex, anything MCP — and the identity rule |
| 11 | [Working with Claude Code](11-working-with-claude-code.md) | What is (and is not) collected while you code |
| 12 | [The System panel](12-system-panel.md) | See every agent/prompt/model/cron — and edit prompts with versioning + rollback |

## Sixty-second quick start

1. **Talk to it**: message the Telegram bot (`@haetsal_os_bot`). It replies
   with answers grounded in your memory and cites where it got them.
2. **See inside it**: open `https://haetsalos.specialdarksystems.com/dashboard.html`
   (sign in with your Google account via Cloudflare Access). Eight panels:
   memory, agents, timeline, dream, automations, connections, usage, traces.
3. **Wire up Claude Code / Codex**: add the MCP server
   `https://haetsalos.specialdarksystems.com/mcp` (Streamable HTTP). Once
   connected, `capture_memory` writes and `search_memory` reads — your
   coding sessions share the same brain you text.
4. **Automate something**: tell it "every weekday at 7am, brief me on my
   day" — that becomes a standing automation you can pause or delete from
   the dashboard.
5. **Let it sleep on it**: at 2am the dream cycle consolidates the day —
   contradictions get flagged for your review, never silently "fixed."
   The 7am brief includes a "While You Slept" section.

## The one thing to remember

Everything in this system flows through a single rule: **your memory
content lives, in readable form, in exactly one place** (an encrypted
Postgres database), and every other component sees ciphertext or
content-free metadata. Every feature in this guide — approvals, dreams,
dashboards, sub-agents — was built to preserve that rule. When something
seems indirect ("why does approving an action need a key family?"), the
answer is almost always: because the direct way would have leaked content
somewhere it doesn't belong.

## Status at a glance (2026-07-04)

Mission Phases 0–13 complete and deployed. Live today: memory capture +
seven retrieval modes, Telegram chat, MCP clients, actions with approval,
sub-agents with cancel/retry, automations, dream cycle, compiled pages,
8-panel dashboard, memory decay, hourly canaries. **Waiting on one thing:**
Google OAuth credentials (six console steps + two secrets —
[the setup doc](../lessons/phase-5-google-oauth-setup.md)) to switch on
Gmail/Calendar ingestion and real email send. iMessage via Sendblue works
outbound but inbound is unreliable on the free tier; Telegram is the
reliable channel today.

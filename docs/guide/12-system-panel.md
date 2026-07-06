# 12. The System panel

> **In plain terms:** The dashboard's ninth panel is the machine looking at
> itself: every agent, the exact prompt it runs on, which model it uses,
> which tools it may touch, the full clock, and your safety settings — and
> the prompts are **yours to edit**. Every save is a new version; history
> is kept forever; one click rolls back or resets to the built-in default.
> Only you can do this — no agent has a tool that reaches this surface.

## What you can see

- **Prompts & agents** — each prompt with its live text, where it's used,
  and whether it's running on the code default or your override (with
  version number). Read-only entries (the dream cycle's strict-JSON
  extraction prompt, the write-policy classifier) are shown but locked —
  their output format is load-bearing for parsers.
- **Scheduled jobs** — the platform crons (morning brief, dream cycle,
  heartbeat, weekly synthesis) with working on/off toggles.
- **Action authorization** — approval level per capability class. Floors
  clamp upward: you can make the brain ask *more*, never less.
- **Registry (read-only)** — models per role, sub-agent tool profiles,
  the action-tool table with gates, and the cron clock.

## Editing a prompt safely

1. **Edit** opens the current text in place. Placeholders like `{channel}`
   are substituted at use time — keep them if you want channel-aware
   wording.
2. **Save as new version** — the old version stays in history; the new one
   goes live immediately (next message, next spawn).
3. **History** shows every version with a diff against the current text
   and a **Restore** button.
4. **Reset to default** returns to the built-in prompt without deleting
   your history.

What you can edit today: the chat persona, the grounded-reply persona, and
the sub-agent preamble. What stays code-owned even in edited prompts: the
retrieved-memories block, session context, and the sub-agent's tool rules
are appended by code *after* your text — an override can't accidentally
disconnect the brain from its memory or its safety rules.

---

## Under the hood

- **Storage**: `system_prompt_overrides` (D1, migration 1027) — one row
  per version, bodies sealed `KEK1:` under the Cron KEK (readable on
  webhook/cron paths where no user JWT exists). Resolution
  (`src/services/prompts/overrides.ts`) **fails open to the code
  default** with a content-free warn — a missing key or decrypt error can
  never take a chat surface down (contract-tested, `mission-14.0`).
- **Single source of truth**: `src/services/prompts/registry.ts` holds
  the catalog + default texts; the live call sites (Telegram/SMS persona,
  grounded reply, execution preamble) import from it — fixing a
  long-standing duplication where two files carried drifting copies of
  the same persona.
- **Law 3 enforcement**: writes go through `/api/system/*` routes behind
  CF Access — the authenticated *user* only. The MCP surface exposes no
  prompt tool (guarded by a test), and every save/rollback/reset writes a
  content-free audit row (`system.prompt_*`, key in the domain column).
- **Task toggles are real**: `scheduled_tasks.enabled` was seeded at
  bootstrap but never read; the cron handlers now check it per tenant
  (`src/services/system/tasks.ts`), so "Turn off" genuinely silences the
  morning brief / dream cycle / heartbeat. Manual runs
  (`POST /api/dream/run`) bypass the toggle on purpose.

## Why it's built this way

Editing agent behavior is the one place where convenience and governance
collide. The design keeps the git-grade properties (versioned, diffable,
revertible, audited) while moving the edit loop from "code → deploy" to
"textarea → save." Overrides layer *over* code defaults rather than
replacing them, so deploys can't clobber your edits and your edits can't
break a deploy — and the load-bearing scaffolding (grounding, tool rules,
JSON contracts) stays out of reach of a well-meaning late-night edit.

# 2. Daily use

> **In plain terms:** You have three doors into the brain: **Telegram**
> for conversation, **the dashboard** for seeing and approving, and **MCP**
> for letting your AI coding tools (Claude Code, Codex) share the same
> memory. Ask questions, tell it things worth remembering, approve the
> actions it proposes, and set up standing automations in plain English.

## Talking to it: Telegram

Message `@haetsal_os_bot`. What you can do:

- **Ask anything about your own life/work**: it searches your memory and
  answers with citations to the memories it used.
- **Tell it something worth keeping**: statements of fact, decisions, and
  preferences get captured with you as the source (the highest-trust
  source there is — see [chapter 6](06-memory-model.md)).
- **Send a photo**: it goes through vision extraction and lands as a
  memory ("whiteboard from the kitchen reno planning").
- **Ask it to do something**: "search for reviews of X", "draft a reply to
  Sarah", "remind me Thursday at 3". Reads happen immediately; anything
  irreversible comes back as a proposal for you to approve.
- **Create an automation**: "every weekday at 7am, summarize my open
  loops" — it confirms the schedule and registers it.

A conversation is a **working session**: the brain keeps the last ~30
minutes of back-and-forth as context, so follow-ups work naturally. After
30 idle minutes (or 40 turns) the session closes itself and writes a
summary into memory — so tomorrow, "what did we talk about yesterday?"
works.

## Seeing it: the dashboard

`https://haetsalos.specialdarksystems.com/dashboard.html` — sign in with
Google (Cloudflare Access gates the whole domain). Eight panels:

| Panel | What you see / do |
|---|---|
| **Memory** | Search your memory; default view shows the most recent captures |
| **Agents** | Live and past sub-agent runs — watch, **cancel**, **retry** |
| **Timeline** | Recent activity across the system |
| **Dream** | Last night's report and the review inbox (proposals awaiting you) |
| **Automations** | Every standing automation — pause, resume, delete |
| **Connections** | Which channels/integrations are connected (presence only) |
| **Usage** | AI cost tracking, derived from the audit ledger |
| **Traces** | Recent retrieval traces — what the brain looked at to answer |

## Approving actions

When the brain wants to do something irreversible (send a message, run a
multi-step playbook), it doesn't do it — it files a **pending action** and
asks you. You approve or reject from the surface where it asked (Telegram)
or the dashboard. Two things are guaranteed:

1. **Draft-first**: you see exactly what would be sent before it exists
   anywhere but as an encrypted draft.
2. **What you approved is what runs**: the payload is sealed (encrypted)
   at proposal time and integrity-checked at execution — nothing can swap
   the content between your tap and the send (the "TOCTOU" guard).

Approvals work even hours later, cold: see [chapter 7](07-security.md)
for how the key handoff works.

## Your AI tools: Claude Code / Codex over MCP

Add the brain as an MCP server: `https://haetsalos.specialdarksystems.com/mcp`
(Streamable HTTP transport), authenticated by Cloudflare Access — browser
SSO for interactive tools, or a service token (`CF-Access-Client-Id` /
`CF-Access-Client-Secret` headers) for headless use. External clients get
the scoped **brain-memory surface**:

- `capture_memory` — the one write tool: memories go through the
  canonical contract (content, scope, provenance recorded automatically).
- `search_memory` — query in any of seven modes; `composed` mode returns
  an assembled, citation-tagged bundle.
- Plus nine more read-side tools (traces, entity timelines, documents,
  status/stats — full list in [chapter 9](09-reference.md)).

So mid-coding-session you can do "capture: we chose library X because Y"
and next week ask, from Telegram, "why did we pick X?" — one brain, all
doors.

---

## Under the hood

- **Channel entry**: Telegram inbound lands on `POST /telegram/webhook`
  (`src/workers/mcpagent/public-webhooks.ts`, secret-verified); SMS and
  the Gmail/Calendar webhooks live in `routes/ingest.ts`. Verified
  messages route into your session Durable Object. Chat state lives in the DO's SQLite as
  `parts_ciphertext` — session content at rest in the DO is encrypted
  (Law 2), and only the close-summary lands (plaintext) in canonical
  Postgres, tagged `session:<channel>`.
- **Session lifecycle**: `src/services/session/working-session.ts` +
  `src/workers/mcpagent/do/session-runtime.ts`. Idle-close 30 min, 40-turn
  ceiling, SDK-shaped message parts so the same structure feeds models
  directly.
- **Dashboard**: a single static SPA (`public/dashboard.html`) served via
  Workers Static Assets, calling JSON feeds under
  `src/workers/mcpagent/routes/dashboard-data.ts` and the feature routes
  (`agent-runs.ts`, `automations.ts`, `dream.ts`). The page builds DOM via
  `textContent` only with delegated event handling — no HTML interpolation
  anywhere (XSS discipline; a verifier finding made this a hard rule).
- **MCP surface**: the DO hosts the MCP server. Full tool registry:
  memory tools (`capture_memory`, `search_memory`; legacy
  `brain_v1_retain`/`brain_v1_recall`), action tools (`brain_v1_act_*`),
  and automation tools (`create/list/toggle/delete_automation`). External
  clients are scoped by `src/tools/brain-memory-surface.ts` to the memory
  surface; the act tools are the interaction agent's, behind the
  authorization engine.
- **Approvals**: pending actions live in D1 (`pending_actions`, metadata
  only) with payloads sealed to R2 under a key-family tag; the approval
  route re-derives your key from your authenticated request and executes
  via `src/services/action/approved-execution.ts`.

## Why it's built this way

Every door leads to the *same* memory contract — there is no "Telegram
memory" vs "Claude Code memory." That's deliberate: provenance (which door,
which author) is recorded *on the memory* instead of by fragmenting
storage. And the approval flow is shaped by Law 2: the brain must be able
to hold a proposed action for hours without the content being readable by
anything except the moment of your approval — which is exactly what the
sealed-payload design provides.

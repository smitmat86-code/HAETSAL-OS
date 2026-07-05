# 11. What happens when you work in Claude Code / Codex

> **In plain terms:** Nothing is collected automatically. The brain is not
> watching your coding session, reading your files, or logging your
> prompts. Your coding agent gets two abilities: it can **look things up**
> in your memory when useful, and it can **save something** when you (or
> it, judging something worth keeping) explicitly call the capture tool.
> Each of those is a single, visible tool call — not a background process.

## The mental model

Think of the brain as a colleague your coding agent can consult, not a
camera over its shoulder:

- **Reads**: when the agent needs context ("why did Matt pick Hyperdrive?"),
  it calls `search_memory` and gets cited results. You see this as a
  normal tool call in your session.
- **Writes**: when something is worth keeping ("decision: we're using
  key-family tags on sealed payloads"), it calls `capture_memory` with
  that content. That call — its exact text — is the *only* thing that
  leaves your session.

There is no transcript sync, no file upload, no telemetry. If you never
call the tools, the brain never hears about the session. The flip side:
the brain only knows what got captured — so a session that captures
nothing contributes nothing. Good practice is capturing *decisions and
rationale* as you go (or asking the agent to "capture the key decisions
from this session" before you close it).

## What a capture from a coding session looks like

When `capture_memory` fires, the standard pipeline
([chapter 3](03-feeding-the-brain.md)) runs — with provenance that
records it came from a coding tool, not from you directly:

- **Author kind**: `external_client` (vs `user` for things you text in) —
  which caps its trust: it enters as evidence, not gospel, and can never
  carry instruction-grade authority (Law 3 downgrade rules).
- **Source system**: the MCP client identity.
- Same one-readable-copy handling as everything else: plaintext to
  canonical Postgres, sealed archival copy to R2, embeddings for search.

So when you later ask, from Telegram, "why did we choose X?", the answer
can cite "captured from a Claude Code session on July 5th" — and you know
to weight it accordingly.

## Is it a separate process/workflow?

No. It's the same brain, same pipeline, same tenant (when you're signed
in as yourself — [chapter 10](10-connecting-clients.md)). A tool call
from Claude Code takes the identical path a Telegram capture takes; the
only difference is the provenance stamp. There is also no per-session
"working session" object for MCP clients — that machinery
([chapter 2](02-daily-use.md)) belongs to conversational channels;
MCP tool calls are individually authenticated, stateless requests.

## Why it's built this way

Ambient collection was rejected deliberately, for three reasons.
**Law 2 economics**: hoovering session transcripts would push huge
volumes of sensitive plaintext through the capture pipeline for marginal
retrieval value. **Signal quality**: retrieval degrades when ten
thousand incidental lines bury the fifty decisions that matter — capture
what's *worth remembering* and the decay/reinforcement model
([chapter 6](06-memory-model.md)) keeps it healthy. **Trust**: a coding
agent's output is the least-vetted content in the system; it enters at
the lowest rung of the trust ladder, and only explicit calls enter at
all. If you ever want richer automatic capture (say, a session-end
summary hook in Claude Code that calls `capture_memory` once), that's a
client-side hook writing through the same governed front door — an easy
recipe, not an architecture change.

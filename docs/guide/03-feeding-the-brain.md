# 3. Feeding the brain

> **In plain terms:** There are seven ways to get things into the brain
> today, from "just text it" to "drop a note in a folder." Everything you
> feed it goes through one pipeline that records *where it came from, who
> authored it, and how much to trust it* — then stores one readable copy
> in your Postgres database and an encrypted archival copy in object
> storage. Nothing gets in through a side door.

## The inlets (recipes)

### 1. Text it (Telegram) — the everyday inlet
Send a message to `@haetsal_os_bot`. Conversational turns feed the working
session; things worth keeping are captured as memories with you as author
(`user`-authored, highest trust). Decisions, preferences, facts — just say
them.

### 2. Send a photo
Attach a photo in Telegram. The image is stored encrypted in R2, run
through vision extraction, and the *description + extracted content*
becomes a governed memory linking back to the artifact. Whiteboards,
receipts, book pages.

### 3. From Claude Code / Codex (`capture_memory` + managed files)
In any MCP-connected session: capture decisions, findings, and context.
The capture is tagged `external_client` authorship with the client
identity — so later you know a memory came from a coding session, not
from your own mouth.

For an image or document, the coding agent inspects it locally, uploads the
exact original with `~/.haetsal/bin/haetsal-artifact-upload.ps1`, then calls
`finalize_artifact_capture` with its searchable extraction and the complete
source/derivative manifest. File bytes and local paths never travel through an
MCP argument. The raw original and every intentional derivative are retained;
omitting a declared derivative makes finalization fail.

### 4. Obsidian vault
Two cron-driven paths (see [chapter 4](04-nights-and-weekends.md)):
- Drop a note in the **`/to-brain/` folder** → picked up within a minute,
  ingested, note stays yours.
- Add **`brain: true`** to any note's frontmatter → the vault-wide scan
  (every 15 min) ingests and keeps it in sync.

### 5. Session summaries (automatic)
When a working session closes, its summary is captured with source
`session:<channel>`. You do nothing; yesterday's conversations are
queryable today.

### 6. The system itself (automatic, governed)
The dream cycle, automations, and sub-agents write what they learned —
but as **agent-authored facts** with `evidence`-grade trust, never as
instructions (Law 3), and consolidation changes are *proposals* until you
approve them in the review inbox.

### 7. Gmail + Calendar — built, waiting on OAuth
Once Google OAuth is provisioned ([six steps + two
secrets](../lessons/phase-5-google-oauth-setup.md)): Gmail threads are
fetched read-only and funneled through the same pipeline (yes — **emails
land in Neon**, as canonical captures with thread provenance). Calendar
events are ingested with privacy reduction — attendee *counts*, never
names/emails. Until then, any Gmail-touching request stops honestly with
`GmailNotConnectedError`.

## Bulk imports: bringing your history in

OB1's `/recipes` catalog (ChatGPT exports, Perplexity, X/Twitter,
Instagram, Google Takeout, Grok, Blogger, Gmail archives) is the right
*shopping list*, and the intended HAETSAL pattern for all of them is the
same: **a one-shot import script per source that parses the export file
and feeds each item through the same governed front door** —
`capture_memory` (or `retainContent()` directly) with real timestamps,
`trusted_import` provenance, and the built-in dedup hash so re-running an
import converges instead of duplicating. No new engine is needed: parsing
is the only per-source work; deduplication, embedding, governance, decay,
and retrieval already exist. Practical notes:

- **Order of value**: ChatGPT/Claude conversation exports and Google
  Takeout (Gmail archive) are the densest personal-context sources —
  worth doing first. Social exports (X, Instagram) are thinner.
- **Volume is fine**: imports enter as low-prominence classes and the
  decay/reinforcement model surfaces what you actually use
  ([chapter 6](06-memory-model.md)).
- **Live Gmail vs archive import are different inlets**: the webhook
  ingestion (below) covers new mail once OAuth lands; a Takeout import
  covers the past. Same pipeline, different adapters.

None of these import scripts exist yet — each is roughly an afternoon of
adapter work in `scripts/`.

## What should you feed it?

The system is calibrated for **decisions, facts, preferences, and
episodes** — "we chose X because Y", "Sarah prefers morning meetings",
"the contractor quoted $8k". High-volume raw streams (full inboxes, chat
logs) are what the ingestion + decay machinery is built to digest: raw
material comes in as low-trust `raw_source`/`observation` and only earns
prominence through use. You don't need to curate before feeding — the
governance model does the sorting — but the more you state things
explicitly, the better your citations get.

---

## Under the hood

Every inlet converges on **`retainContent()`**
(`src/services/ingestion/retain.ts`) → the canonical capture pipeline
(`src/services/canonical-capture-pipeline.ts`). One capture produces:

1. A **document + chunks** in canonical Postgres (the one searchable plaintext copy),
   with `source_system`, `source_ref`, `scope`, and `captured_at`.
2. A **governance envelope** (see [chapter 6](06-memory-model.md)):
   memory class (`raw_source` … `fact` … `compiled_view`), trust state
   (`evidence`, `user_confirmed`, …), use policy, author kind
   (`user`/`agent`/`cron`/`external_client`/`system`), and an audit
   operation. Requests that over-claim (an agent asking for
   `can_use_as_instruction`) are **downgraded**, and the downgrade is
   recorded on the receipt.
3. An **encrypted archival body** in R2 (`bodyR2Key`), sealed under your
   tenant key — the disaster-recovery copy that never needs Postgres.
4. **Embeddings** for the chunks (Workers AI `bge-base-en-v1.5` via the
   AI Gateway) written to pgvector for semantic search.
5. A **dedup hash** so re-feeding the same content converges instead of
   duplicating.

Managed files add a separate, tenant-scoped R2 ciphertext object for each raw
source and derivative. Canonical artifact rows hold hashes, sizes, media types,
roles, and parent links; tool receipts expose stable IDs, never public URLs.
Interactive files are capped at 25 MiB (Telegram at 20 MiB); larger inputs
return `bulk_import_required`. Expired or interrupted uploads are swept every
15 minutes, while finalized artifacts are immutable.

Bulk inlets (Obsidian scans, future Gmail) ride the priority **queues**
(`brain-priority-high/normal/bulk`) so a vault import can't starve a live
conversation. Queue messages carry content only in transit (seconds,
encrypted-at-rest copy written alongside) — an explicitly accepted
pattern, re-audited twice (ops runbook ADR #3).

## Why it's built this way

One pipeline means one place to enforce Law 2 (plaintext only to
Postgres + sealed R2), one place to stamp provenance, and one place to
police Law 3 (author-kind-based downgrades). The alternative — per-inlet
storage — is how systems end up with an unaudited plaintext cache
somewhere. The OB1-style "recipes" idea survives as *this chapter*, not as
a separate engine: each inlet is a thin adapter over the same contract, so
adding inlet #8 (say, a browser clipper) is an afternoon of adapter code,
not a new subsystem.

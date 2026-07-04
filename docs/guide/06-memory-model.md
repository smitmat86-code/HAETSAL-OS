# 6. The memory model

> **In plain terms:** Every memory knows where it came from, who wrote it,
> and how much it deserves to be trusted. Things you say outrank things
> the AI inferred; contradictions become questions for you, not silent
> edits. You can search by meaning, by keyword, by time, by connection —
> or ask for a "composed" answer that cites its sources. Old, never-used
> clutter fades; things you actually use get reinforced. And the brain
> can compile living summary pages (a project dossier) that regenerate
> from the underlying truth at any time.

## What a memory is

A capture = **content** + **provenance envelope**:

- **Where from**: source system (`telegram`, `mcp`, `obsidian`,
  `session:telegram`, `cron:consolidation`, …) and a source reference.
- **Who authored**: `user` | `agent` | `cron` | `external_client` | `system`.
- **What kind** (memory class): `raw_source` → `episode` → `observation`
  → `claim` → `fact` → `preference` → `procedure` → `compiled_view` — a
  ladder from raw material to distilled knowledge.
- **How trusted** (trust state): `evidence`, `inferred`, `user_confirmed`,
  `trusted_import`, `disputed`, `stale`, `superseded`, `rejected`.
- **How usable** (use policy): from `can_use_as_evidence` up to
  `can_use_as_instruction`, with `requires_confirmation` and
  `do_not_inject_automatically` in between.
- **How long kept** (retention): `standard` | `ephemeral` | `permanent`.

The rules that matter day-to-day:

- **You outrank the machine.** Agent-written memories enter as
  `evidence`-grade; only your confirmation elevates them.
- **Agents can't write instructions** (Law 3): an agent asking for
  `procedure` class or `can_use_as_instruction` policy is *downgraded
  automatically*, and the downgrade is stamped on the receipt.
- **Contradictions surface, never auto-resolve**: conflicting memories
  become `disputed` + a review-inbox item for you.

## Searching: the seven modes

`search_memory` accepts a `mode`:

| Mode | What it does |
|---|---|
| `raw` | Direct document lookup |
| `lexical` | Keyword/full-text search |
| `semantic` | Meaning-based (vector) search; degrades to lexical if embeddings are unavailable, and *says so* (`status: partial`) |
| `graph` | Entity/edge traversal — who's connected to what |
| `temporal` | Time-windowed ("last week" parses into a real window) |
| `compiled` | Read from a compiled page (see below) |
| `composed` | The full pipeline: retrieve across modes, assemble a cited bundle with provenance — what chat replies use |

Every result carries an **evidence contract** — enough provenance to cite
the memory, and every retrieval writes a **trace** (visible in the Traces
panel) recording what was consulted.

## Compiled pages: the brain's own documents

For subjects you touch often (a project, a person), the brain maintains a
**compiled page** — a markdown dossier synthesized from underlying
memories, with frontmatter declaring its sources, freshness, and review
status. Two properties make them safe:

- **Regenerable**: a compiled page is a *view*, never the truth. Delete it
  and rebuild (`POST /api/compiled/{kind}/{key}/rebuild`) — it comes back
  from the canonical memories.
- **Class-marked**: it's stored as `compiled_view`, so retrieval knows
  it's derived, not primary evidence.

## Decay: how the brain ages

Nightly, memories get an importance score:

```
score = 0.5^(age_days/30)            # recency half-life: 30 days
      + 0.3 × log2(1 + access_count) # how often retrieval actually used it
      + 0.2 if user-authored source  # you outrank pipelines here too
```

Score ≥ 0.9 (or 2+ retrieval hits) → **reinforced**. Score < 0.15 *and*
older than 3 weeks → **archived** — a soft ranking signal, never a delete.
Everything else stays active. Net effect: cron noise sinks, the things
you actually use float.

---

## Under the hood

- **Substrate**: canonical Postgres (Neon) via `HYPERDRIVE_CANONICAL` —
  documents, chunks, `chunk_embeddings` (pgvector), governance tables,
  edges/entities, reviews. Adapter: `src/services/canonical-postgres*.ts`,
  governance in `src/services/canonical-governance-*.ts`. Schema
  foundation: migration `1013_canonical_open_brain_foundation.sql`.
- **Capture** (`canonical-capture-pipeline.ts`) returns a
  `CanonicalCaptureResult`: capture/document/chunk ids, the governance
  receipt (including any downgrade), the sealed-body R2 key, and chunk
  texts held *in memory only* for the embedding hook
  (`src/types/canonical-memory.ts`).
- **Retrieval** (`src/services/retrieval-modes.ts` +
  `canonical-memory-query.ts`): per-mode functions with shared boosting
  (`retrieval-support.ts`), candidate over-fetch (3× limit) then re-rank;
  semantic thresholds at 0.3 similarity; temporal parsing via regex
  windows. The broker records primary/shadow traces to D1
  (`canonical_broker_traces`) — which is also what feeds decay's
  access counts.
- **Graph**: entities/edges live in the canonical governance store —
  populated by consolidation passes (bridge discovery), queried by
  `graph` mode and the canary's graph probe.
- **Decay** (`src/services/decay/pass.ts`): metadata-only by
  construction — the module takes **no key material**, reads capture
  metadata + trace counts, writes soft states to D1 `memory_decay`.
  Current scoring window: most recent 200 documents per pass (documented
  follow-up: page by staleness).
- **Compiled pages** (`src/services/compiled/page.ts`,
  `compiled-synthesis-*.ts`): registry rows in D1 (`compiled_pages`,
  kind-embedded subject keys so kinds can't collide), synthesis from
  canonical truth, artifacts sealed to R2 under your key.

## Why it's built this way

The governance envelope is the mission's core epistemology: **a memory
system an agent writes into must track *why it believes things*, or the
agent's confabulations become your facts.** Trust states + use policies +
author-kind downgrades make "the AI said so" structurally different from
"you said so" — and the review inbox keeps humans in the promotion loop.
Decay exists because append-only memory rots retrieval quality: without
aging, a year of cron noise outvotes the ten memories that matter. And
compiled pages answer gbrain's best idea (human-readable synthesized
documents) without violating the source-of-truth rule — they're cached
views, disposable by design.

# Second Brain Comparison For HAETSAL

Date: 2026-06-01

Scope:

- [garrytan/gbrain](https://github.com/garrytan/gbrain), inspected at commit `eefe8b5741c27e59bf65198d46e3dfe5bfa70ce9` from 2026-05-31.
- [KasperZutterman/Second-Brain](https://github.com/KasperZutterman/Second-Brain), inspected at commit `295ea0f052722723cc0564bd96f90ecd44e89335` from 2026-02-18.
- [NateBJones-Projects/OB1](https://github.com/NateBJones-Projects/OB1), inspected at commit `9ff61353329ad511887b168030fa3d35f59f3dcc` from 2026-05-22.
- Local HAETSAL OS docs, specs, and code in this workspace, especially `ARCHITECTURE.md`, `docs/advanced-open-brain-architecture.md`, and completed specs 6.1 through 9.4.

## Executive Summary

These projects are all called, or orbit around, "second brains", but they are not trying to solve the same problem.

The `Second-Brain` repo is not infrastructure. It is a map of public digital gardens. Its core lesson is cultural and human: good knowledge systems are browsable, personal, linked, opinionated, and alive in public or semi-public prose.

OB1 is the simplest open-brain foundation. It says: one database, one AI gateway, one MCP channel, any AI can read and write. Its strength is accessibility, portability, recipes, and a clear "do not overbuild the substrate" philosophy. Its newer Agent Memory layer adds the important missing governance model: agent-written memory starts as evidence, not instruction.

GBrain is a production-grade agent brain. It is closer to "compiled institutional memory" than a note app. Its core beliefs are: markdown/git should be the human-readable source of truth; the database is a derived index; retrieval needs hybrid search plus graph; the system should synthesize answers with citations and gap analysis; a dream cycle should repair and enrich the brain while the user sleeps.

HAETSAL is already the most architecturally layered of the four. It is not just a second brain. It is a personal AI operating-system shell with memory, agents, action authorization, Hindsight semantic projection, Graphiti graph projection, canonical capture-first writes, and a `brain-memory` MCP surface. The big risk is not lack of ambition. The risk is complexity outrunning UX, governance, and source-of-truth clarity.

Best synthesis:

- For a personal knowledge system, use HAETSAL's canonical memory and projection architecture, OB1's portability and review discipline, GBrain's source attribution and retrieval rigor, and the digital-garden world's human-readable evergreen output.
- For a company system, use HAETSAL's capability boundaries and audit model, GBrain's brain/source scoping and company-brain ideas, OB1's scoped MCP/tool-surface discipline, and explicit evidence-to-instruction review before any memory changes team behavior.

## One-Line Positioning

| System | What It Really Is | Main Opinion |
| --- | --- | --- |
| Second-Brain list | A catalog of public digital gardens | Knowledge is a lived, browsable, linked practice. |
| OB1 | A simple portable AI memory substrate | Your AI tools should share one database-backed memory. |
| GBrain | A production brain runtime for agents | Search is not enough; the brain must synthesize, cite, link, and self-maintain. |
| HAETSAL | A memory and agency operating system | Memory, graph, agents, actions, auth, and projections need separate roles under one public face. |

## HAETSAL Baseline: What Exists Here

HAETSAL has moved beyond the early architecture notes. Based on completed specs and code:

- Canonical capture foundation exists.
  - Canonical captures, documents, chunks, operations, projection jobs, and projection results were introduced in 6.1.
  - Current implementation uses a D1 plus encrypted R2 bridge layer rather than final canonical Postgres.
  - The target architecture still says Postgres plus R2 should be the long-term canonical substrate.

- Canonical MCP memory surface exists.
  - `capture_memory`
  - `search_memory`
  - `trace_relationship`
  - `get_entity_timeline`
  - `prepare_context_for_agent`
  - `get_recent_memories`
  - `get_document`
  - `memory_status`
  - `memory_stats`

- Capture-first write pipeline exists.
  - Live memory writes enter canonical capture first.
  - Projection queue dispatch is metadata-only.
  - Raw payloads are staged in encrypted R2.

- Hindsight is now a semantic projection, not the canonical front door.
  - Session 7.1 retired the direct compatibility writer.
  - Session 7.2 added semantic recall through the canonical interface.
  - Session 7.3 aligned reflection/consolidation with canonical status.

- Graphiti is designed and partially integrated as graph/temporal projection.
  - 8.1 chose external Graphiti first, Cloudflare Containers later.
  - 8.2 added Graphiti ingestion projection and identity mappings.
  - 8.3 added graph/timeline reads via the canonical surface.
  - Runtime remains configuration-gated by `GRAPHITI_API_URL`; unconfigured environments keep graph jobs queued rather than pretending failure.

- Multi-mode retrieval exists.
  - 9.1 added an explainable router for `raw`, `semantic`, `graph`, and `composed`.
  - It is heuristic, not AI-scored.
  - It returns consistent source attribution across modes.

- Chief-of-Staff context builder exists.
  - 9.2 added `prepare_context_for_agent`.
  - It supports `person`, `project`, `scope`, and `meeting_prep`.
  - It is read-only and returns structured evidence, gaps, confidence, sources, risks, open loops, and follow-up questions.

- External `brain-memory` surface exists.
  - 9.3 defined `brain-memory`, `brain-sources-read`, and `brain-actions`.
  - Only `brain-memory` is live.
  - 9.4 extended `capture_memory` for explicit, session-summary, and artifact-linked external-client capture.
  - The profile explicitly rejects full transcript capture as the default.

- Source-read and BYOC are mostly planned contracts, not fully implemented.
  - `brain-sources-read` is defined but not live.
  - BYOC artifact family is defined in 9.3: `operating-model.json`, `USER.md`, `SOUL.md`, `HEARTBEAT.md`, `schedule-recommendations.json`.
  - Full export/import execution appears future-facing.

- Action layer exists separately from memory.
  - HAETSAL has capability classes, approval queue, TOCTOU hashing, send delays, and audit.
  - This is a major difference from OB1 and GBrain: HAETSAL is designed to act, not only remember.

## The Deep Philosophical Split

### 1. What Is The Source Of Truth?

Second-Brain list:

- There is no single technical source of truth.
- The note, website, or garden is the thing.
- Human curation is central.

OB1:

- The database is the core.
- The basic unit is a "thought" row with content, embedding, metadata, and timestamps.
- Extensions add schemas and recipes, but the foundation is deliberately simple.

GBrain:

- The markdown/git brain repo is the source of truth.
- Postgres/PGLite is a derived cache for search, graph, embeddings, and runtime state.
- This makes backup, portability, editing, publishing, and multi-agent collaboration naturally git-shaped.

HAETSAL:

- The desired long-term source of truth is canonical capture in Postgres plus R2 artifacts.
- Current bridge implementation uses D1 for metadata and encrypted R2 for payloads.
- Hindsight and Graphiti are explicitly projections, not primary truth.
- This is architecturally cleaner than using Hindsight, Graphiti, or a vector database as the only "brain."

Evaluation:

- OB1 is easiest to understand.
- GBrain is easiest for humans and agents to audit as files.
- HAETSAL is best for multi-engine replayability and action safety.
- HAETSAL should not lose the target that canonical Postgres plus R2 is the durable foundation. The D1 bridge is fine as a phase, but should not become a fuzzy permanent truth layer by accident.

### 2. What Is The Unit Of Memory?

Second-Brain list:

- Pages, atomic notes, garden entries, essays, and links.
- Often human-authored and manually tended.

OB1:

- A thought: one retrievable idea, ideally concise.
- Longer content should be chunked, but the core setup starts with a simple `thoughts` table.
- Agent Memory adds operational records: decisions, outputs, lessons, constraints, open questions, failures, artifact references, work logs.

GBrain:

- A page is the primary unit.
- Chunks, facts, takes, links, timeline entries, aliases, graph edges, and extracted structures derive from pages.
- It likes entity pages: people, companies, projects, media, deals, emails, Slack, concepts, writing.

HAETSAL:

- A capture is the canonical event.
- Documents and chunks normalize the capture.
- Projection jobs feed Hindsight and Graphiti.
- Queries return canonical provenance rather than raw engine objects.

Evaluation:

- OB1's "one idea per thought" is excellent for first-time users and quick capture.
- GBrain's "entity page plus timeline plus citations" is excellent for meeting prep and company memory.
- HAETSAL's "capture event plus projections" is best for replay, provenance, and multi-engine evolution.
- Personal HAETSAL should expose a friendlier "thought/page/note" view on top of the canonical event model. Company HAETSAL should expose "entity/project/source" views on top.

### 3. Is The Brain A Garden, A Database, A Search Engine, Or An Agent Runtime?

Second-Brain list:

- Garden first.
- It cares about expressing, revisiting, and discovering thought.

OB1:

- Database first.
- It cares that any AI can access the same memory.

GBrain:

- Agent runtime plus compiled wiki.
- It cares about autonomous compounding: ingest, enrich, cite, link, query, dream.

HAETSAL:

- Cognitive operating system.
- It cares about memory, agents, crons, action safety, identity, encryption, projection engines, and external client surfaces.

Evaluation:

- For personal use, garden qualities matter more than HAETSAL currently emphasizes. A system can be correct and still feel alien if the human cannot browse and edit its self-understanding.
- For company use, database and governance qualities matter more than garden romance. A company brain must answer who can see this, who wrote it, what source backs it, and whether an agent is allowed to act on it.

## System-By-System Evaluation

## Second-Brain Repo

### What It Is

`KasperZutterman/Second-Brain` is a curated list of public zettelkastens, second brains, and digital gardens. It includes many personal sites and public knowledge bases. The repo has a README and license, not a product architecture.

### Core Lesson

The important lesson is not implementation. It is taste:

- Knowledge systems are personal.
- Browsability matters.
- Links matter.
- Public or semi-public articulation forces clarity.
- Notes are not only retrieval units; they are expressions of a mind.

### Strengths

- Excellent inspiration source for human-facing knowledge UX.
- Reminds us that "second brain" historically means more than vector search.
- Encourages evergreen notes, cross-linking, curation, and public/private gradients.
- Useful for studying how people make their knowledge legible to themselves and others.

### Weaknesses

- No canonical architecture.
- No agent interface.
- No permissions model.
- No ingestion pipeline.
- No audit, provenance, or action safety model.
- Not directly suitable for a company knowledge system.

### What HAETSAL Should Borrow

- A human-readable garden/export layer.
- Evergreen notes generated from canonical memory, not just raw retrieval results.
- A sense of place: people, projects, concepts, decisions, and essays should be browseable.
- Public/private/published shelves, especially for company knowledge where some pages are polished and some are internal evidence.

### What HAETSAL Should Not Borrow

- Manual-only maintenance.
- Treating public writing structure as the internal storage model.
- Lack of governance for company settings.

## OB1

### What It Is

OB1 is "open brain" as a practical, beginner-friendly foundation:

- Supabase/Postgres for storage.
- pgvector for search.
- OpenRouter as an AI gateway.
- Supabase Edge Functions exposing MCP.
- Simple tools: capture, search, list, stats, plus `search`/`fetch` compatibility.
- A large ecosystem of recipes, extensions, dashboards, schemas, and skills.

The core pitch is: any AI tool can use the same memory.

### Core Opinions

- Do not make a note app.
- Do not require Obsidian as the middleman.
- AI should talk directly to the database.
- Memory should be portable across Claude, ChatGPT, Cursor, Codex, and future clients.
- Tool surfaces should stay scoped and not become giant catalogs.
- Agent memory needs provenance, review, and use policy.

### Strengths

- Easiest of the real systems to set up and explain.
- Excellent onboarding and recipe ecosystem.
- Strong remote MCP posture.
- Good distinction between core brain, extensions, primitives, dashboards, integrations, and skills.
- Agent Memory sidecar schema is a major design contribution:
  - provenance status
  - use policy
  - review status
  - recall traces
  - source refs
  - artifact refs
  - audit events
- BYOC workflow is practical and portable:
  - extract context
  - interview into operating model
  - export stable artifacts

### Weaknesses

- The core brain is intentionally simple and may underperform on deep recall without extensions.
- A single `thoughts` table can become conceptually flat without source/type discipline.
- Service-role driven MCP can bypass RLS unless carefully reworked or explicitly filtered.
- "Obsidian does not coexist" is too strong for users who think and edit through files.
- It has less built-in synthesis, graph, consolidation, and engine separation than HAETSAL or GBrain.

### What HAETSAL Should Borrow

- The `brain-memory` naming and capability-boundary clarity. HAETSAL already did this in 9.3 and 9.4.
- BYOC artifact family as a first-class export/import surface.
- Agent-written memory as evidence by default, not instruction.
- Review queue semantics for memory promotion:
  - confirm
  - edit
  - evidence only
  - restrict scope
  - stale
  - reject
  - dispute
  - supersede
- Tool-surface discipline: few tools, scoped by workflow and risk.
- Beginner-friendly docs for "connect Codex/Claude/Cursor to your brain."

### What HAETSAL Should Not Borrow

- A flat universal `thoughts` substrate as the long-term core.
- Treating visual/editable note systems as irrelevant.
- Letting MCP connection simplicity outrank stronger tenant/key isolation.
- Over-relying on vector search as the first brain experience.

## GBrain

### What It Is

GBrain is a mature, production-grade agent brain:

- CLI and MCP server.
- PGLite for local personal brains; Postgres/Supabase for shared or larger brains.
- Markdown/git brain repo as system of record.
- Database as derived index/cache.
- Hybrid search with vector, BM25, reciprocal-rank fusion, graph signals, reranking, title/alias boosts, and explainability.
- Synthesis layer via `think`.
- Gap analysis and stale/contradiction awareness.
- Source and brain axes for multi-repo and multi-team organization.
- Company brain through sources, OAuth clients, and scoped reads/writes.
- Dream cycle, enrichment, skills, crons, and sub-agent patterns.

### Core Opinions

- Search gives pages; a brain gives answers.
- The graph is not optional; vector search alone misses relationships.
- Markdown remains the human-legible source of truth.
- The system should maintain itself through sync, extraction, enrichment, and dream cycles.
- Agents should consult the brain before external sources.
- Company brains need explicit source boundaries and per-user scopes.

### Strengths

- Most battle-tested retrieval philosophy of the group.
- Strong source attribution culture.
- Strong schema/type taxonomy.
- Strong graph argument and evaluation mindset.
- Strong git/source-of-record story.
- Strong company-brain model:
  - brains as databases
  - sources as repos inside a brain
  - mounts for team brains
  - OAuth scoping
  - federated source reads
- Strong operational disciplines:
  - brain-first lookup
  - sync after write
  - dream cycle
  - dedup
  - citation repair
  - contradiction detection

### Weaknesses

- More operationally heavy.
- Markdown/git as source of truth creates merge and privacy challenges.
- It is strongly shaped by people/company/deal/company-memory workflows.
- It can be overkill for simple personal capture.
- If not carefully scoped, automatic enrichment and cron-driven behavior can become noisy or expensive.
- Its git-based truth model may conflict with HAETSAL's stronger encrypted canonical event-store direction.

### What HAETSAL Should Borrow

- Brain/source axes.
  - Brain boundary means ownership/access boundary.
  - Source boundary means repo/domain/source grouping inside a brain.
- Schema pack or type-taxonomy discipline.
- Retrieval evaluations and diagnostics.
- Better named-thing retrieval:
  - title boosts
  - aliases
  - source-aware ranking
  - evidence tags
  - create-safety hints
- Source attribution standards.
- Dream-cycle maintenance:
  - stale facts
  - citation gaps
  - contradictions
  - graph link coverage
  - entity dedup
- Human-readable compiled pages for important entities.

### What HAETSAL Should Not Borrow Blindly

- Making git the canonical truth for all memory content.
- Treating every brain as a repo-first system.
- A giant operational surface if HAETSAL's core user experience is still forming.
- Convention-only access control for company/private boundaries.

## HAETSAL

### What It Is

HAETSAL is an open brain plus agent/action operating system:

- Cloudflare Worker is the sole public face.
- McpAgent Durable Object coordinates sessions and tools.
- Hindsight runs in Containers as semantic memory.
- Graphiti is the graph/temporal projection target.
- Canonical capture comes first.
- D1 holds operational metadata.
- R2 stores encrypted raw artifacts and projection payloads.
- Vectorize supports semantic index surfaces.
- Queues and Workflows handle async work.
- AI Gateway centralizes model routing.
- Action Worker handles risky external mutation through authorization gates.

### Core Opinions

- One public face.
- Tenant key isolation matters.
- Agents write facts; crons write patterns.
- Memory engines are projections, not canonical truth.
- Read mode should match query intent: raw, semantic, graph, composed.
- External clients should connect to scoped capability surfaces, starting with `brain-memory`.
- Source-read and source-write must not be bundled into memory by accident.

### Strengths

- Best separation of raw, semantic, graph, session, and action layers.
- Strongest security and action boundary.
- Strong projection model.
- Better prepared for replay, migration, and multi-engine evolution than OB1 or GBrain.
- Already has Hindsight semantic recall and Graphiti graph/timeline surfaces behind canonical tools.
- Already has CoS context bundles.
- Already has external MCP-native `brain-memory` rollout.

### Weaknesses / Risks

- Complexity is high.
- The long-term canonical Postgres foundation is not fully realized; the current bridge uses D1 plus encrypted R2.
- DLP is documented as a pass-through stub in the walkthrough.
- Source-read and BYOC are not yet as concrete as `brain-memory`.
- Graphiti runtime is external and config-gated.
- UX may lag architecture: memory browser, garden views, review queues, and user-facing explanation need to feel simple.
- Need to avoid "engine pluralism confusion" where Hindsight, Graphiti, canonical records, Vectorize, and session memory all feel like competing brains.

## Dimension-By-Dimension Comparison

| Dimension | Second-Brain list | OB1 | GBrain | HAETSAL |
| --- | --- | --- | --- | --- |
| Primary purpose | Inspiration/catalog | Portable AI memory foundation | Production agent brain | Personal AI OS and memory/action platform |
| Source of truth | Human pages/sites | Postgres thoughts | Markdown/git repo | Canonical capture plus encrypted artifacts; target Postgres/R2 |
| Human editability | Very high | Low to medium | High | Planned/output-surface dependent |
| AI access | Not inherent | MCP Edge Function | CLI/MCP | MCP via McpAgent/Worker |
| Retrieval | Site search/manual | Vector search | Hybrid plus graph plus reranker | Raw/semantic/graph/composed router |
| Synthesis | Human-written | Mostly client/extension-driven | Built-in `think` | Hindsight reflect plus CoS context builder |
| Graph | Human links | Extensions/schema-dependent | Core typed graph from links | Graphiti projection and query surface |
| Provenance | Varies | Metadata plus agent memory provenance | Inline citations/source refs | Canonical source attribution and audit |
| Company use | Not direct | Extensions/RLS/scoped MCP | Company brain with sources/OAuth | Capability scopes, tenant isolation, planned source-read |
| Agent memory governance | None | Strong sidecar review/use policy | Agent memory separated from GBrain | Procedural write law plus audit; review queue should be strengthened |
| Action safety | None | Mostly out of scope | Agent-dependent | Core action authorization layer |
| Portability | Web pages/files | High via database/MCP/BYOC | High via markdown/git/MCP | High by design; strongest if BYOC/export lands |
| Complexity | Low | Low to medium | High | Very high |

## Personal Knowledge System: Best Synthesis

The best personal system should not be only one of these. It should have four layers.

### 1. Capture Layer

Borrow from OB1 and HAETSAL:

- Fast capture from any client.
- Explicit capture, session-summary capture, and artifact-linked capture.
- Default to summaries and durable claims, not full transcript retention.
- Preserve source refs, client name, session id, artifact reference, and provenance.

HAETSAL already has most of this in 9.4.

### 2. Canonical Memory Layer

Use HAETSAL's model:

- Every write becomes a canonical capture.
- Raw artifacts live in encrypted R2.
- Structured metadata tracks operations and projection lifecycle.
- Hindsight and Graphiti are projections.
- No client writes directly to Hindsight or Graphiti.

Recommended improvement:

- Keep pushing toward the stated Postgres plus R2 canonical foundation so D1 remains operational/control-plane rather than the long-term memory ledger.

### 3. Recall And Context Layer

Use HAETSAL plus GBrain:

- Raw mode for exact provenance.
- Semantic mode for meaning and facts.
- Graph mode for relationships and timelines.
- Composed mode for prep.
- GBrain-style retrieval diagnostics, alias/title boosts, and source-aware scoring should inspire future HAETSAL retrieval improvements.

HAETSAL already has the mode router and CoS context builder. The next step is stronger evals and a friendlier user-facing explanation of "why this result came back."

### 4. Garden / Reflection Layer

Borrow from the Second-Brain list and GBrain:

- Generate human-readable evergreen notes from canonical memory.
- Let the user browse:
  - people
  - projects
  - decisions
  - concepts
  - open loops
  - daily/weekly/monthly reflections
- Keep Obsidian as capture/output, not a circular live mirror.
- Support `/from-brain/` generated artifacts and `/to-brain/` explicit ingestion, as HAETSAL already documents.

This layer matters because personal knowledge is not only something an AI retrieves. It is also something the human inhabits.

## Company Knowledge System: Best Synthesis

The company system needs a stricter shape.

### 1. One Company Brain, Many Scoped Surfaces

Use HAETSAL's 9.3 surface model:

- `brain-memory`: capture/query memory.
- `brain-sources-read`: read source systems and selectively capture.
- `brain-actions`: mutate external systems, delayed until governance is proven.

Use GBrain's brain/source axis:

- Brain boundary = ownership/access boundary.
- Source boundary = team, project, customer, function, or data source within the brain.

Recommended company source model:

- `personal/<user>`
- `team/<team>`
- `project/<project>`
- `customer/<account>`
- `company/shared`
- `company/restricted`
- `source/google/gmail`
- `source/google/calendar`
- `source/drive/docs`
- `agent/deliverables`

### 2. Evidence Is Not Instruction

Borrow OB1 Agent Memory very strongly here.

For a company, agent-generated memory should never silently become operating law. Every memory should know:

- provenance status
- confidence
- scope
- whether it can be used as evidence
- whether it can be used as instruction
- whether user confirmation is required
- review status

HAETSAL's Law 3 handles procedural memory structurally, but the company system also needs OB1-style review semantics for cross-team memories and agent-learned operating rules.

### 3. Selective Source Ingestion, Not Mirroring

All three serious systems agree, in different language, that naive full ingestion is dangerous.

For company use:

- Gmail: event-driven, thread-aware, selective capture.
- Calendar: events as context and behavioral evidence, not every calendar detail as durable memory.
- Drive/Docs: explicit folder/tag/frontmatter inclusion.
- Slack/Teams: scan for decisions, commitments, owner changes, high-signal threads; archive separately if needed.
- Historical import: bounded, lower-trust provenance class.

HAETSAL 9.3 already says this. The important thing is to keep it when implementing `brain-sources-read`.

### 4. Published Knowledge Views

Borrow from Second-Brain and GBrain:

- The company needs not only search, but compiled pages:
  - project briefs
  - customer/account pages
  - decision records
  - people/team maps
  - onboarding guides
  - operating principles
  - known risks
- Some pages should be generated and draft-like.
- Some should be human-reviewed and promoted.

This solves the "AI knows it but humans cannot inspect it" problem.

### 5. Audit And Action Separation

Keep HAETSAL's action layer separate:

- Memory read/write is not source mutation.
- Source read is not source mutation.
- Action proposals require capability class and approval.
- Financial/delete/irreversible actions need hard floors.
- TOCTOU hash checks and delay windows are exactly the right instincts.

This is one of HAETSAL's biggest advantages.

## What HAETSAL Should Do Next

### Highest Priority

1. Finish the human-facing mental model.
   - Explain in docs and UI: canonical capture, semantic projection, graph projection, working/session memory, action layer.
   - Make it clear there is one brain, not Hindsight plus Graphiti plus D1 plus R2 competing.

2. Add OB1-style memory review/use policy.
   - Especially for agent-authored operational memory.
   - Distinguish evidence from instruction.
   - Add review status and scope promotion.

3. Implement BYOC export/import for the 9.3 artifact family.
   - `operating-model.json`
   - `USER.md`
   - `SOUL.md`
   - `HEARTBEAT.md`
   - `schedule-recommendations.json`
   - Make these MCP-readable and file-exportable.

4. Build the garden/compiled-view layer.
   - Person/project/concept/decision pages.
   - Generated from canonical memory, linked to sources.
   - Human-reviewable.
   - Obsidian/Markdown export compatible.

5. Harden DLP.
   - The docs say DLP is currently pass-through.
   - Before broader company/source ingestion, this should become real enough to block obvious secrets, prompt-injection payloads, and unsafe cross-boundary content.

### Medium Priority

6. Implement `brain-sources-read`.
   - Start with Google read-only ingestion.
   - Keep selective capture and provenance classes.
   - Do not mix it with `brain-actions`.

7. Add source/brain scoping inspired by GBrain.
   - Sources should be first-class in HAETSAL's canonical model.
   - Access decisions should be source-aware.
   - Search should be source-aware.

8. Add retrieval evals.
   - GBrain's biggest advantage is not just retrieval machinery; it is caring about retrieval quality.
   - Capture real HAETSAL queries and expected results.
   - Test raw/semantic/graph/composed routing.
   - Track precision/recall-ish metrics where possible.

9. Add source attribution standards.
   - Every durable claim should be able to answer: who said it, where, when, in what source, and whether it is inferred or observed.

10. Clarify canonical Postgres migration.
   - If HAETSAL still wants Postgres plus R2 as long-term canonical substrate, define the migration from D1 bridge to Postgres explicitly.

### Later

11. Consider self-hosting Graphiti in Cloudflare Containers.
   - Only after the external runtime contract is proven.

12. Add public/private publishing workflows.
   - Personal garden.
   - Company wiki.
   - Reviewed vs unreviewed compiled pages.

13. Add company OAuth/scoped remote MCP posture.
   - Current Access gating is fine for private use.
   - Company usage needs clearer external-client OAuth/scopes over time.

## What Not To Copy

Do not copy these patterns:

- Full transcript capture as default.
- Direct client writes to Hindsight or Graphiti.
- One giant MCP server with every possible tool.
- Flat vector memory as the whole product.
- Convention-only privacy for company boundaries.
- Git as the only source of truth for sensitive encrypted memory.
- Generated agent conclusions becoming invisible future instructions.
- Obsidian as a live bidirectional mirror of generated brain output.
- Cross-engine answers with no source attribution.

## Recommended Architecture In One Sentence

HAETSAL should be: a canonical, encrypted, capture-first brain with replayable projections into semantic and graph engines, a small scoped MCP surface for external clients, a governed review path for agent memory, human-readable compiled/garden views for inspection, and a separate action layer with hard authorization gates.

## Practical Product Shape

For personal use:

- First screen: "What should I know today?"
- Core actions:
  - capture
  - search
  - prepare context
  - review new memories
  - inspect sources
  - export operating model
- Weekly experience:
  - what changed
  - what is stale
  - what is contradictory
  - what is missing
  - what should become an evergreen note

For company use:

- First screen: "What does the company know, and what can I see?"
- Core actions:
  - search scoped sources
  - prepare person/project/customer context
  - capture decision
  - review agent-written memory
  - inspect provenance
  - request source ingestion
  - approve/reject action proposals
- Weekly experience:
  - decisions made
  - stale project/customer facts
  - contradictions across sources
  - source coverage gaps
  - team-specific open loops

## Bottom Line

If choosing one system as the north star:

- Use OB1 for onboarding, portability, and agent-memory governance.
- Use GBrain for retrieval rigor, source attribution, graph-aware compiled knowledge, and company-brain source scoping.
- Use the Second-Brain list for human-facing garden sensibility.
- Use HAETSAL as the actual architecture foundation, because it already has the cleanest separation between canonical truth, semantic projection, graph projection, session context, external client surface, and action authority.

The best HAETSAL synthesis is not "be more like OB1" or "be more like GBrain." It is: keep HAETSAL's stronger architecture, but make it feel as simple as OB1, as retrievable and cited as GBrain, and as humanly browseable as a great digital garden.

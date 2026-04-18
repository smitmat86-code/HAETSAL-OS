# Advanced Open Brain Implementation Plan

Date: 2026-04-18
Status: Planning approved pending execution
Related architecture: `docs/advanced-open-brain-architecture.md`

## Purpose

Translate the advanced open-brain architecture into a practical build and
migration sequence.

This plan assumes:

- the current HAETSAL system remains operational
- the current Hindsight-based brain is not thrown away
- the new canonical open-brain foundation is introduced deliberately
- migration happens in phases, not via a big-bang rewrite

## Executive Answer

### Can the full plan be written now?

Yes.

### Can every implementation-ready spec be written now?

Partially, but that is not the best approach.

The right approach is:

- write the full multi-phase implementation plan now
- write the first execution-ready spec now
- write later execution-ready specs after each foundation phase lands, because
  several lower-level choices should be informed by what we learn in earlier
  phases

### Should we start a new build session before the plan is written?

No.

The right time to start the new build lane is after:

1. the architecture target is written
2. the migration/build plan is written
3. the first implementation spec is written
4. the first execution session has a clear stop point

## Strategic Stance

We are not replacing HAETSAL's current brain with a new system all at once.

We are building a new canonical memory foundation beneath and around it, then
moving the current brain into the correct role inside that foundation.

That means:

- current HAETSAL is the operating system shell we reuse
- current Hindsight integration becomes the first advanced memory projection
- Graphiti is added later as the temporal relationship projection
- canonical open-brain storage becomes the source of truth over time

## What Gets Reused From Current HAETSAL

### Reuse directly

- Cloudflare Worker / Hono public surface
- McpAgent-first product posture
- Cloudflare Access auth model
- AI Gateway setup
- Hindsight container runtime knowledge
- Hindsight operation tracking patterns
- Queues / Workflows orchestration patterns
- R2 artifact handling patterns
- existing action/browser execution shell

### Reuse with refactor

- current ingestion pipeline
- current memory tool surface
- current D1 audit / ops logic
- current Hindsight service layer

### Do not treat as canonical long-term

- current memory data boundaries
- current assumption that Hindsight is effectively the whole advanced memory
  substrate
- current coupling between product memory and current implementation layout

## What Must Exist Before Migration Starts

The following must be decided before implementation begins:

1. canonical source-of-truth rules
2. canonical schema families
3. memory write fan-out contract
4. migration posture from current HAETSAL to canonical capture-first writes
5. initial boundary between Postgres, R2, D1, Hindsight, and Graphiti

These are now captured in `docs/advanced-open-brain-architecture.md`.

## Recommended Build Sequence

## Phase 6 - Open Brain Re-foundation

This phase runs alongside the current production system. It does not replace it
immediately.

### Session 6.1 - Canonical Open Brain Foundation

Goal:

- introduce canonical source-of-truth schema
- define canonical capture/event model
- create the projection/fan-out contract

Outputs:

- Postgres schema for canonical captures/documents/chunks/operations/projections
- R2 artifact shelf shape
- service interfaces for canonical capture and readback
- migration strategy from current writes into canonical capture-first flow

### Session 6.2 - Canonical MCP Memory Surface

Goal:

- define the stable open-brain MCP contract independent of any one memory engine

Outputs:

- `capture_memory`
- `search_memory`
- `get_recent_memories`
- `get_document`
- `memory_status`
- `memory_stats`

Initial implementation may still proxy to current systems while canonical data
is being introduced.

### Session 6.3 - Canonical Capture Pipeline

Goal:

- make every write enter the canonical event pipeline first

Outputs:

- capture persistence
- artifact/document/chunk normalization
- projection job creation
- queue fan-out entrypoint

This is the first point where live traffic may begin writing into the new
foundation.

## Phase 7 - Hindsight As Semantic Projection

### Session 7.1 - Hindsight Projection Adapter

Goal:

- connect canonical capture pipeline to Hindsight as a semantic projection

Outputs:

- Hindsight projection job worker
- mapping between canonical records and Hindsight bank/doc/object references
- canonical operation reconciliation

### Session 7.2 - Semantic Recall Through Canonical Interface

Goal:

- expose Hindsight recall through the canonical MCP contract rather than as a
  direct engine-specific product concept

Outputs:

- semantic mode reads
- source/provenance linkback
- canonical memory status integration

### Session 7.3 - Reflection / Consolidation Alignment

Goal:

- align current Hindsight reflect/consolidation with the canonical open-brain
  architecture

Outputs:

- reflection scheduling and outputs attached to canonical records
- semantic projection observability tied back to the canonical operation model

## Phase 8 - Graphiti As Graph / Temporal Projection

### Session 8.1 - Graphiti Projection Design

Goal:

- finalize Graphiti deployment posture and canonical graph projection contract

Outputs:

- deployment choice
- projection mapping model
- episode/entity/edge reconciliation rules

### Session 8.2 - Graphiti Ingestion Projection

Goal:

- fan out canonical capture events into Graphiti

Outputs:

- Graphiti projection worker
- canonical-to-graph identity mapping
- graph operation lifecycle tracking

### Session 8.3 - Graph / Timeline Query Surface

Goal:

- expose relationship and time-aware memory reads through the canonical MCP
  surface

Outputs:

- `trace_relationship`
- `get_entity_timeline`
- graph-backed composed retrieval

## Phase 9 - Composed Brain Reads

### Session 9.1 - Multi-Mode Memory Router

Goal:

- choose raw, semantic, graph, or composed retrieval mode based on query intent

Outputs:

- retrieval router
- query typing
- consistent source attribution

### Session 9.2 - Chief-of-Staff Context Builder

Goal:

- prepare high-value context bundles for first-party agents using canonical
  + semantic + graph layers

Outputs:

- `prepare_context_for_agent`
- scope summaries
- person/project context assembly

## Phase 10 - Native HAETSAL Agents On Top

### Session 10.1 - First Agent On Open Brain

Goal:

- move one first-party HAETSAL agent to the new open-brain foundation

Recommended first agent:

- chief-of-staff

Outputs:

- open-brain-backed context flow
- proof that the architecture supports first-party agents cleanly

### Session 10.2+ - Additional Domain Agents

- research
- planning
- action support
- other personal operating-system agents

## Phase 11 - Session / Working Memory Optimization

Only after the canonical and projection layers are stable.

### Session 11.1 - Agent-Local Working Memory

Goal:

- add Cloudflare-native session memory as a local optimization, not a canonical
  substrate

Outputs:

- session memory blocks
- working summaries
- local compaction/caching

## Migration Strategy

### Stage A - Parallel Foundation

Build canonical storage and projection contracts without disturbing the current
live brain behavior.

### Stage B - Shadow Writes

Write new captures to the canonical foundation while preserving current
production behavior.

### Stage C - Projection Rewiring

Move Hindsight writes behind the canonical pipeline.

### Stage D - Graph Projection Introduction

Add Graphiti as a projection target fed from the same canonical capture events.

### Stage E - Canonical Read Dominance

Make the canonical MCP surface the definitive memory interface, with raw,
semantic, graph, and composed read modes.

## When To Start A New Session

The new build lane should start after the following are complete:

- architecture blueprint written
- implementation plan written
- first active spec written

That point is the right time to start a fresh build session, because the first
execution session will have:

- a clear scope
- a clear stop point
- no ambiguity about source-of-truth direction

## What Not To Do

- Do not start by adding Graphiti directly to the current memory path.
- Do not start by replacing Hindsight.
- Do not start by rewriting all memory tools at once.
- Do not let Postgres, Hindsight, Graphiti, and session memory all become
  competing "primary" stores.
- Do not start a migration session before the first canonical foundation spec is
  written and approved.

## Immediate Next Step

Write and review the first execution-ready spec:

- `Session 6.1 - Canonical Open Brain Foundation`

That spec should be the first implementation session in the new lane.

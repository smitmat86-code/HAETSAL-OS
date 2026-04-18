# Hindsight Ops Runbook

This runbook documents HAETSAL's production Hindsight lifecycle model after the 2026 repair.

## Current Topology

- Hindsight runtime: API-only container
- Hindsight background processing: dedicated `hindsight-worker` service instances
- Database: direct Neon Postgres URL from the container runtime
- Interactive retains: direct Hindsight async retain from MCP tools
- Completion tracking:
  - immediate best-effort reconciliation after direct async writes
  - minute-level HAETSAL polling fallback via cron
- Operator state: `hindsight_operations` in D1 is the source of truth for retain lifecycle

## Lifecycle States

HAETSAL now distinguishes these milestones:

- `memory.retain_requested`
  The user/tool write was accepted by HAETSAL.
- `retain_queued`
  Hindsight accepted the async retain and returned an operation id.
- `memory.retain_available`
  The source document became visible through the Hindsight document surface before the formal operation closed.
- `memory.retain_completed`
  Hindsight operation status moved to `completed`.
- `memory.retain_failed`
  Hindsight operation status moved to `failed`.
- `memory.retain_delayed`
  A retain stayed pending longer than the slow threshold.
- `memory.retain_stuck`
  A retain stayed pending longer than the stuck threshold.

## Aging Thresholds

Pending retains are classified by age:

- delayed: older than 2 minutes
- stuck: older than 10 minutes

These markers are stored on `hindsight_operations` as:

- `slow_at`
- `stuck_at`

## Primary Diagnostics

Tenant-scoped summary API:

- `GET /api/audit/memory`

Response shape:

- summary counts
  - pending
  - available pending
  - delayed
  - stuck
  - completed
  - failed
- latest bank id
- last requested/completed/failed timestamps
- webhook health snapshot
- recent operations with derived queue state

Derived queue states:

- `pending`
- `available`
- `delayed`
- `stuck`
- `completed`
- `failed`

## Database Queries

Recent operation state:

```sql
SELECT operation_id, status, available_at, slow_at, stuck_at, completed_at, updated_at, source_document_id
FROM hindsight_operations
ORDER BY requested_at DESC
LIMIT 20;
```

Pending operations only:

```sql
SELECT operation_id, requested_at, slow_at, stuck_at, status, updated_at
FROM hindsight_operations
WHERE status = 'pending'
ORDER BY requested_at ASC;
```

Recent memory audit events:

```sql
SELECT operation, memory_id, created_at
FROM memory_audit
ORDER BY created_at DESC
LIMIT 20;
```

## Healthy Steady State

A healthy system should show:

- recent `memory.retain_requested`
- matching `retain_queued`
- later `memory.retain_completed`
- few or no rows in `status = 'pending'`
- `slow_at` and `stuck_at` usually null

Dedicated-worker deployments should also show:

- new writes becoming recallable without relying on the API's internal worker
- recent operations moving from `pending` to `completed`
- no long-lived growth in `pending` rows

Legacy rollout-era rows can temporarily remain `pending` even after the new
topology is healthy. If fresh writes are completing and only an older row is
stuck, treat it as migration residue first, not as proof that the current
topology is failing.

## Container Health Caveat

Cloudflare's container application health counters are useful, but they are not the final source of truth for this Hindsight topology.

In HAETSAL's dedicated-worker rollout, we observed periods where:

- Hindsight operations completed successfully
- delayed recall worked
- `hindsight_operations` advanced to `completed`
- but the Cloudflare worker container application still reported `healthy: 0`

Treat this as an observability discrepancy to investigate, not automatic proof that the Hindsight worker topology is broken.

For production truth, prioritize:

1. Hindsight operation status
2. recallability of fresh fact-style retains
3. D1 lifecycle state in `hindsight_operations`
4. Cloudflare container app health counters

## If Retains Stay Pending

1. Check whether the Hindsight container is healthy and serving recall.
2. For dedicated-worker topology, confirm fresh retains are still becoming recallable.
3. Inspect the worker app with `wrangler containers info <worker-application-id>` and `wrangler containers instances <worker-application-id>`.
4. Inspect `hindsight_operations` for `slow_at` / `stuck_at`.
5. Compare `available_at` vs `completed_at`.
6. If `available_at` is populated but `completed_at` is not, treat it as an ops anomaly rather than lost memory.
7. If neither `available_at` nor `completed_at` move, inspect the Hindsight container runtime and model/provider configuration.
8. If fresh writes are completing but one older row remains pending, document it as a legacy stuck operation and resolve it deliberately rather than broad-brush rolling back the topology.

## Important Current Note

The separate HAETSAL ingestion queue consumer has been repaired and is covered by focused tests, but the production MCP memory edge still remains on the direct Hindsight async retain path by design. This matches Hindsight guidance more closely by avoiding an extra app-level queue in front of Hindsight's own async worker/operations model for interactive writes.

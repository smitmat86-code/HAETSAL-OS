# Fold Hindsight Handoff

This is the condensed handoff from HAETSAL's Hindsight repair to the Fold workstream.

## What Held Up In Production

- Use the official bank-scoped Hindsight API only:
  - `POST /v1/default/banks/{bank_id}/memories`
  - `POST /v1/default/banks/{bank_id}/memories/recall`
  - `POST /v1/default/banks/{bank_id}/reflect`
- Use plaintext content for Hindsight ingestion. Keep encryption for your own
  archives and traces, not for Hindsight payloads.
- Use the API-only image for the hot path:
  - `ghcr.io/vectorize-io/hindsight-api:0.5.2`
- Use direct Neon from the container runtime.
- For interactive writes, prefer Hindsight's native `async=true` retain plus
  operation tracking over putting another app-level queue in front of every write.

## What Actually Mattered On Cloudflare

- Cloudflare Containers were fine for the Hindsight API, but cold starts needed:
  - `startAndWaitForPorts`
  - API port `8888`
  - worker port `8889`
  - `standard-2` sizing
- Dedicated Hindsight workers should be their own Hindsight worker processes,
  not just HAETSAL/Fold queue consumers.
- Let the worker container class own the `hindsight-worker` entrypoint. Relying
  on per-call start options alone was less stable.
- Fresh container identities helped flush wedged shared instances during rollout.

## Product Semantics To Keep

- Writes should return `queued`, not pretend they are immediately searchable.
- Recall is semantic and fact-based, not exact raw-text retrieval.
- The right acceptance test is:
  1. retain a fact-style memory
  2. observe `queued`
  3. confirm the Hindsight operation completes
  4. confirm delayed recall returns the fact

## Ops Lessons

- Track every async retain in your own operations table.
- Persist:
  - operation id
  - tenant/bank id
  - source document id
  - requested/completed/available timestamps
  - failure detail
- Poll Hindsight operations as the baseline truth source.
- `available_at` can appear before formal completion; do not treat that as lost
  memory, but do surface it in ops.
- Cloudflare container app health counters were informative, but not sufficient
  alone. We trusted:
  1. Hindsight operation status
  2. delayed recall of fresh fact-style writes
  3. local lifecycle state in D1
  4. container health counters

## Recommendation For Fold

- Keep:
  - API-only Hindsight
  - direct Neon
  - async retain
  - dedicated Hindsight workers if you want to build for multi-user scale now
- Add if missing:
  - first-class operations tracking
  - truthful queued/completed/failed audit states
  - a short operator runbook for stuck retains

The big takeaway is that the stable production shape was not "make Hindsight synchronous."
It was "embrace Hindsight's async model, then make the lifecycle observable and truthful."

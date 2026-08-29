# Governed artifact intake — operator runbook

Use this runbook for managed Codex/Claude/ChatGPT files and Telegram/Sendblue
media. All inspection must remain content-free: IDs, counts, state, hashes,
lengths, key families, and timestamps only. Never print filenames, captions,
temporary URLs, extraction bodies, ciphertext, plaintext, or key material.

## Health and lifecycle

`GET /api/dream/canary/latest` is healthy at 7/7. The `artifact` probe reserves,
seals, finalizes, proves the exact R2 ciphertext, reads the canonical manifest,
searches a synthetic marker, checks tenant isolation, and reaps an expired
reservation. Its fixed failure codes identify `upload`, `seal`, `finalize`,
`r2`, `manifest`, `query`, `isolation`, or `cleanup`.

D1 `artifact_intake_events` is the content-free lifecycle ledger. Aggregate by
`event_type`; do not join it to content-bearing stores. Expected transitions
are `reserved → sealed → finalized`, or `reserved/sealed/failed → expired` plus
`reaped`. A `failed` row may be retried until expiry.

## Stuck upload or finalization

1. Read the operation and finalization rows by exact tenant/upload ID.
2. Check admission state, expiry, lease owner/expiry, claim token, protocol,
   adopted attempt token, and fixed error code.
3. If a live lease exists, wait for its bounded recovery path; do not steal it.
4. Run the normal status/finalize retry. Idempotency must return the same IDs.
5. For stale finalization, run the scheduled reaper path. It proves canonical
   success before repairing D1 and never deletes a possibly canonical body.
6. If proof is indeterminate, preserve state and retry after the dependency
   recovers. Integrity mismatch is an incident, not a cleanup opportunity.

## Expired operations and orphan attempts

The 15-minute scheduler runs a bounded reaper. It claims an expired operation,
re-reads the authoritative row, proves the exact derived R2 key/hash/length,
deletes only that object, and CAS-transitions the row to `expired`. Attempt-key
journal rows are durable tombstones: absence once is not proof that a delayed
Worker put cannot still land. Retire them only after the documented repeated
absence protocol or a separately verified prefix-scoped R2 lifecycle rule.

Never delete by prefix, filename, age alone, or a pre-claim snapshot. For a
suspected orphan, prove that no D1 operation, finalization, canonical artifact,
document, or derivative references the exact key before any deletion.

## Legacy channel objects

Run `scripts/artifact-intake-legacy-inventory.ts` in dry-run mode. Reconcile
inventory count to migrated + skipped + failed. Referenced plaintext objects
require explicit category/digest approval: seal to the canonical key, decrypt
and hash-verify, transactionally update Neon, re-read the pointer, then delete
the exact legacy key. Handle proven unreferenced objects as a separate approval
category. See `artifact-intake-session5-remediation-approval.md`.

## Key-family failures

`TMK1` is interactive and `KEK1` is scheduled/channel work. They are not
interchangeable. A missing/expired Cron KEK defers safely; authenticate to renew
it, then retry. A wrong-family or authentication failure is an integrity signal:
do not rewrite family tags, decrypt with another key, or fall back to plaintext.

## Rollout and rollback

Follow `artifact-upload-ownership-rollout.md`. During rollback: close upload
admission, atomically deploy the recorded protocol-aware compatibility version,
then reopen and prove a reserve/upload/status round trip. Migrations are
additive and stay applied. Never roll back to code that cannot honor fenced-v2
attempt keys or immutable-finalization triggers. Already finalized artifacts
must remain readable and must not be rewritten.

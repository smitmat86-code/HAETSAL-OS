# Artifact upload ownership rollout (migrations 1033/1035/1036, fenced_v2)

Status: NOT executed. Production remains on Worker version
`bc5b4e08-6344-4df7-b7ae-a451371486a2` (old Worker, 1e4d3a6 behavior).
Migrations 1033, 1034, 1035, and 1036 are pending and were not applied
remotely.

## The actual safety guarantee (no request-lifetime assumption)

Cloudflare documents no hard wall-time limit for HTTP-triggered Workers while
the client stays connected, so NO deployment timestamp, version-analytics
reading, or fixed wait proves an old request is dead. This rollout therefore
does not depend on request death at all. Safety rests on four mechanisms:

1. **Plaintext-verified sealed-identity convergence**
   (`src/services/artifact-intake/sealed-convergence.ts`). Every writer — old
   and new — proves the row's exact plaintext hash before writing, so any
   genuine object at an operation's one legitimate key decrypts to the same
   plaintext. When a sealed row's recorded ciphertext identity authoritatively
   disagrees with the object at that key (an old writer's put and its
   unconditional D1 seal interleaved with a new writer on the shared legacy
   key — in either order), the new Worker re-reads the bounded object, proves
   the plaintext identity, and CAS-repairs D1 onto the object's actual
   ciphertext identity. A split can therefore exist only transiently between
   proofs; it can never finalize (finalization re-proves the exact ciphertext
   before and after canonical write), can never converge onto wrong content,
   and resolves even if an old request resumes arbitrarily later. Fenced rows
   are covered too: their adopted attempt object is immutable, so a clobbered
   D1 hash is restored from the true object.
2. **Fenced attempt keys** (migration 1033): activation-phase reserves record
   `upload_protocol = 'fenced_v2'`; each attempt writes its own immutable key
   and exactly one attempt is CAS-adopted. New writers never share a mutable
   key with each other.
3. **Finalized monotonicity**: the old Worker's mutations are guarded by
   `status != 'finalized'`, so finalized rows are immune to it forever.
4. **Operator upload-admission gate** (migration 1036,
   `src/services/artifact-intake/upload-admission.ts`): a content-free D1 row
   the protocol-aware Worker checks before EVERY reserve/upload mutation.
   `closed` refuses with the retryable `upload_admission_closed` error; an
   unreadable gate FAILS CLOSED. The gate bounds new-writer mutations during
   the cutover boundary as defense in depth; the shipped old Worker cannot
   read it, which is exactly why mechanism 1 — not the gate — carries the
   old-writer guarantee.

Deterministic proof: `tests/12.20-artifact-shared-key-split-convergence.test.ts`
separates each writer's R2 put from its D1 mutation and replays the exact
split-producing interleaving (old put → compat put → old D1 seal → compat
adoption loss), its reverse, and a fenced-row clobber; all converge with zero
D1/R2 disagreement. `tests/12.17-artifact-mixed-version-rollout.test.ts`
still proves the serial orderings and protocol dispatch;
`tests/12.23-artifact-upload-admission.test.ts` proves the gate refuses,
fails closed, and reopens.

## Executable sequence (expand → compat → gate → activate → reopen → enforce)

1. **EXPAND** — apply pending migrations (safe under the old Worker: nullable
   columns, a content-free journal table, and a gate table it never reads):

   ```
   npx wrangler d1 migrations apply brain-us --remote
   ```

2. **COMPATIBILITY deploy (atomic, not gradual)** — deploy this codebase with
   `ARTIFACT_UPLOAD_PROTOCOL_PHASE = "compat"` (the committed wrangler.toml
   value) as a normal 100% deploy. Do NOT use gradual percentage deployment
   for this cutover: gradual routing keeps *starting* new old-version
   requests, while an atomic deploy bounds old activity to requests already
   in flight — whose interleavings convergence resolves. Verify:
   `npx wrangler deployments status` shows the new version at 100%.

3. **CLOSE the admission gate** — operator D1 write:

   ```
   npx wrangler d1 execute brain-us --remote --command \
     "INSERT INTO artifact_intake_admission (id, state, updated_at) VALUES (1, 'closed', <now_ms>) \
      ON CONFLICT (id) DO UPDATE SET state = 'closed', updated_at = <now_ms>"
   ```

   All new upload mutations now refuse with `upload_admission_closed`
   (retryable; channel-media jobs are delayed and retried by their queue
   protocol, and interactive clients simply retry after reopening).

4. **QUIESCENCE check (read-only, evidence-based)** — confirm no new-writer
   mutation is pending admission side effects:

   ```
   SELECT COUNT(*) FROM artifact_intake_operations
    WHERE upload_protocol IS NULL AND status IN ('reserved', 'failed')
      AND expires_at > <now_ms>;
   ```

   This is an observability signal, not the safety proof: a resumed old
   request can still act later and is handled by convergence. If the count
   does not reach zero, investigate; do not proceed on elapsed time alone.

5. **ACTIVATE** — atomic redeploy with
   `ARTIFACT_UPLOAD_PROTOCOL_PHASE = "active"`. Both builds dispatch the
   upload path on the row's recorded `upload_protocol`, never on their own
   phase; only activation-phase reserves create `fenced_v2` rows. Because the
   gate is closed, no new-writer mutation occurs anywhere in this boundary.

6. **REOPEN the gate** — operator D1 write setting `state = 'open'` (or
   deleting the row). Verify a reserve/upload round-trip succeeds and records
   `upload_protocol = 'fenced_v2'` with an adopted attempt key.

7. **ENFORCE (later audit)** — after every legacy row is terminal, audit that
   newly sealed rows carry `adopted_attempt_token`. Legacy sealed rows keep
   `adopted_attempt_token NULL` and continue to prove against the legacy key.

**Rollback** at any step: set the gate `closed`, atomically redeploy the
previous compat build (or the old build before step 5), then reopen. Fenced
rows already adopted remain valid under any protocol-aware build; migrations
are expand-only and never need reverting. Existing uploads, sealed objects,
and canonical captures are never mutated by the rollout itself.

## Orphan attempt retention and cleanup (tombstone protocol)

Fenced attempts write unique immutable keys, so losing/stale attempts leave
encrypted orphan objects. Because a Worker's pending R2 put may land
arbitrarily late, the journal row (migration 1035) is a durable TOMBSTONE,
not a one-shot record. Governance (`attempt-orphans.ts`, `attempt-sweep.ts`):

- **Journal before put.** A content-free row (tenant, upload, attempt token,
  timestamps, sweep counters only) is inserted before every fenced R2 put.
- **Immediate cleanup** after a definitive adoption loss deletes only the
  writer's own attempt key, and only when authoritative D1 state proves the
  attempt was decided against; uncertainty never deletes.
- **Crash-safe bounded sweeper** (`sweepAbandonedArtifactUploadAttempts`,
  invoked from `reapExpiredArtifactUploads`): after the attempt lease plus
  the 15-minute grace pacing window, each journal row is re-checked by exact
  derived key with zero body reads. An adopted attempt's object is never
  deleted (its journal row alone is retired). A still-live claim defers. An
  observed object is deleted and the row marked `resolved_at`; the row is
  retired only when a LATER sweep re-confirms absence after that confirmed
  deletion (one attempt token performs at most one logical put). If no
  object has ever been observed, the row is stamped (`swept_at`,
  `sweep_count`) and RETAINED — absence during one check is never proof the
  put is dead, so a late put is always found and deleted by a later sweep.
- **Retention policy.** Unresolved tombstones are content-free, tiny, and
  bounded by attempt volume; they are retained indefinitely and re-checked in
  bounded batches (oldest-swept first, so no row starves). They may be bulk
  retired only after an R2 lifecycle rule scoped to the attempt-key prefix is
  provisioned and verified — a separate, explicitly gated operator action not
  performed by this codebase.

Proof: `tests/12.18-artifact-attempt-orphan-cleanup.test.ts` and
`tests/12.21-artifact-late-put-orphan-tombstone.test.ts` (late put after an
absent-object sweep, process death after the late put, adopted preservation,
D1 ambiguity retention, bounded work, idempotent repeats, content-free rows).

## Production scheduling

`handleBrainScheduled` (`src/workers/mcpagent/runtime.ts`) runs
`reapExpiredArtifactUploads` every 15 minutes in the existing `*/15` cron
slot via `ctx.waitUntil`, isolated with its own catch so it can neither block
nor fail the canary, channel-media reaper, or Obsidian poll sharing the slot.
Batch size is bounded (default 100 operations / 50 journal rows) and the
reaper deletes only from the authoritative post-claim row re-read under its
expiry-claim token. Observability is aggregate counts only. Proof:
`tests/12.22-artifact-reaper-scheduling.test.ts`.

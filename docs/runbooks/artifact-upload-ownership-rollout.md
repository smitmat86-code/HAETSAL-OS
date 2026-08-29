# Artifact upload ownership rollout (migrations 1033–1038, fenced_v2)

Status: SHIPPED and verified on 2026-08-29. Production is on Worker version
`112facd4-4903-464e-986a-7cfe4af2635a` at 100% with
`ARTIFACT_UPLOAD_PROTOCOL_PHASE = "active"`. Migrations 1033–1038 are applied,
the upload-admission gate is open, and the built-in canary is healthy at 7/7.

The approved `immutable_managed_finalized_v1` repair completed all nine targets
under digest `fd8a286120fdec799bea0dfb622f6a4ff84a7fecb62974a1212ee64cc7425314`.
All nine original R2 ciphertext objects were re-read and matched their exact
recorded length and SHA-256 after promotion. The first active-phase canary then
created a tenth managed artifact; all ten finalized managed rows have valid
`fenced_v2` attempt identities.

## The actual safety guarantee (no request-lifetime assumption)

Cloudflare documents no hard wall-time limit for HTTP-triggered Workers while
the client stays connected, so NO deployment timestamp, version-analytics
reading, or fixed wait proves an old request is dead. This rollout therefore
does not depend on request death at all. Safety rests on four mechanisms:

1. **Plaintext-verified convergence and immutable finalization**
   (`src/services/artifact-intake/sealed-convergence.ts`). Every writer — old
   and new — proves the row's exact plaintext hash before writing, so any
   genuine object at an operation's one legitimate key decrypts to the same
   plaintext. When a sealed row's recorded ciphertext identity authoritatively
   disagrees with the object at that key (an old writer's put and its
   unconditional D1 seal interleaved with a new writer on the shared legacy
   key — in either order), the new Worker re-reads the bounded object, proves
   the plaintext identity, and CAS-repairs D1 onto the object's actual
   ciphertext identity. Before canonical write, every legacy envelope is
   plaintext-proved, copied to a unique attempt key, and atomically adopted.
   The terminal D1 update then CAS-checks the exact key, adopted token, hash,
   length, and family. A late old D1 seal makes finalization retry, while a
   late old R2 put can touch only the retired legacy key. No finalized
   canonical artifact remains on a shared mutable key.
2. **Fenced attempt keys** (migration 1033): activation-phase reserves record
   `upload_protocol = 'fenced_v2'`; each attempt writes its own immutable key
   and exactly one attempt is CAS-adopted. New writers never share a mutable
   key with each other.
3. **Finalized monotonicity and immutable raw identity**: the old Worker's D1
   mutation is guarded by `status != 'finalized'`, and its unbounded R2 put
   knows only the retired legacy key.
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
   adoption loss), its reverse, a fenced-row clobber, immutable promotion, a
   post-finalization old put, and a post-proof D1 seal; all converge or retry
   with zero finalized disagreement. `tests/12.17-artifact-mixed-version-rollout.test.ts`
still proves the serial orderings and protocol dispatch;
`tests/12.23-artifact-upload-admission.test.ts` proves the gate refuses,
fails closed, and reopens.

## Executable sequence (audit → quarantine → compat → gate → promote → activate → reopen)

1. **PREFLIGHT** — before migration 1033 exists, do not query
   `adopted_attempt_token`. Inventory existing managed operations using only
   the deployed schema. Stop for any bound non-finalized row or any finalized
   row missing finalization ID, ciphertext hash/length, encryption family, or
   canonical capture/document/operation IDs. Well-formed finalized rows are
   exact repair candidates, not an automatic migration abort. For the first
   production rollout, the separately approved inventory is exactly:

   - category: `immutable_managed_finalized_v1`
   - targets: `9`
   - digest: `fd8a286120fdec799bea0dfb622f6a4ff84a7fecb62974a1212ee64cc7425314`

   Any count, identity, or digest change invalidates that approval and requires
   a new explicit approval. This read is operator visibility, not the
   race-free gate.

2. **EXPAND + ENFORCE** — apply pending migrations. Migration 1037 atomically
   snapshots every well-formed finalized legacy row into
   `artifact_immutable_rollout_repairs`, then repeats the preflight invariant
   and aborts for any bound non-finalized row or incomplete finalized row. It
   then installs the content-free retired-key tombstone table plus D1 triggers
   requiring an adopted immutable identity before binding and exact new-code
   authorization before terminal finalization. This closes the
   query/install race without silently blessing old mutable canonical keys.
   From this boundary, an indefinitely delayed old finalization fails closed
   before canonical side effects and can be retried after the compatibility
   Worker promotes its object:

   ```
   npx wrangler d1 migrations apply brain-us --remote
   ```

3. **COMPATIBILITY deploy (atomic, not gradual)** — deploy this codebase with
   `ARTIFACT_UPLOAD_PROTOCOL_PHASE = "compat"` (the committed wrangler.toml
   value) as a normal 100% deploy. Do NOT use gradual percentage deployment
   for this cutover: gradual routing keeps *starting* new old-version
   requests, while an atomic deploy bounds old activity to requests already
   in flight — whose interleavings convergence resolves. Verify:
   `npx wrangler deployments status` shows the new version at 100%.

4. **CLOSE the admission gate** — operator D1 write:

   ```
   npx wrangler d1 execute brain-us --remote --command \
     "INSERT INTO artifact_intake_admission (id, state, updated_at) VALUES (1, 'closed', <now_ms>) \
      ON CONFLICT (id) DO UPDATE SET state = 'closed', updated_at = <now_ms>"
   ```

   All new upload mutations now refuse with `upload_admission_closed`
   (retryable; channel-media jobs are delayed and retried by their queue
   protocol, and interactive clients simply retry after reopening).

5. **QUIESCENCE check (read-only, evidence-based)** — confirm no new-writer
   mutation is pending admission side effects:

   ```
   SELECT COUNT(*) FROM artifact_intake_operations
    WHERE upload_protocol IS NULL AND status IN ('reserved', 'failed')
      AND expires_at > <now_ms>;
   ```

   This is an observability signal, not the safety proof: a resumed old
   request can still act later and is handled by convergence. If the count
   does not reach zero, investigate; do not proceed on elapsed time alone.

6. **APPROVED IMMUTABLE PROMOTION** — while the gate remains closed, call
   `artifact_immutable_rollout_status` through an authenticated tenant session
   and require the exact approved category, target count, and digest above.
   Record that approval in the content-free quarantine rows with an operator D1
   update, then repeat status and require `approved_count = 9`. A null or
   different stored approval digest fails closed. Then call
   `repair_artifact_immutable_rollout` with those same three values.

   ```sql
   UPDATE artifact_immutable_rollout_repairs
      SET approval_digest = '<approved_digest>', updated_at = <now_ms>
    WHERE tenant_id = '<approved_tenant_id>' AND approval_digest IS NULL;
   ```

   Require exactly nine changed rows. Never overwrite a non-null different
   digest; that is a hard stop requiring investigation.
   The repair plaintext-proves the original encrypted object, copies the exact
   ciphertext envelope to the deterministic immutable attempt key, conditionally
   advances the Neon canonical pointer and D1 identity, and verifies both stores.
   It is retry-safe across a Neon-to-D1 interruption. The original R2 object is
   retained and no retired-key tombstone is created for these approved rows.
   Stop if status reports any pending repair after the call or any approval
   digest differs.

7. **ACTIVATE** — atomic redeploy with
   `ARTIFACT_UPLOAD_PROTOCOL_PHASE = "active"`. Both builds dispatch the
   upload path on the row's recorded `upload_protocol`, never on their own
   phase; only activation-phase reserves create `fenced_v2` rows. Because the
   gate is closed, no new-writer mutation occurs anywhere in this boundary.

8. **REOPEN the gate** — operator D1 write setting `state = 'open'` (or
   deleting the row). Verify a reserve/upload round-trip succeeds and records
   `upload_protocol = 'fenced_v2'` with an adopted attempt key.

9. **AUDIT** — verify every finalized managed operation has a non-null
   `adopted_attempt_token` and exact immutable attempt key. Compat-phase sealed
   rows may remain legacy only until finalization promotes them. For the
   approved nine-row repair, also require `repair_state = 'completed'`, the
   approved digest on every repair row, exact D1/Neon identity agreement, and
   continued existence of every original R2 object.

**Rollback** at any step: set the gate `closed`, atomically redeploy the
previous compat build, then reopen. Do not roll back to code that cannot
promote under the immutable-finalization trigger. Fenced
rows already adopted remain valid under any protocol-aware build; migrations
are forward-only and never need reverting. Existing uploads, sealed objects,
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
- **Delayed-adoption fence.** Before deleting an expired attempt object, the
  sweeper atomically clears the exact D1 ownership token and rereads it. An
  adoption issued while the lease was live but executed later must therefore
  change zero rows; uncertainty retains both object and tombstone.
- **Retired legacy-key tombstone.** Promotion records the deterministic shared
  key before switching D1. This content-free pointer is never automatically
  retired: the scheduled sweeper repeatedly deletes old puts landing on the
  abandoned key and refuses deletion until D1 proves an adopted key is
  canonical.
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

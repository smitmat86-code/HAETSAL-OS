# Artifact upload ownership rollout (migrations 1033/1035, fenced_v2)

Status: NOT executed. Production remains on Worker version
`bc5b4e08-6344-4df7-b7ae-a451371486a2` (old Worker, 1e4d3a6 behavior).
Migrations 1033, 1034, and 1035 are pending and were not applied remotely.

## Why gradual deployment old → active is PROHIBITED

The old Worker's upload mutations (seal, mark-failed, legacy recovery) are
guarded only by `status != 'finalized'` and carry no attempt ownership. If it
resumed against a row whose `r2_key` had been moved to an immutable attempt
key, its unconditional UPDATE would record its own ciphertext hash under the
new key: an undetectable D1/R2 split. No D1 predicate in new code can prevent
that, because the old SQL is already shipped. Safety therefore comes from the
protocol rule enforced by `upload-protocol.ts`:

> Attempt-key adoption is enabled only on rows with
> `upload_protocol = 'fenced_v2'`, and such rows are reserved only by an
> activation-phase Worker, which may exist only after the old Worker has
> provably drained.

Rows the old Worker can hold (its own reserves, and compat-phase reserves,
both `upload_protocol NULL`) are always uploaded through the legacy per-upload
key by every Worker version, so the recorded hash always refers to the single
shared key and the mission's "new attempt key + old hash" split is
structurally impossible. Residual legacy-key hash races between overlapping
writers are exactly today's production exposure, are bounded by the drain
window plus the 15-minute operation TTL, and end at activation.

Deterministic proof: `tests/12.17-artifact-mixed-version-rollout.test.ts`
replays the exact old seal, mark-failed, and legacy-recovery SQL from 1e4d3a6
after new-Worker adoption and proves D1 and R2 cannot split, and that fenced
rows can only be born from activation-phase reserves.

## Executable sequence (expand → compatibility → drain → activate → enforce)

1. **EXPAND** — apply pending migrations (safe under the old Worker; nullable
   columns and a new content-free journal table only):

   ```
   npx wrangler d1 migrations apply brain-us --remote
   ```

2. **COMPATIBILITY deploy** — deploy this codebase with
   `ARTIFACT_UPLOAD_PROTOCOL_PHASE = "compat"` (the committed wrangler.toml
   value). Gradual deployment old → compat is permitted: for every row both
   versions can see, both write the same legacy key.

   ```
   npx wrangler deploy
   ```

3. **DRAIN (verified, not assumed)** — a deployment timestamp is not a drain
   boundary. Gate on all of:
   - Cloudflare version analytics / `wrangler deployments status` show the
     old version serving 0% and zero old-version requests in flight;
   - plus one full Worker request lifetime of grace;
   - plus `ARTIFACT_UPLOAD_EXPIRY_MS` (15 minutes), so every operation an old
     isolate could still hold is terminal or expired. Optional read-only
     check: no `reserved`/`failed` rows with `upload_protocol IS NULL` and
     `expires_at > now`.

4. **ACTIVATE** — redeploy the same build with
   `ARTIFACT_UPLOAD_PROTOCOL_PHASE = "active"`. Gradual compat → active is
   permitted: both builds dispatch the upload path on the row's recorded
   `upload_protocol`, never on their own phase. Only activation-phase
   reserves create `fenced_v2` rows.

5. **ENFORCE (later audit)** — 15 minutes after activation every legacy row
   is terminal; from then on every newly sealed row must carry
   `adopted_attempt_token`. Legacy sealed rows keep
   `adopted_attempt_token NULL` and continue to prove against the legacy key.

## Orphan attempt retention and cleanup

Fenced attempts write unique immutable keys, so losing/stale attempts leave
encrypted orphan objects. Governance (see
`src/services/artifact-intake/attempt-orphans.ts`):

- **Journal before put.** A content-free row (tenant, upload, attempt token,
  timestamps only) is inserted into `artifact_upload_attempts` (migration
  1035) before every fenced R2 put, so a crashed attempt stays findable.
- **Immediate cleanup.** After a definitive adoption loss the writer rereads
  authoritative D1 state and deletes only its own attempt key. An ambiguous
  adoption response deletes only if D1 proves another identity was adopted or
  the operation left the adoptable states; D1/R2 unavailability keeps
  everything (uncertainty never deletes).
- **Crash-safe bounded sweeper.** `sweepAbandonedArtifactUploadAttempts`
  (invoked from `reapExpiredArtifactUploads`) processes a bounded batch of
  journal rows whose attempt lease expired at least
  `ARTIFACT_UPLOAD_ATTEMPT_ORPHAN_GRACE_MS` (15 min, one full Worker request
  lifetime) ago — so no eligible attempt can still be writing and a late put
  can no longer land after its journal row is retired. The adopted attempt's
  object is never deleted (its journal row alone is retired); a still-live
  claim defers; everything else is deleted by exact derived tenant/upload/
  attempt key with zero body reads.

Proof: `tests/12.18-artifact-attempt-orphan-cleanup.test.ts`.

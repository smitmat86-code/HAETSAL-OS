# Session 5 legacy media remediation approval packet

Inventory date: superseded; corrected post-deployment inventory is pending the fresh channel gates
Mode: read-only production R2 + D1 + authoritative Neon reconciliation
Approval state: **not approved; Phase 2 must not run**

No object key, tenant identifier, caption, filename, URL, extraction, or content is included in this packet.

## Superseded packet warning

The prior aggregate-only digest `62a3ad605be33091628eecd0cb607396c96ea1030a4d3f8da692969518089559` is revoked and cannot authorize Phase 2. Its counts remain historical evidence only. A corrected packet will be generated from a fresh union reconciliation after the Telegram and Sendblue live gates. Its digest will bind a sorted private exact-target manifest, not just aggregate totals.

## Historical inventory — not approval-capable

| Category | Objects | Bytes | Proposed Phase 2 treatment |
|---|---:|---:|---|
| Referenced Telegram | 2 | 136,114 | TMK-seal into managed R2, register/link in Neon, verify, then delete replaced plaintext |
| Referenced Sendblue | 0 | 0 | None |
| Orphan Telegram | 3 | 204,045 | Delete only if this category is explicitly approved |
| Orphan Sendblue | 4 | 142,352 | Delete only if this category is explicitly approved |
| Already encrypted | 0 | 0 | Excluded/no-op |
| Already migrated | 0 | 0 | Excluded/no-op |
| Ambiguous/unclassifiable | 0 | 0 | Always excluded |

The two referenced objects were authoritative Neon references but absent from D1's stale compatibility table at the historical inventory time. There were no D1-only references. The two affected canonical documents had the aggregate preflight content fingerprint `284778f38937b3d25e7e3f9284775eaa638ad70374695efa782fe37c15cfeb6c`.

The historical proposed scope was two managed replacements plus deletion of two verified replaced originals and seven confirmed orphans: nine legacy objects and 482,511 legacy bytes. These totals do not authorize any operation and must be recomputed.

## Corrected exact-approval binding

The next public packet will disclose only aggregate counts/bytes, inventory version/time, executor commit, canonical-content fingerprint, exact-target count, explicitly approvable named categories, exclusions, and the approval digest. The digest binds both the exact named category set and the private sorted manifest used for every deletion-capable target:

- an HMACed object identity and HMACed tenant/capture ownership identity;
- exact byte count, object version when available, complete object SHA-256, and ETag;
- Telegram or Sendblue channel, exact disposition, and reconciliation state; and
- inventory version/time, executor commit, and canonical-content fingerprint.

Unknown or unreadable envelopes, missing R2 references, incomplete object evidence, any non-singleton authoritative Neon reference set, duplicate D1 references, D1-only references, multi-owner references, and D1/Neon ownership disagreements are ambiguous and deletion-ineligible. Only an object with zero Neon and zero D1 references can begin as an orphan. A legacy source is “already migrated” only when the inventory proves the exact legacy key/tenant/capture relationship to a managed primary source selected by both the capture and document; a managed derivative or unrelated artifact does not qualify. Changing any exact target or approved category, even while preserving aggregate counts and byte totals, changes the contract, and an executor rejects a matching digest if the named categories are absent or different.

## Exact migration method and order

For each of the two referenced Telegram originals, the approved executor would:

1. Re-read the exact legacy object through the tenant-scoped binding and confirm it remains in the approved inventory snapshot.
2. Sniff MIME from bytes, enforce the bounded byte count, and compute the plaintext SHA-256.
3. Resolve the owning tenant and capture from authoritative Neon; reject any mismatch, duplicate ownership, changed reference, or newly ambiguous state.
4. Reserve one deterministic governed upload using a hash-derived legacy migration identity. D1 receives only operation IDs, hashes, byte counts, coarse MIME, fixed status, and canonical IDs.
5. Seal the exact bytes under the active tenant TMK and write one deterministic `artifact-intake/v1/...` object.
6. Re-read the managed object, prove its `TMK1:` envelope, ciphertext SHA-256, plaintext SHA-256 after unsealing, and exact byte count.
7. Lock the owning capture/document, snapshot the legacy source row and all primary compatibility pointers, then in one Neon transaction atomically replace that source row in place. If an implementation must insert and switch instead, the old source row is deleted inside the same transaction before commit. No transaction may leave two source rows.
8. Mark the content-free D1 operation finalized with the authoritative Neon IDs. D1's retired canonical compatibility table is not treated as authority or repopulated with searchable content.
9. Verify governed intake status, canonical document read, exactly one source row, exactly one primary source, a valid primary pointer, and existing search hits. Recompute the aggregate canonical-content fingerprint and require an exact match.
10. Only after all prior checks succeed, delete that one exact legacy plaintext key. Reconcile aggregate counts before moving to the next object.

Confirmed orphans would be deleted only after a fresh pre-delete inventory still shows no Neon reference, no D1 compatibility reference, and no ambiguity. The seven orphan deletions are independent of the two referenced migrations and can be withheld separately.

## Proof that canonical content and search do not change

The Phase 2 transaction is limited to `haetsal_canonical.canonical_artifacts` plus the existing `artifact_id` compatibility pointers on the owning capture/document. It does not update `canonical_documents.body_sha256`, `canonical_documents.chunk_count`, `canonical_chunks.chunk_text`, capture provenance, or any projection/search record.

Before and after, the executor will compare a SHA-256 over the ordered tuple `(document_id, body_sha256, chunk_count)` for the affected documents. It must remain `284778f38937b3d25e7e3f9284775eaa638ad70374695efa782fe37c15cfeb6c`. The existing canonical reads and targeted lexical searches must return the same document IDs and bodies.

## Verification queries and checks

All SQL uses bound IDs/keys; raw values are never logged.

- Neon ownership: select artifact/capture/document linkage for the bound legacy key and require exactly one tenant and capture.
- Neon manifest: select ordered artifact rows for the bound capture and require exactly one primary source pointing at the new managed object.
- Canonical invariance: select ordered document ID, body SHA-256, and chunk count for the affected captures and compare the aggregate fingerprint.
- D1 operation: select the bound upload operation and require `status='finalized'`, TMK family, matching hashes/bytes, and matching canonical IDs.
- R2: range-read the envelope prefix, hash the complete ciphertext, unseal with the tenant TMK, and compare plaintext hash/length to the original receipt.
- Canonical surface: run status, canonical read, and the existing targeted search proof before deletion.
- Reconciliation: list both legacy prefixes and managed replacements again; require exact expected before/after counts and zero unapproved key changes.

## Rollback

Before legacy deletion, rollback is fully lossless: use the private rollback snapshot to restore the prior source row and capture/document pointers in one Neon transaction, require exactly one restored source and a valid primary pointer, mark the D1 operation rolled back/failed with a fixed code, and delete only the deterministic unreferenced managed replacement after its hash is proven. Rollback must never insert a second source row. The untouched legacy original remains canonical.

After a replaced legacy original is deleted, the verified managed TMK object is the recovery source. A rollback would unseal it inside the authorized worker, verify the recorded plaintext hash/length, restore the exact legacy object, restore prior Neon pointers transactionally, and independently verify canonical read/search. Confirmed orphan deletion is intentionally irreversible; those seven objects will not be deleted unless Matt explicitly approves that category.

Any mismatch stops the batch. Every item that is ambiguous or unverifiable at inventory or execution time is excluded and left untouched.

## Expected production impact

The referenced migration processes only 136,114 plaintext bytes across two objects and writes approximately the same amount plus TMK envelope overhead. It performs two short Neon metadata transactions and bounded R2 reads/writes. No downtime, reindex, dream-cycle change, or canonical-body rewrite is expected. Orphan deletion is seven exact R2 deletes after a fresh reference check.

## Approval required

Phase 2 has not run. No approval is currently actionable. After the corrected live gates and fresh exact inventory, approval must name the desired categories and the new exact-target digest. The historical categories below are illustrative only and will be replaced by the fresh packet:

- migration and post-verification deletion of the 2 referenced Telegram originals (136,114 bytes); and
- deletion of the 3 Telegram plus 4 Sendblue confirmed orphans (346,397 bytes).

Ambiguous, already migrated, already encrypted, and any newly changed/unverifiable object remain excluded regardless of approval.

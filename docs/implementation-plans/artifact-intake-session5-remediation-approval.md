# Session 5 legacy media remediation approval packet

Inventory date: 2026-08-15 America/Los_Angeles
Mode: read-only production R2 + D1 + authoritative Neon reconciliation
Approval state: **not approved; Phase 2 must not run**

No object key, tenant identifier, caption, filename, URL, extraction, or content is included in this packet.

## Reconciled inventory

| Category | Objects | Bytes | Proposed Phase 2 treatment |
|---|---:|---:|---|
| Referenced Telegram | 2 | 136,114 | TMK-seal into managed R2, register/link in Neon, verify, then delete replaced plaintext |
| Referenced Sendblue | 0 | 0 | None |
| Orphan Telegram | 3 | 204,045 | Delete only if this category is explicitly approved |
| Orphan Sendblue | 4 | 142,352 | Delete only if this category is explicitly approved |
| Already encrypted | 0 | 0 | Excluded/no-op |
| Already migrated | 0 | 0 | Excluded/no-op |
| Ambiguous/unclassifiable | 0 | 0 | Always excluded |

The two referenced objects are authoritative Neon references but are absent from D1's stale compatibility table. There are no D1-only references. The two affected canonical documents have the aggregate preflight content fingerprint `284778f38937b3d25e7e3f9284775eaa638ad70374695efa782fe37c15cfeb6c`.

Full proposed scope is two managed replacements plus deletion of two verified replaced originals and seven confirmed orphans: nine legacy objects and 482,511 legacy bytes. The frozen full-scope approval digest is `62a3ad605be33091628eecd0cb607396c96ea1030a4d3f8da692969518089559`.

## Exact migration method and order

For each of the two referenced Telegram originals, the approved executor would:

1. Re-read the exact legacy object through the tenant-scoped binding and confirm it remains in the approved inventory snapshot.
2. Sniff MIME from bytes, enforce the bounded byte count, and compute the plaintext SHA-256.
3. Resolve the owning tenant and capture from authoritative Neon; reject any mismatch, duplicate ownership, changed reference, or newly ambiguous state.
4. Reserve one deterministic governed upload using a hash-derived legacy migration identity. D1 receives only operation IDs, hashes, byte counts, coarse MIME, fixed status, and canonical IDs.
5. Seal the exact bytes under the active tenant TMK and write one deterministic `artifact-intake/v1/...` object.
6. Re-read the managed object, prove its `TMK1:` envelope, ciphertext SHA-256, plaintext SHA-256 after unsealing, and exact byte count.
7. In one Neon transaction, insert the source artifact manifest row and update the existing capture/document primary compatibility pointer. No capture, document, body, chunk, extraction, or search row is created or changed.
8. Mark the content-free D1 operation finalized with the authoritative Neon IDs. D1's retired canonical compatibility table is not treated as authority or repopulated with searchable content.
9. Verify governed intake status, canonical document read, exact one-primary-source manifest, and existing search hits. Recompute the aggregate canonical-content fingerprint and require an exact match.
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

Before legacy deletion, rollback is fully lossless: restore the prior capture/document artifact pointers in a Neon transaction, delete only the newly inserted manifest row, mark the D1 operation rolled back/failed with a fixed code, and delete only the deterministic managed replacement after its hash is proven. The untouched legacy original remains canonical.

After a replaced legacy original is deleted, the verified managed TMK object is the recovery source. A rollback would unseal it inside the authorized worker, verify the recorded plaintext hash/length, restore the exact legacy object, restore prior Neon pointers transactionally, and independently verify canonical read/search. Confirmed orphan deletion is intentionally irreversible; those seven objects will not be deleted unless Matt explicitly approves that category.

Any mismatch stops the batch. The current ambiguous set is empty, but any item that becomes ambiguous or unverifiable at execution time is excluded and left untouched.

## Expected production impact

The referenced migration processes only 136,114 plaintext bytes across two objects and writes approximately the same amount plus TMK envelope overhead. It performs two short Neon metadata transactions and bounded R2 reads/writes. No downtime, reindex, dream-cycle change, or canonical-body rewrite is expected. Orphan deletion is seven exact R2 deletes after a fresh reference check.

## Approval required

Phase 2 has not run. Approval must name the desired categories and the frozen digest. Full-scope approval would need to explicitly authorize:

- migration and post-verification deletion of the 2 referenced Telegram originals (136,114 bytes); and
- deletion of the 3 Telegram plus 4 Sendblue confirmed orphans (346,397 bytes).

Ambiguous, already migrated, already encrypted, and any newly changed/unverifiable object remain excluded regardless of approval.

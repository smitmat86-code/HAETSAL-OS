# ADR: governed artifact intake contract

Date: 2026-08-14
Status: accepted; Sessions 2-4 deployed, Session 5 correction pass pending deployment and fresh Telegram/Sendblue live proof

## Context

HAETSAL can retain canonical searchable content and can record an R2 artifact reference, but the external-client surface cannot yet receive, verify, seal, or finalize raw bytes. Telegram and Sendblue currently write channel media to R2 before canonical governance. A durable source or intentional derivative must not be represented by a pointer unless HAETSAL has actually received and sealed its bytes.

## Decision

One HAETSAL-owned artifact-intake contract will serve local coding clients, ChatGPT, and channel adapters. The lifecycle is reserve and seal, then canonical finalize. Every client-visible success requires a managed byte receipt; otherwise the stable result is `raw_bytes_unavailable`. A declared derivative is mandatory and finalization fails with `missing_declared_derivative` if it is absent.

The client performs OCR, vision, document reading, and synthesis. The governed core validates and seals bytes, owns R2 keying and lifecycle state, and persists the client-produced searchable content through the existing canonical Neon path. The core does not call a model.

One capture permits zero or one source, zero or more derivatives, ordered parent links, and exactly one primary artifact. `capture_mode=artifact` requires at least one sealed artifact. Tenant ownership is re-established server-side for every operation; a client-supplied tenant or artifact identifier is never sufficient authorization.

## Privacy and encryption boundary

This remains the approved single-user posture. All durable managed originals, including provider-channel originals, require the active tenant master key and use the `TMK1` family. Provider webhooks additionally require a valid Cron KEK to seal the short-lived channel descriptor as `KEK1` until the queue consumer can obtain the tenant TMK. Missing authority-specific key material is `encryption_key_unavailable`; the service never falls back to plaintext R2.

The original and durable derivatives are application-layer ciphertext in R2. Searchable extraction and normalized chunks remain plaintext in Neon so canonical retrieval and the existing dream cycle can use them. Plaintext file bodies and extractions do not belong in D1, KV, queue metadata, Analytics, AI Gateway, or logs.

Vendor blindness is explicitly not a goal and must not be claimed. Cloudflare and Neon remain trusted processing/storage vendors within this design, and Neon contains the searchable plaintext copy.

## Fixed contract defaults

- Interactive maximum: 25 MiB; larger inputs return `bulk_import_required`. Telegram additionally inherits the Bot API's 20 MiB download ceiling.
- MIME: sniffed/detected MIME is authoritative. Missing or `application/octet-stream` declarations are unspecified; any other declared/detected mismatch returns `mime_mismatch`.
- Download URLs: public HTTPS only, no URL credentials, localhost, single-label/local names, or private/reserved resolved addresses. The downloader must pin the resolved public address for a request and repeat validation after every redirect.
- Download timeout: 20 seconds. Maximum redirects: 3.
- Pending upload expiry: 15 minutes. Expiry is not permission to delete arbitrary keys; the reaper must prove the exact tenant-scoped pending object first.
- Errors are fixed-vocabulary and content-free. Rejected filenames, URLs, bodies, extraction, keys, and tokens must not appear in logs.
- Channel provider handles are capped at 512 characters, hosted locators at 2,048, reply targets at 128, captions at 4,096, model descriptions at 8,192, KEK handoff plaintext at 8,192 bytes, and TMK recovery plaintext at 16,384 bytes.

These values live only in `src/services/artifact-intake/config.ts`.

## Threat model

The trust boundary starts at authenticated tenant resolution or a verified provider webhook. Client metadata, filenames, declared MIME, byte length, hashes, upload IDs, parent IDs, and temporary URLs are untrusted. Principal threats are cross-tenant object substitution, SSRF and redirect/DNS rebinding, MIME confusion, oversize streaming, raw-data logging, key-family substitution, replay/duplicate finalize, and orphaned ciphertext.

Session 1 enforces schema and pre-fetch URL/address contracts. Session 2 owns sealing, storage/idempotency, tenant-scoped keys, transactional manifest persistence, and reaping. Session 3 owns local helper transport. Session 4 owns the complete connection-time URL/DNS/redirect downloader. Session 5 converges Telegram/Sendblue and remediates legacy raw objects. Contract checks here do not claim those later controls are deployed.

## Session 2 implementation record

Session 2 adds a metadata-only D1 upload/finalization ledger, binary-safe `TMK1:`/`KEK1:` AES-GCM envelopes, deterministic tenant-scoped managed R2 keys, retry repair across R2/D1/canonical-write boundaries, and exact-key expiry cleanup. Canonical Postgres evolves additively from one artifact row to an ordered source/derivative manifest with parent links, plaintext/ciphertext hashes, and encryption family. The existing capture/document `artifact_id` columns remain the primary-artifact compatibility pointer.

No Session 2 service registers an MCP tool, HTTP route, downloader, local helper, or channel adapter. Therefore every Session 1 client capability remains unavailable until its later transport session is implemented and proven.

## Session 5 implementation record

Telegram and Sendblue now converge on one provider-neutral channel-media job. A verified webhook resolves the tenant, hashes a stable tenant/provider event identity into content-free D1 state, writes the provider locator, reply target, and optional caption only inside an expiring tenant-KEK envelope, and queues only the opaque operation ID. The queue consumer acquires and sniffs bounded bytes, performs adapter-side vision extraction, TMK-seals the exact original into the existing managed namespace, calls the existing canonical finalizer with one primary source manifest, verifies `artifact_intake_status`, and only then claims the provider acknowledgement.

Telegram uses `file_id` only against fixed Bot API origins and refuses redirects. Sendblue accepts media only with a stable `message_handle`; authenticated re-fetch must return that exact handle, the expected sender, the configured receiving line, explicit inbound direction, and a media URL. Missing or mismatched binding fields fail closed. The current `sb-signing-secret` webhook header is required, while the path secret remains defense in depth. The temporary URL exists only in the authenticated provider response and is passed directly into the bounded Session 4 downloader; it is never persisted in D1, a queue, a log, a receipt, or a client error.

Every processing transition requires the current lease token and a single-row compare-and-swap. Before provider fetch or vision, a retry checks the canonical finalization identity and repairs D1 from authoritative Neon when canonical capture already succeeded. Adapter extraction needed across a crash is kept only in a bounded TMK-encrypted recovery envelope in managed R2; D1 and the queue retain only opaque operation state. Stale workers cannot finalize, retry, or fail the job. An already canonical capture is recovered to delivery and can never be converted into a failed job or false failure reply.

Channel job leases, deterministic upload/finalize idempotency keys, and a separate delivery claim prevent duplicate artifacts, captures, documents, and acknowledgements under webhook and queue redelivery. An ambiguous provider-send result is recorded as `delivery_unknown` and is never automatically re-sent. Encrypted handoff and recovery envelopes are deleted after a delivered or terminal result and independently reaped after expiry. If the Cron KEK is absent or expired, media webhook acceptance returns a retryable failure before creating a D1 job or queue message.

### Session 5 legacy remediation approval contract

Phase 1 inventories the union of legacy R2 keys, Neon references, and D1 compatibility references. Missing R2 objects, unknown or unreadable envelopes, incomplete object identity evidence, multi-owner references, and D1/Neon ownership disagreements are ambiguous and deletion-ineligible. The public approval packet contains aggregates only. Its digest commits to a sorted private exact-target manifest whose entries bind HMAC-obscured object and owner identities, bytes, object version, full object hash, ETag, channel, disposition, reconciliation state, inventory version/time, canonical-content fingerprint, and executor commit. Any same-count/same-byte target substitution changes the digest.

Phase 2 remains separately approval-gated and is not implemented by this correction pass. For each approved referenced object, it must prepare and verify a TMK-managed replacement while legacy bytes remain intact, then open one Neon transaction, lock the capture/document/legacy source, snapshot the legacy source row and primary pointers, and atomically replace that single source row (or atomically insert/switch/delete it) so the committed capture has exactly one source artifact and valid capture/document primary pointers. D1 compatibility repair follows. Legacy bytes may be deleted only after status, canonical read, search, hashes, byte counts, exactly-one-source, and pointer checks pass. Rollback restores the snapshotted row and pointers; it must never create a second source artifact.

## Non-goals

- No compiled wiki/page feature or compiled-page dependency.
- No multi-user or shared-brain redesign.
- No bulk archive importer.
- No model/OCR call inside the intake core.
- No production migration, route, tool registration, R2 write, or legacy object mutation in Session 1.

## Consequences

Until each later adapter is deployed and proven, its Session 1 capability record remains unavailable and returns `raw_bytes_unavailable`. Existing `capture_memory` reference behavior stays backward compatible but is not evidence that raw bytes were retained. The dream cycle remains unchanged and will see artifact extraction only after finalization writes it through canonical capture.

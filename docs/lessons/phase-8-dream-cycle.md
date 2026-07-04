# Phase 8 Lessons — Dream/Janitor Consolidation Loop

Date: 2026-07-04.

## LOAD-BEARING: Cron KEK ≠ TMK (proven live, settles the Phase 5 follow-up)

`provisionOrRenewKek` generates a **random 32-byte KEK** (TMK-encrypted in D1,
raw in KV for 24h). `deriveTmk` produces a **non-extractable HKDF key**. They
are NOT interchangeable — a KEK-encrypted artifact decrypts only with the KEK.
Proven at this gate: the dream report body (written cron-side with the KEK)
was unreadable via a `deriveTmk` session key until the read path switched to
`fetchAndValidateKek`. The stale kek.ts comment claiming "KEK is the TMK raw
bytes" is corrected.

Consequences:
- **Phase 13 cold-DO TMK fallback (Phase 5 follow-up): the naive KV-KEK
  fallback MUST NOT be wired.** `executeApprovedAction` payloads are
  TMK-encrypted; decrypting them with the KEK would fail (and the reverse
  would silently corrupt). The correct fallback needs the TMK derivation
  inputs (jwtSub), not the KEK.
- Any cron-written canonical body sidecar is KEK-encrypted → session-TMK
  document reads of cron-written captures fail by construction (chunk
  previews in Postgres remain readable — retrieval works; full-body reads
  need the KEK). System-wide pre-existing behavior; Phase 13 hardening item:
  consider dual-recipient sidecars or KEK-family tagging on captures.

## Workflows discipline (Law 2)

`step.do()` return values are persisted by the Workflows engine — content
must never cross a step boundary. The content-bearing stage lives in ONE step
(`services/dream/stage.ts`) returning `{counts, ids}` only, plus
`sensitive: 'output'` so even those are `[REDACTED]` in Workflows
observability (verified live in `wrangler workflows instances describe`).
Workflow failure strings use a fixed vocabulary (`dream_cycle_failed:<class>`)
so store/AI error text can never echo content into D1.

## Gate diagnosis trail (for future debugging)

1. First live run failed: `retainContent requires TMK or pre-encrypted
   archival content` — cron context has no session TMK; the stage now fetches
   the Cron KEK and DEFERS honestly when absent (Law 2 corollary).
2. `wrangler workflows instances describe <id>` shows per-step errors and
   retry timelines — much faster than log spelunking; the D1-query API is not
   available to this environment's token, but the workflows API is.
3. A smoke that polls a "latest" endpoint must match ITS OWN run id — stale
   terminal rows otherwise satisfy the poll (bit us once).

## Design notes

- Report-only is structural: the dream services contain zero
  entity/claim/fact mutation calls and zero DELETEs (verifier-checked).
  Decided proposals (approved OR rejected) never re-file — statement-hash
  dedup across all dream reviews; a genuinely new development produces a new
  statement.
- The window excludes `cron:dream` captures — no dreaming about dream
  reports.
- Quiet nights are honest: "Quiet night — no new signals above the confidence
  floor" + the counts line, rather than manufactured findings.

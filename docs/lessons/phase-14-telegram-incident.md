# Incident: 55-minute Telegram replies (2026-07-06)

## Symptom
Message sent 10:38 PT answered 11:33 PT. A prior overnight message was
answered with the "trouble thinking" fallback hours late.

## Root cause (two layers, both fixed)

1. **Inline processing in the webhook request.** The handler ran the whole
   chat pipeline (automation-intent check → delegation check → grounded
   reply; up to three model calls plus the 13.1 retry backoffs) *before*
   acknowledging Telegram. Under AI-gateway degradation
   (`GATEWAY_CHAT_EMPTY` retry loops + `RETRIEVAL_TIMEOUT`), attempts
   exceeded Telegram's ~60 s read timeout; the edge **canceled the
   invocation mid-pipeline** (logs: eight consecutive ~59.9 s
   `outcome: canceled` attempts, 11:13–11:30) and Telegram re-delivered
   every ~2–3 min. The 11:32:19 attempt finished in 41 s → 200 → the
   11:33 reply. Telegram's `getWebhookInfo` recorded "Read timeout
   expired" at 11:30:22. Duplicate captures from redeliveries collapse
   via the dedup hash (by design).
2. **Stale edge config from the custom-domain move.** The webhook was
   still registered to the old `workers.dev` host, whose Access bypass
   app predates the move; the custom domain had **no** bypass for
   `/telegram/webhook` or `/ingest/*` (Telegram → Access 401). It "worked"
   only because the old host still served. Gate smokes never caught this:
   they authenticate with a service token, so they cannot see what an
   unauthenticated third-party webhook sees.

## Fixes shipped

- **14.1** `/api/system/telegram/webhook` ops route: sanitized
  `getWebhookInfo` (never the token) + `setWebhook` re-register from the
  worker, which holds the secret. 3 contract tests.
- **14.2** Webhook **acks Telegram in milliseconds**; the pipeline runs
  detached via `waitUntil` (tests keep the inline path). Deploy `57f80a93`.
- **Access**: bypass apps created on the custom domain for
  `/telegram/webhook` and `/ingest/*` (Matt's scoped token, 2026-07-06);
  no-credential probe now returns the worker's 403 instead of Access's
  401. Webhook registration flipped to
  `haetsalos.specialdarksystems.com/telegram/webhook`; error state clean.

## Follow-ups

- Sendblue route still processes inline (same class; apply ack-fast when
  next touched).
- Move chat processing queue-side (enqueue → consumer → reply) for
  crash-durability and single-trace visibility per message.
- Canary: add a no-credential webhook reachability probe (expect our 403,
  not an Access 401) — the blind spot that hid layer 2.
- Morning-brief cron `0 7 * * *` is UTC (= midnight PT) — pending Matt's
  call on the intended hour.
- Old workers.dev bypass apps are now redundant (safe to delete in the
  dashboard whenever).
- The API token pasted in chat for the Access fix should be rotated.

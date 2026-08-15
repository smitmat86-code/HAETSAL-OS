# Phase 4 — Sendblue iMessage Channel Lessons

Date: 2026-07-03

Correction (Session 5, 2026-08-15): current Sendblue webhooks include the
`sb-signing-secret` header. HAETSAL now requires it and retains the path secret
as defense in depth. The original Phase 4 statement below is historical and
must not be used as the current security contract.

1. **Historical auth model was a bearer path segment, not a signature.** At the Phase 4 gate Sendblue was understood not to
   sign webhooks. `/webhooks/sendblue/:pathSecret` compares the segment against
   `SENDBLUE_WEBHOOK_PATH_SECRET` with `crypto.subtle.timingSafeEqual` (equal
   lengths pre-checked), then requires `to_number == SENDBLUE_PHONE_NUMBER`.
   A CF Access bypass app covers `/webhooks/sendblue/*` (verified Phase 0).
   Wrong secret returns 404 (indistinguishable from no route).

2. **Shared line means sender allowlisting is mandatory.** Anyone can text the
   Free Tier number. Unknown `from_number`s are ignored without a reply
   (logging only the last 4 digits). Senders map to tenants via the existing
   `tenant_phone_numbers` D1 table; Matt self-registers by opening
   `https://haetsalos.specialdarksystems.com/?phone=%2B1XXXXXXXXXX` (CF Access
   authenticated; first-registration-wins per number).

3. **TMK never reaches the webhook.** Inbound text/photo captures go through
   the ingestion queue (`sms_inbound` with `channel: 'sendblue'`, new
   `sendblue_media` type); the consumer fetches the TMK from the DO and
   retries on cold DO — the established SMS pattern. The webhook only does:
   tenant lookup, R2 media put (raw artifact tier), vision/reply AI calls
   (gateway, collectLog:false), and the Sendblue send.

4. **Replies are memory-grounded from day one.** `generateGroundedReply` runs
   a composed broker search and feeds the top items (source + date + preview)
   into the reply prompt, instructing the model to cite naturally and to be
   honest when a source (Gmail/calendar) is not connected. Demo clause 1's
   Gmail/calendar citation remains blocked on Google OAuth (S5 at Phase 5 —
   the mission's declared stopping point for that credential).

5. **Free Tier reply-window discipline lives in the CLIENT contract.**
   `sendSendblueMessage` returns `{ success, status, errorCode }` and never
   throws on rejection — callers treat outside-window rejections as skips
   (Phase 7 automations will log `skipped_outside_reply_window`, never retry).

6. **Vision model:** `@cf/google/gemma-4-26b-a4b-it` via the gateway, image as
   a data-URL `image_url` content part in an OpenAI-shaped messages array
   (CF-docs schema check at the gate). Photo replies echo the extracted
   description so Matt sees what was stored.

7. **Workers AI models get REMOVED, not just deprecated — smoke every model
   at every gate.** The post-deploy e2e smoke failed with error 5028: both
   Phase 4 models (`llama-3.1-8b-instruct`, `llama-3.2-11b-vision-instruct`)
   were purged from the catalog on 2026-05-30, along with six prod call sites
   that had been silently dead for a month (Telnyx SMS replies, Telegram,
   agent router, write-policy classifier). Earlier phase smokes missed it
   because retrieval uses bge embeddings, which survived the purge. Fixes:
   (a) one shared helper `src/services/workers-ai-chat.ts` owns the model
   choice (`@cf/google/gemma-4-26b-a4b-it` — CF-recommended replacement,
   text+vision, $0.10/M in / $0.30/M out) and the G4 gateway/collectLog
   discipline, so the next deprecation is a one-line change; (b) its
   `readChatText` parses both OpenAI `choices[]` and legacy `{response}`
   shapes and strips think-tags; (c) the e2e smoke drives the real deployed
   webhook with a registered fake number (+15005550006 → service-token
   tenant), which is what caught this. Keep that smoke in every
   messaging-phase gate.

8. **Bonus Law-2/G4 wins from the hotfix:** the Telegram path now goes
   through the gateway with `collectLog: false` (it never had either), and
   ingest.ts no longer logs inbound SMS plaintext (`SMS_FLOW: step1`).

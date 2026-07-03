# Phase 4 — Sendblue iMessage Channel Lessons

Date: 2026-07-03

1. **Auth model is a bearer path segment, not a signature.** Sendblue does not
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

6. **Vision model:** `@cf/meta/llama-3.2-11b-vision-instruct` via the gateway,
   `image: [...bytes]` + prompt input shape (CF-docs check at the gate).
   Photo replies echo the extracted description so Matt sees what was stored.

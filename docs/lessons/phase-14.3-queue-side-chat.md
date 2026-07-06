# 14.3: Queue-side chat processing

## Motivation

After the 2026-07-06 incident (`docs/lessons/phase-14-telegram-incident.md`)
the 14.2 hotfix moved the chat pipeline off the request path with
`waitUntil`, which stopped the redelivery storm — but the pipeline still
ran in the ambient Worker invocation. That leaves two real gaps:

- **Not crash-durable.** A Worker eviction between "ack Telegram" and
  "reply" loses the reply. The user's message is captured (canonical
  queue is already durable), but they never hear back.
- **No single trace per message.** Debugging "why did my reply take 41s?"
  meant reconstructing across multiple log lines with no anchor.

## Design

**One inbound message → two durable queue jobs, both enqueued before the
webhook acks Telegram.**

- `sms_inbound` (unchanged) — canonical capture; needs the TMK.
- `chat_inbound` (new) — the reply pipeline (automation intent → sub-agent
  delegation → grounded reply → send → session recording); needs *no* key
  material (reads canonical via the broker; delivery is a bot call).

Because chat_inbound needs no TMK, the consumer routes it **before** the
TMK acquisition block — so a cold DO can't delay the reply. Ordering is
the idempotence story:

1. Consumer checks `tg_replied:<tenant>:<updateId>` in KV — bail if set.
2. Runs the pipeline (three tools, one send).
3. **If send fails, throw before the marker.** The message retries
   (bounded by the queue's max_retries → DLQ), same updateId, no marker —
   the retry reruns the whole pipeline and re-sends.
4. **After a successful send, never throw.** Set the marker (24 h TTL);
   record the session exchange in a `try/catch` tail. A retry after this
   point would double-reply, so nothing here is allowed to fail loudly.

The photo path stays on `waitUntil`: the heavy legs are one-shot fetches
(Telegram file + vision + R2 put) that aren't request-bound and already
detach; queueing them adds complexity without changing the safety story.

## What this fixes vs. 14.2

| Failure mode | 14.2 (waitUntil) | 14.3 (queue) |
|---|---|---|
| Redelivery storm (Telegram read timeout) | Fixed | Fixed |
| Worker eviction mid-reply | Reply lost silently | Retried, bounded, DLQ |
| Multi-line "which run replied?" traces | Manual reconstruction | One queue message id per reply |
| Gateway storms | Reply times balloon | Reply times balloon *and* bounded retry |

## Contract tests (mission-14.3)

- Reply once + marker set (happy path).
- Redelivered job with same `update_id` does not reply again
  (idempotence).
- Failed send throws with no marker present (safe retry).
- Malformed payload ignored, no send (defensive).

Plus the updated mission-4.1: the webhook enqueues 2 jobs without any
inline reply, and `processChatInbound` produces the reply for that queued
job. The photo test waits for the detached leg to land (`vi.waitFor`).

## Follow-ups

- Apply the same shape to the Sendblue route (same class of failure, low
  traffic — same fix when next touched).
- Add a no-credential webhook reachability canary (blind spot from the
  incident write-up).
- Move `updateId` handling for future channels into a small helper if a
  third channel joins.

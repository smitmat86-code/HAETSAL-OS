# Phase 7 Lessons — User Automations

Date: 2026-07-04.

## Design decisions

1. **One-shot re-arming alarms, not cron rows.** The SDK's `schedule()` accepts
   cron expressions, but a fixed cron is evaluated in UTC — an "8am LA" cron
   drifts an hour across DST transitions. Each automation instead schedules
   its NEXT occurrence as a one-shot `Date` alarm and re-arms inside the fire
   callback. `nextOccurrence` computes wall-clock slots in the tenant tz with
   a two-pass `Intl` conversion; the 2026 spring-forward (23h day) and
   fall-back (25h day) boundaries are contract-tested.
2. **Re-arm in `finally`.** A fire that fails to dispatch (no session key,
   transient dispatch error) records an honest event (`skipped_no_session` /
   `dispatch_failed`) and still re-arms — the next occurrence is the only
   retry, per the mission's Sendblue rule (no retry heuristics).
3. **Automation fires ride the Phase 6 rails.** A fire is just
   `dispatchExecutionTask` with `origin: 'automation:<id>'` — same scoped
   tools, budgets, ledger, cancel/retry, and delivery path as chat-delegated
   runs. The finish handler maps delivery outcomes onto automation events:
   `delivered`, `skipped_outside_reply_window` (Sendblue rejection),
   `delivery_failed`.
4. **Law 2:** task text rests only as TMK ciphertext (`spec_ciphertext`);
   alarm payloads carry `{automationId}` only (the SDK schedule table is
   platform-visible); list views decrypt transiently per response.
5. **NL parser is deliberately conservative**: requires an explicit recurrence
   marker AND a resolvable time; bare hours 1–7 without am/pm are rejected as
   ambiguous ("we meet every day at 3" must not create an automation).
   Everything unparseable falls through to delegation/grounded reply.

## Sendblue Free Tier caveat (mission-mandated surface)

Automations delivering over `sendblue` only land inside the 24h reply window
of Matt's last inbound. A rejected send logs `skipped_outside_reply_window`
on the automation (visible via `/api/automations` events and the Phase 11
manager panel) and is NOT retried; texting the brain re-opens the window.
Upgrading to Sendblue's AI Agent plan removes the limit — Matt's call, not
Fable's. Telegram delivery has no such window and is the default route.

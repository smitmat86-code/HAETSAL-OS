# Phase 4 Prod Deploy Readiness Memo

Date: 2026-07-03
Worker: `the-brain`

## What deploys
Sendblue iMessage channel on top of the Phase 3 state: the
`/webhooks/sendblue/:pathSecret` public route (path-secret + line checks; CF
Access bypass app for that path verified Phase 0), outbound client, grounded
reply loop, photo→R2→vision→capture flow, `sendblue_media` queue handling,
and the `/?phone=` self-registration addition to the root page. No wrangler
config changes; no new bindings; secrets already provisioned (Phase 0).

## Exposure delta
One new unauthenticated-by-CF-Access route: `POST /webhooks/sendblue/:pathSecret`
— mirrors the existing Telnyx/Telegram webhook exceptions (Law 1 exception
pattern), gated by a 64-hex bearer path segment compared in constant time,
line-number check, and sender allowlist (tenant_phone_numbers). Bad secret
returns 404. Unknown senders are dropped without reply.

## Rollback
- `npx wrangler rollback` to prior version `be33541d-9b1d-4f10-9035-49614f5268a4`
  (Phase 3 removal build) — no DO migration in this deploy, rollback is clean.
- After deploy, the Sendblue-side webhook registration points at this route;
  rollback does not require unregistering (the route 404s harmlessly if absent).

## Post-deploy steps
1. Register webhook: POST api.sendblue.co/api/account/webhooks with the
   path-secret URL; verify via GET /api/account/webhooks.
2. Live gate (requires Matt): register phone via /?phone=..., text the line
   (+16452067656), send a photo; verify capture rows + replies.

## Pre-deploy checks
- Full suite 66 files / 387 passed / 1 skipped; postflight clean (checkout).
- Dry-run build validated in Phase 3 config (no container surfaces).

## Hotfix addendum (same day)
First deploy (version 53f2fc72) failed the e2e smoke with Workers AI error
5028 — the chosen models were removed from the catalog 2026-05-30. Hotfix
commit 124e64a standardizes all chat/vision calls on
`@cf/google/gemma-4-26b-a4b-it` via `src/services/workers-ai-chat.ts` and
redeployed as version fe048559. Post-hotfix e2e smoke: text and photo flows
both return `processed`; only expected delivery failures to the fake test
number appear in logs (metadata only). Rollback target for the Phase 4 line
remains the Phase 3 build `be33541d` (the intermediate 53f2fc72 has dead
model references — do not roll back to it).

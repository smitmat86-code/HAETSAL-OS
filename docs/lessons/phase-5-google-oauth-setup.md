# Phase 5 — Google OAuth Setup (S5 stop) — what Matt needs to provision

Date: 2026-07-03

## Why this file exists (S5)
Phase 5 wires the real action executors. Three of them are fully live —
`act_search` (Brave), `act_draft` (note/plan → canonical), and
`act_send_message` (iMessage/Telegram/SMS). **Gmail is not**, because Google
OAuth is not provisioned this run. Per the mission this is stop condition **S5**:
the code fails *honestly* rather than working around it — `act_send_message`
with an email recipient and `act_draft` of `draft_type: 'email'` both throw
`GmailNotConnectedError` pointing here. Demo clause 1 (Gmail summary) and
clause 2 (Gmail draft→send) stay blocked until the steps below are done.

## What the code already expects
- Secrets the Worker will read once provisioned: `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET` (Cloudflare secrets, same as the other keys).
- Per-tenant OAuth tokens are stored **encrypted** and read via
  `getGoogleToken(tenantId, scope, tmk, env)` (`src/services/google/oauth.ts`);
  Calendar create/modify already use this path, so Gmail send/draft slot into
  the same mechanism once the app credentials + consent exist.
- Scopes needed: `gmail.send` and `gmail.compose` (send + draft),
  plus the already-used `gmail.readonly` and `calendar` for ingestion.

## Steps for Matt (Google Cloud Console)
1. Go to https://console.cloud.google.com → create (or pick) a project, e.g.
   "HAETSAL".
2. **APIs & Services → Enabled APIs → Enable**: Gmail API and Google Calendar
   API.
3. **OAuth consent screen**: User type = External; app name "HAETSAL"; add your
   own Google account as a **Test user** (keeps it in testing mode — no
   Google verification review needed for personal use). Add scopes:
   `.../auth/gmail.send`, `.../auth/gmail.compose`, `.../auth/gmail.readonly`,
   `.../auth/calendar`.
4. **Credentials → Create credentials → OAuth client ID**: Application type =
   Web application. Authorized redirect URI:
   `https://haetsalos.specialdarksystems.com/auth/google/callback`
   (matches the Worker's `/auth` route). Save the **Client ID** and
   **Client secret**.
5. Give me the two values (or set them yourself):
   `npx wrangler secret put GOOGLE_CLIENT_ID` and
   `npx wrangler secret put GOOGLE_CLIENT_SECRET` for worker `the-brain`.
6. One-time consent: open `https://haetsalos.specialdarksystems.com/auth/google`
   (CF Access authenticated) and approve. That stores the encrypted refresh
   token for your tenant; Gmail send/draft + Gmail/Calendar ingestion then
   work.

## Security notes
- Client secret is a Cloudflare secret — never printed in logs/commits (G2).
- Per-tenant refresh tokens are TMK-encrypted at rest, same as other content.
- Keeping the consent screen in "testing" with yourself as the only test user
  is the right call for a single-user product — no Google verification needed,
  and no one else can grant access.

## Until then
Everything non-Gmail in Phase 5 works. When you're ready to connect Gmail,
these six steps + the two secrets are all that's required; no code changes.

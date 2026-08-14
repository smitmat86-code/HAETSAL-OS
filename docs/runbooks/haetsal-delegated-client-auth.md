# HAETSAL delegated client authentication

Last verified: 2026-08-04 America/Los_Angeles

## Why this exists

Codex and Claude Code need unattended access to Matt's existing HAETSAL brain.
Their ordinary browser-OAuth refresh paths have not been reliable enough for a
global, always-available MCP. Each local app therefore has its own long-lived,
revocable Cloudflare Access service token.

HAETSAL delegates only the exact allowlisted service-token client IDs to
Matt's human subject. Unknown service identities remain isolated in their own
tenant, and human identities are never remapped.

## Components

- Cloudflare Access Service Auth policy: `Allow delegated HAETSAL clients`
- Worker secret: `CF_ACCESS_DELEGATED_PRINCIPALS`
- Worker secret: `CF_ACCESS_CLIENT_IDENTITIES` (non-secret provenance labels,
  keyed by the exact service-token client IDs)
- Windows user environment variables:
  - `HAETSAL_CODEX_CF_CLIENT_ID`
  - `HAETSAL_CODEX_CF_CLIENT_SECRET`
  - `HAETSAL_CLAUDE_CF_CLIENT_ID`
  - `HAETSAL_CLAUDE_CF_CLIENT_SECRET`
- Secret-free launcher: `C:\Users\matth\.haetsal\bin\haetsal-mcp-bridge.ps1`
- Global client configs in `C:\Users\matth\.codex\config.toml` and
  `C:\Users\matth\.claude.json`

The active tokens expire on 2031-08-03. Set a renewal reminder well before
that date.

## Rotation procedure

Rotate one client at a time:

1. Create a new Cloudflare Access service token with a clear per-client name.
2. Include it in the HAETSAL Service Auth policy.
3. Update the matching Windows user environment variables without printing or
   committing their values.
4. Update `CF_ACCESS_DELEGATED_PRINCIPALS` so the new exact client ID maps to
   Matt's existing subject; retain the other client's mapping.
5. Update `CF_ACCESS_CLIENT_IDENTITIES` so the same exact client ID maps to the
   approved `client_name` and `agent_identity`; retain the other client's entry.
6. Deploy the Worker.
7. Run the relevant repair script with `-Fix -Proof`.
8. After proof succeeds, revoke the old token and remove both old mappings.

Never put a service secret, human subject ID, or complete delegation map in
git, chat transcripts, logs, or screenshots.

## Failure behavior

Delegation fails closed. A missing or malformed delegation map, or an unknown
service-token client ID, cannot enter Matt's tenant. It resolves to an isolated
`service:<client-id>` identity instead.

The governed artifact tools also fail closed with
`client_identity_unavailable` when an authenticated service token has no exact
`CF_ACCESS_CLIENT_IDENTITIES` entry. The mapping supplies provenance only; it
does not grant or alter tenant delegation.

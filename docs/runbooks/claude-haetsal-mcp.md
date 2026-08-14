# Claude HAETSAL MCP availability runbook

Last verified: 2026-08-14 America/Los_Angeles

## Expected steady state

Claude Code has a user-scoped stdio MCP named `haetsal`. It launches:

```text
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\Users\matth\.haetsal\bin\haetsal-mcp-bridge.ps1 -Client claude
```

The launcher reads Claude's dedicated Cloudflare Access credentials from the
Windows user environment and passes them only to `mcp-remote`. The credentials
are not stored in `.claude.json` or in the launcher. HAETSAL explicitly maps
this service identity to Matt's existing brain tenant.

The current credential expires on 2031-08-03 unless it is revoked first.

## Quick check and repair

From this repo:

```powershell
powershell -ExecutionPolicy Bypass -File ".\scripts\repair-claude-haetsal-mcp.ps1" -Fix -Proof
```

The script verifies the launcher, pinned `mcp-remote`, credential presence,
user-scoped registration, connection status, and an actual `memory_stats` tool
call. It also installs the governed local artifact helper and proves
reserve/finalize/status discovery with Claude's credential. It never prints the
credentials.

## Governed local file capture

```powershell
powershell -NoProfile -File "$HOME\.haetsal\bin\haetsal-artifact-upload.ps1" -Client claude -FilePath "<exact-path>"
```

Claude Code inspects and extracts locally, uploads the original, uploads every
intentional derivative it creates, and finalizes the exact manifest with all
derivative IDs. It then checks every `artifact_intake_status` receipt and a
`search_memory` hit. Missing raw bytes or an omitted expected derivative is a
hard failure. Paths, filenames, raw bytes, temporary URLs, captions, and
extraction text must not enter D1, queues, or logs.

## Manual verification

```powershell
claude mcp get haetsal
claude -p "Use the haetsal memory_stats tool and return one line: SUCCESS followed by the capture count." --allowedTools "mcp__haetsal__memory_stats"
```

## If credentials are missing or revoked

Do not repeatedly run `claude mcp login haetsal`. Provision a replacement
Claude service token in Cloudflare, update the Windows user environment
variables, add the new client ID to `CF_ACCESS_DELEGATED_PRINCIPALS`, deploy,
and revoke the old token. See `haetsal-delegated-client-auth.md`.

Browser OAuth remains an explicit emergency fallback via the repair script's
`-Login` flag, but it is not the normal Claude Code configuration.

## Notes

- Restart Claude Code once after changing its user MCP registration. Future
  sessions inherit it automatically.
- A full `claude mcp list` can report unrelated MCP failures. Prefer
  `claude mcp get haetsal` for HAETSAL-specific diagnosis.

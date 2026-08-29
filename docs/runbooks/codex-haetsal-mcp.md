# Codex HAETSAL MCP availability runbook

Last verified: 2026-08-14 America/Los_Angeles

## Expected steady state

Codex uses a local stdio launcher, not browser OAuth:

```toml
[mcp_servers.haetsal]
command = "powershell.exe"
args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "C:\\Users\\matth\\.haetsal\\bin\\haetsal-mcp-bridge.ps1", "-Client", "codex"]
startup_timeout_sec = 120.0
```

The launcher reads the Codex-specific Cloudflare Access credentials from the
Windows user environment and passes them only to `mcp-remote`. Neither the
launcher nor the Codex config contains secrets. The service identity is
explicitly delegated by HAETSAL to Matt's existing brain tenant.

The current credential expires on 2031-08-03 unless it is revoked first.

## Quick check and repair

From this repo:

```powershell
powershell -ExecutionPolicy Bypass -File ".\scripts\repair-haetsal-mcp.ps1" -Fix -Proof
```

The script verifies:

- the secret-free launcher and pinned `mcp-remote` installation;
- the presence (never the values) of the two Codex credential variables;
- the global Codex bridge registration;
- a fresh Codex process can call `memory_stats`;
- the governed local artifact helper is installed byte-for-byte from the
  repository and discovers reserve/finalize/status with the Codex credential.

The stdio bridge does not consult Codex's legacy HTTP OAuth cache. A passing
proof begins with `SUCCESS`.

## Governed local file capture

Use the installed helper for one exact regular file. It performs reservation,
binary upload, and status polling without sending the body through MCP:

```powershell
powershell -NoProfile -File "$HOME\.haetsal\bin\haetsal-artifact-upload.ps1" -Client codex -FilePath "<exact-path>"
```

Codex inspects the file locally, uploads the original, uploads every
intentional derivative it creates, then calls `finalize_artifact_capture` with
the exact expected artifact count and derivative list. It verifies every
upload with `artifact_intake_status` and verifies the extraction with
`search_memory`. A derivative omission or unavailable raw byte path is a hard
failure. Paths, filenames, raw bytes, temporary URLs, captions, and extraction
text must not enter D1, queues, or logs.

## Manual verification

```powershell
codex mcp get haetsal
@'
Do not edit files. Use the global haetsal MCP server only. Call memory_stats and return one line: SUCCESS followed by the capture count.
'@ | codex exec -C 'C:\Users\matth\Documents\HAETSAL OS' --dangerously-bypass-approvals-and-sandbox -
```

## If credentials are missing or revoked

Do not repeatedly run `codex mcp login haetsal`. Provision a replacement
Codex service token in Cloudflare, update the Windows user environment
variables, add the new client ID to `CF_ACCESS_DELEGATED_PRINCIPALS`, deploy,
and revoke the old token. See `haetsal-delegated-client-auth.md`.

Browser OAuth remains an explicit emergency fallback via the repair script's
`-Login` flag, but it is not the normal Codex configuration. Codex's OAuth
refresh path has previously lost the RFC 8707 resource parameter and caused
frequent reauthentication.

## Other known startup issue

Do not add a hand-registered global `[mcp_servers.node_repl]`. Codex Desktop
loads its app/plugin Node REPL dynamically; an old global entry previously
blocked MCP startup.

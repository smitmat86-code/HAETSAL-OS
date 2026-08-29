# 10. Connecting your tools

> **In plain terms:** Any AI tool that speaks MCP can plug into the brain
> at one URL. The one rule that matters: **sign in as yourself** (the
> OAuth/browser flow) and the tool shares *your* memory; authenticate with
> a service token and it gets a *separate* machine identity with its own
> empty memory. Use OAuth for your tools, service tokens only for
> automation/CI.

**The endpoint (all clients):**
`https://haetsalos.specialdarksystems.com/mcp` — MCP over Streamable HTTP.

## Identity: the one thing to get right

Your tenant (= your brain, your encryption keys) is derived from the
authenticated identity (`src/middleware/auth.ts` — HKDF over the JWT
subject). Consequences:

| How a client authenticates | Whose memory it sees |
|---|---|
| OAuth / browser sign-in (your Google account) | **Yours** |
| CF Access service token (`CF-Access-Client-Id/Secret` headers) | Its own separate tenant — an empty brain |

So: **Claude Code, Codex, claude.ai — use the interactive sign-in.**
Service tokens are for smoke tests and headless automation. (If you ever
want a headless client writing into *your* brain, that's a small
identity-allowlist feature — ask for it rather than sharing tokens.)

## claude.ai (web/desktop/mobile)

Already set up as the `haetsal` connector. If tools stop appearing or
auth expires: claude.ai → Settings → Connectors → `haetsal` →
re-authenticate. Once connected, Claude on your phone can
`search_memory` the same brain you text from Telegram.

## Claude Code

```
claude mcp add --transport http brain https://haetsalos.specialdarksystems.com/mcp
```

Then in a session run `/mcp` and complete the browser sign-in when
prompted. Verify with: "search my memory for HAETSAL" — you should see
cited results. (Headless/CI use is the service-token case — separate
tenant, see above.)

## Codex CLI

Codex configures MCP servers in `~/.codex/config.toml`. If your Codex
build supports remote HTTP MCP servers natively, point it at the endpoint
URL and complete its auth flow. Otherwise use the `mcp-remote` bridge
(stdio→HTTP), which handles the OAuth dance in a browser:

```toml
[mcp_servers.brain]
command = "npx"
args = ["-y", "mcp-remote", "https://haetsalos.specialdarksystems.com/mcp"]
```

For a local file, use the installed `haetsal-artifact-upload.ps1` helper. It
streams one exact file directly to the governed upload endpoint and prints a
content-free receipt. The agent then supplies extraction plus the exact
manifest to `finalize_artifact_capture` and verifies every upload with
`artifact_intake_status`. If the helper cannot access the bytes, report
`raw_bytes_unavailable`; a `capture_memory` reference is not proof of retention.

ChatGPT uses the official hosted file descriptor with `capture_artifact_file`.
The temporary URL and file ID are download-only and are not persisted or
logged. HTTPS, redirects, resolved addresses, MIME, timeout, and byte limits
are validated before sealing. The same 25 MiB limit and stable errors apply.

## Anything else that speaks MCP

Same URL, same rule. Cursor, Windsurf, custom agents — if it supports
remote MCP servers (directly or via `mcp-remote`), it can read and write
the brain with the scoped tool surface: `capture_memory` to write,
`search_memory` + nine read tools ([chapter 9](09-reference.md)).

## What a connected tool can and cannot do

- It gets the **brain-memory surface only** — no action tools, no
  automation tools. A compromised or over-eager coding agent can't send
  messages or fire playbooks through your brain; that surface belongs to
  the interaction agent behind the approval gate.
- Its writes are stamped `external_client` authorship — see
  [chapter 11](11-working-with-claude-code.md) for exactly what gets
  saved (short version: only what's explicitly captured; there is no
  ambient collection).
- `capture_memory` stores durable meaning. Managed artifact tools additionally
  retain exact raw bytes and derivatives. These are complementary operations,
  not interchangeable claims.

## Service tokens (automation/CI only)

Create in Cloudflare Zero Trust → Access → Service Auth (one token per
consumer so revocation is granular; never commit them). Send as
`CF-Access-Client-Id` / `CF-Access-Client-Secret` headers. The repo's
smoke scripts (`scripts/mission-*.ts`) are the working reference — they
run against the dedicated smoke identity, which is why their test
captures never appear in your memory panel.

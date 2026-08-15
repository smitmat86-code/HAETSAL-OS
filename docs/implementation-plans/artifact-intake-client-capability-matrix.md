# Artifact intake client capability matrix

Proof date: 2026-08-15 America/Los_Angeles
Scope: Sessions 1-5 implementation state; production availability still requires the listed live proof

| Client | Live/source proof | Governed byte transport | Current truth | Gate |
|---|---|---|---|---|
| Codex Desktop/local | Session 3 deployed and independently verified. | Explicit path → authenticated local upload helper; bytes never enter MCP/model arguments. | Available through the managed upload/finalize/status lifecycle. | Session 5 regression suite must remain green. |
| Claude Code | Session 3 deployed and independently verified with a distinct delegated credential. | Same explicit-file helper and governed lifecycle. | Available through the managed upload/finalize/status lifecycle. | Session 5 regression suite must remain green. |
| ChatGPT developer-mode plugin | Session 4 deployed and independently verified; the descriptor retains the exact four OpenAI file fields below. | `capture_artifact_file` plus the strict hosted-file downloader. | Available through the managed upload/finalize/status lifecycle. | Session 5 regression suite must remain green. |
| Telegram Bot API | Official Bot API supplies `file_id`; `getFile` supplies a temporary path valid for at least one hour and downloadable up to 20 MiB. | KEK-encrypted opaque handoff → queue operation ID → fixed-origin fetch → TMK managed source → canonical finalization/status. | Session 5 implementation candidate; the legacy `telegram-media/*` write is removed. | Production deploy plus fresh real-image, redelivery, envelope, manifest, status, search, and one-reply proof. |
| Sendblue | Official docs identify `message_handle` as the unique message ID, expose authenticated `GET /api/v2/messages/{message_id}` with `media_url`, and state that inbound media URLs expire after 30 days. | Stable handle re-fetch when present; otherwise KEK-encrypted ephemeral URL handoff → strict hosted downloader → TMK managed source → canonical finalization/status. | Session 5 implementation candidate; the legacy `sendblue-media/*` write is removed. | Production deploy plus the equivalent fresh real-image and reconciliation proof. |
| Context-only clients | Contract inspection: no path, file parameter, or provider locator means HAETSAL cannot prove receipt of the original. | None. | Always `raw_bytes_unavailable`; searchable context alone may use non-artifact capture but cannot claim original retention. | N/A |

## ChatGPT descriptor proof

The frozen descriptor in `src/services/artifact-intake/schemas.ts` declares exactly:

```json
{
  "properties": {
    "download_url": { "type": "string" },
    "file_id": { "type": "string" },
    "mime_type": { "type": "string" },
    "file_name": { "type": "string" }
  },
  "required": ["download_url", "file_id"]
}
```

and `_meta["openai/fileParams"]` is `["file"]`. The contract test rejects any drift from those names or required fields.

## Evidence references

- OpenAI plugin reference, **Define file inputs**, fetched 2026-08-14: <https://developers.openai.com/plugins/reference#define-file-inputs>
- Telegram Bot API, **File / getFile**, fetched 2026-08-14: <https://core.telegram.org/bots/api#getfile>
- Sendblue, **Get a specific message**, fetched 2026-08-15: <https://docs.sendblue.com/api/resources/messages/methods/retrieve/>
- Sendblue, **Receiving messages**, fetched 2026-08-15: <https://docs.sendblue.com/getting-started/receiving-messages/>
- Local HAETSAL bridge evidence: `scripts/repair-haetsal-mcp.ps1`, `scripts/repair-claude-haetsal-mcp.ps1`, `docs/runbooks/codex-haetsal-mcp.md`, and `docs/runbooks/claude-haetsal-mcp.md`.
- Repository lifecycle evidence: `src/services/channel-media/`, `src/services/telegram-inbound.ts`, and `src/services/sendblue-inbound.ts`.

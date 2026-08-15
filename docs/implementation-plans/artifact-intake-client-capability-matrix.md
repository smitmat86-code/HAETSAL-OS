# Artifact intake client capability matrix

Proof date: 2026-08-15 America/Los_Angeles
Scope: Sessions 1-5 implementation state; production availability still requires the listed live proof

| Client | Live/source proof | Governed byte transport | Current truth | Gate |
|---|---|---|---|---|
| Codex Desktop/local | Session 3 deployed and independently verified. | Explicit path → authenticated local upload helper; bytes never enter MCP/model arguments. | Available through the managed upload/finalize/status lifecycle. | Session 5 regression suite must remain green. |
| Claude Code | Session 3 deployed and independently verified with a distinct delegated credential. | Same explicit-file helper and governed lifecycle. | Available through the managed upload/finalize/status lifecycle. | Session 5 regression suite must remain green. |
| ChatGPT developer-mode plugin | Session 4 deployed and independently verified; the descriptor retains the exact four OpenAI file fields below. | `capture_artifact_file` plus the strict hosted-file downloader. | Available through the managed upload/finalize/status lifecycle. | Session 5 regression suite must remain green. |
| Telegram Bot API | Official Bot API supplies `file_id`; `getFile` supplies a temporary path valid for at least one hour and downloadable up to 20 MiB. | KEK-encrypted opaque handoff → queue operation ID → fixed-origin fetch → TMK recovery/source → canonical finalization/status. | Session 5 concurrency correction `a00725a` is deployed in Worker version `207a36f4-fb0a-4a03-a326-9d1d23f0c0c2`; processing and delivery leases defer redelivery, delivery ambiguity becomes terminal unknown without resend, and in-flight canonical finalization cannot lose to expiry failure. The legacy `telegram-media/*` write remains removed. | Fresh real-image, redelivery, envelope, manifest, status, search, and one-reply proof remains pending. |
| Sendblue | Official docs identify `message_handle` as the unique message ID, expose authenticated message retrieval with `media_url`, and specify the `sb-signing-secret` webhook header. | Required signed webhook + stable handle → KEK-encrypted opaque handoff → authenticated exact sender/line/direction refetch → strict hosted downloader → TMK recovery/source → canonical finalization/status. | Session 5 concurrency correction `a00725a` is deployed in Worker version `207a36f4-fb0a-4a03-a326-9d1d23f0c0c2`; provider delivery is single-claim, stale completions are fenced, and reserved canonical finalization is recovery-pending. Temporary-URL acceptance remains removed, all authoritative binding fields remain mandatory, and the legacy `sendblue-media/*` write remains removed. | Fresh real-image and equivalent reconciliation proof remains pending. |
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
- Sendblue, **Webhooks / signing secret**, fetched 2026-08-15: <https://docs.sendblue.com/getting-started/webhooks/>
- Local HAETSAL bridge evidence: `scripts/repair-haetsal-mcp.ps1`, `scripts/repair-claude-haetsal-mcp.ps1`, `docs/runbooks/codex-haetsal-mcp.md`, and `docs/runbooks/claude-haetsal-mcp.md`.
- Repository lifecycle evidence: `src/services/channel-media/`, `src/services/telegram-inbound.ts`, and `src/services/sendblue-inbound.ts`.

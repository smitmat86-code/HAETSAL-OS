# Artifact intake client capability matrix

Proof date: 2026-08-14 America/Los_Angeles
Scope: Session 1 capability discovery, not an end-to-end artifact claim

| Client | Live/source proof | Available byte transport target | Session 1 truth | Required later session |
|---|---|---|---|---|
| Codex Desktop/local | `codex-cli 0.146.0`; a fresh `codex exec` read the explicit absolute `package.json` path and returned `CODEX_LOCAL_PATH_OK the-brain 0.0.0`. | Explicit path → authenticated local upload helper; bytes never enter MCP/model arguments. | Local path is available, but the helper/upload route is not. Return `raw_bytes_unavailable`; never turn path text into an artifact pointer. | Session 3 |
| Claude Code | `claude --version` returned `2.1.220`; `claude -p ... --allowedTools Read` read the same absolute path and returned `CLAUDE_LOCAL_PATH_OK the-brain 0.0.0`. | Same repository helper using Claude's distinct delegated credential. | Local path is available, but the helper/upload route is not. Return `raw_bytes_unavailable`. | Session 3 |
| ChatGPT developer-mode plugin | OpenAI's live plugin reference says each `_meta["openai/fileParams"]` top-level field resolves to a file object. All four properties must be declared: `download_url`, `file_id`, optional `mime_type`, optional `file_name`; only the first two are required. | `capture_artifact_file` with one top-level `file` parameter and a strict temporary-URL downloader. | The executable descriptor contract exists, but the registered tool/downloader does not. Return `raw_bytes_unavailable`. | Session 4 |
| Telegram Bot API | Official Bot API: update media supplies `file_id`; `getFile` returns a temporary `file_path` valid for at least one hour and downloadable up to 20 MB. Current `src/services/telegram-inbound.ts` performs that fetch, then writes raw bytes to `telegram-media/...`; `src/workers/ingestion/media-handlers.ts` later retains a reference. | Queue provider identifiers, then fetch/extract/seal/finalize through the common service. | Bytes are available, but the current raw-R2 path is not governed intake and is not counted as success. New contract reports unavailable until convergence; legacy behavior remains untouched in Session 1. | Session 5 |
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
- Local HAETSAL bridge evidence: `scripts/repair-haetsal-mcp.ps1`, `scripts/repair-claude-haetsal-mcp.ps1`, `docs/runbooks/codex-haetsal-mcp.md`, and `docs/runbooks/claude-haetsal-mcp.md`.
- Repository lifecycle evidence: `src/services/telegram-inbound.ts` and `src/workers/ingestion/media-handlers.ts`.

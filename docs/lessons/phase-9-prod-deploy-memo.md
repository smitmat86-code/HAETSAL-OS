# Phase 9 Prod Deploy Memo — Sessions Working Context

Date: 2026-07-04. Worker: `the-brain`. Rollback tag: `deploy-phase-9-prev`.
Deploy tag: `phase-9-complete`.

## Surface changes

- Channel replies now carry multi-turn conversation context: a TMK-encrypted
  working-session window per `<channel>:<peer>` on the tenant DO, injected
  into the grounded reply; exchanges recorded fire-and-forget so session
  bookkeeping can never break a reply.
- Idle sessions (30min) or 40-turn sessions close automatically into an
  EVIDENCE-grade canonical summary (source `session:<channel>`); raw turns
  never reach canonical. New DO SQLite tables `haetsal_session_messages` /
  `haetsal_sessions` (lazy DDL).
- Execution runs persist AES-GCM-encrypted structured reasoning traces to
  `R2_OBSERVABILITY:traces/<tenant>/exec-<runId>`.
- NEW CF-Access routes: `GET /api/session/:key/window`,
  `POST /api/session/:key/close`.
- `McpAgentDO.init()` tool registration extracted to `registerAllDoTools`
  (behavior-preserving; line limit).

## Declared As-Built deviation (mission §8 Phase 9)

The experimental SDK `Session`/`AgentSessionProvider` persists plaintext
message parts in DO SQLite and its compaction assumes readable rows — no
encryption hook. Adopting it directly would violate Law 2. The store is
HAETSAL-owned (ciphertext at rest); message shapes follow the SDK
`SessionMessage` contract as the drop-in seam for later full adoption.

## Smoke plan (demo clauses 3+4 mechanism)

`npx tsx scripts/mission-phase9-live-smoke.ts` — a fresh external MCP client
(Streamable HTTP JSON-RPC, the same protocol Claude Code and Codex speak)
against `/mcp`: initialize → `capture_memory` → `search_memory` (composed)
cites the write with provenance within 30s → session window + close
endpoints live. Matt's real Claude Code / Codex round-trip uses the identical
surface with his own CF Access identity.

## OUTCOME

- pending

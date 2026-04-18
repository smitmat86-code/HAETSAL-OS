# Context Snapshot: Hindsight Repair Review (HAETSAL OS)

## Task statement
Review the HAETSAL Hindsight repair direction with emphasis on architecture and sequencing. Incorporate Cloudflare best practices, and plan for eventual Graphiti + Hindsight (Fold-like) without derailing the immediate repair.

## Desired outcome
- A concrete architect-level review that answers:
  - Whether Graphiti belongs in the immediate repair lane or only as an architectural boundary.
  - Which Cloudflare best-practice changes should be bundled now vs deferred.
  - Critical missing risks in the current plan.
  - A concise architect verdict with sequencing guidance.

## Known facts / evidence (from prior discussion)
- Live integration is broken:
  - Encrypted payloads are sent to Hindsight.
  - Non-existent/fabricated `/api/retain` and `/api/recall` endpoints are used.
  - Container/service port is treated as `8080` (should be `8888` for Hindsight services).
  - Repo has split-brain behavior: some newer bootstrap/reflect paths already use real `/v1/default/banks/...` routes.
- Target direction is to rebuild around Hindsight v0.5 API and keep HAETSAL's MCP agent DO as the stable public surface.
- Cloudflare best practices should be applied where they reduce correctness risk (DO RPC, durable state patterns, Workflows for pipelines, websocket hibernation when relevant).
- Graphiti is desired eventually alongside Hindsight (Fold-style), likely as a temporal/graph capability rather than immediate duplication of retain/recall/reflect.

## Constraints
- Correctness-first: fix broken memory core before expanding scope.
- Avoid platform-wide rewrites that delay the Hindsight repair.
- Keep MCP tool surface stable where practical.

## Unknowns / open questions (to resolve via inspection)
- Exact call sites still using `/api/*` and encryption.
- Which Durable Objects currently use stub `.fetch()` vs direct method calls.
- How much session/agent state is in-memory only vs persisted.
- What Fold's local implementation uses for queue-backed retain and how closely to mirror it.

## Likely touchpoints
- Hindsight retain/recall/tenant paths, container config, tests.
- MCP agent DO entrypoints and any bootstrap/workflow integration.
- Docs under `C:\Users\matth\Documents\HAETSAL OS\docs`.


Task statement: Validate HAETSAL's Hindsight implementation, incorporate latest Cloudflare best practices, consider Fold's BrainMCP/MCP-agent pattern and future Graphiti coexistence, and produce an execution-ready direction.

Desired outcome:
- Confirm the real failures in the current Hindsight integration.
- Decide whether Cloudflare best-practice updates belong in the same effort.
- Decide whether Fold-style MCP-agent + future Graphiti compatibility should shape the repair now.
- Produce a concrete, implementation-ready repair plan.

Known facts / evidence:
- Official Hindsight docs validate the core reports: plaintext retain, bank-scoped v1 routes, first-class reflect, port 8888.
- Current HAETSAL live paths still use fabricated encrypted /api/retain and /api/recall contracts plus port 8080.
- Bootstrap/mental-model/reflect code already partially targets real v1 Hindsight routes.
- Tests and local stubs currently reinforce the wrong Hindsight contract.
- Fold uses BrainMCP/McpAgent as the public surface, queue-backed Hindsight retain, and Hindsight for active retain/recall/reflect.
- Fold does not yet run Graphiti as an active memory backend; Graphiti temporal capability is still planned.
- Cloudflare 2026 guidance favors DO RPC-style seams, durable state for correctness-critical session data, and keeping Workflows for long-running pipelines.

Constraints:
- Preserve user intent for a high-quality, fully working end state.
- Avoid broad architecture churn that delays the core Hindsight repair.
- Keep public MCP memory tools stable where reasonable.
- Respect current workspace instructions and avoid destructive changes.

Unknowns / open questions:
- Whether implementation should start immediately after planning or remain at architected-plan level.
- Which optional Hindsight config features (entity labels, per-operation LLM overrides) are cleanly supported in the official client/runtime.
- Whether WebSocket hibernation should be bundled into the same lane or deferred.

Likely codebase touchpoints:
- src/services/ingestion/retain.ts
- src/tools/recall.ts
- src/services/tenant.ts
- src/services/hindsight.ts
- src/types/hindsight.ts
- src/services/bootstrap/hindsight-config.ts
- src/cron/weekly-synthesis.ts
- src/workers/mcpagent/do/HindsightContainer.ts
- src/workers/mcpagent/do/McpAgent.ts
- vitest.config.ts
- tests/2.1-retain.test.ts

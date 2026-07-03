# Cloudflare Capability Review + Modernization Sweep — 2026-07-03

Consolidated from four research passes (Agents SDK primitives, core data+compute,
AI+adjacent products, and the Cloudflare blog) plus codebase audit. Knowledge
cutoff Jan 2026; reviewed against the platform as of 2026-07-03.

## Shipped in the sweep
- **Model registry** (`src/config/models.ts`) — single source of truth for every
  Workers AI model id + `RETIRED_MODELS`. Postflight `checkRetiredModels()`
  fails the build if a removed id appears in `src/` outside the registry. This
  is the guardrail that was missing when the 2026-05-30 removal reached prod.
- **Vectorize binding removed** from `wrangler.toml` (orphaned since Phase 2
  moved semantic retrieval to Neon pgvector). Index `brain-memory` may still
  exist in the account — delete at Phase 13.
- **Agents SDK 0.13.3 → 0.17.0** — clean bump (already on zod ^4 / ai ^6),
  removed 5 dead `@ts-expect-error` suppressors, fixed a KEK-fallback
  robustness bug. Deployed prod version `10d6df92`; rollback target
  `5f453bb3`. MCP + capture + 5/7 retrieval-mode smoke green.

## Framework decision: build on the Agents SDK, NOT Flue
The stack is now explicitly three layers: **runtime** (Agents SDK, where we
live) → **harness** (Pi / Project Think) → **framework** (Flue). Flue's value is
pre-built Slack/GitHub/Linear/Discord channels (we use Telegram/Sendblue/SMS —
none covered) and multi-cloud portability (a non-goal — we're CF-native). Its
attractive parts — durable execution and skill-markdown (`SKILL.md`) — are
first-class in the SDK we already use. **Reconsider Project Think
(`@cloudflare/think`) as a harness component at Phase 6** (it wraps the agentic
loop + context blocks + sessions + sub-agents); it is Preview, so 0.17.x
remains the stable base.

## LAW-2 CONFLICT — managed memory/RAG is NOT a drop-in for us
- **Agent Memory** (managed, private beta) and **AI Search** (managed hybrid
  RAG) both store content in Cloudflare-managed services where the platform
  sees plaintext. That **violates Law 2 (zero-knowledge)**. Our
  pgvector-via-Hyperdrive-inside-the-Worker + TMK-at-capture design is correct
  *because* of the zero-knowledge mandate. Do NOT migrate canonical memory to
  Agent Memory / AI Search. (AI Search could only ever serve genuinely public,
  non-tenant reference content — low priority.)

## Adopt now / by phase
| Item | When | Note |
|---|---|---|
| AI Gateway **spend limits** | Phase 11 | Maps to our existing `ai_cost_reset_at`; delegate cost enforcement to the gateway instead of custom D1 logic |
| **KV bulk reads** (`get([...])`) | opportunistic | session + KEK lookups read multiple keys/request |
| **Queues backlog metrics** (`env.QUEUE.metrics()`) | Phase 11 | observability for the 5 queues |
| **Rate Limiting binding** (GA) | Phase 13 | protect webhooks + AI Gateway proxy |
| **bge-reranker** after pgvector recall | Phase 12 | cheap retrieval-quality boost |
| Explicit **placement hint** to Neon region | Phase 13 | the cold-start latency we fought |
| **Workflows saga rollbacks** | Phase 5 | multi-step actions (send→calendar→notify) with compensation |
| **`waitForApproval`** (native) | Phase 5 | replaces the dead `execute_after` send-delay path |
| **`runFiber`/`stash`/`keepAlive`** | Phase 8 | consolidation loop survives DO eviction (today's bug class) |
| **`subAgent` facets + `runAgentTool({detached})`** | Phase 6 | native sub-agent spawn/cancel/progress |
| **Email channel** (own address) | Phase 12+ | NOT a Gmail-S5 workaround — distinct capability |
| **Voice** (`@cloudflare/voice`, all Workers-AI) | Phase 12+ | STT+TTS pipeline, no extra keys |
| **Kimi K2.7 / GLM-4.7-flash** model tiers | Phase 6 | trivial now that models live in the registry |
| **Cloudflare Images binding** | Phase 12 | could simplify the photo-capture R2 path |

## Models — currency confirmed
gemma-4-26b-a4b-it (chat/vision), bge-base-en-v1.5 (embedding), and
llama-3.3-70b-instruct-fp8-fast (deep) are all explicitly retained. No fires.
Current best-in-class if we tier up later: kimi-k2.7-code (agentic), glm-4.7-flash
(cheap), qwen3-embedding-0.6b (long-context embed), bge-reranker-base (rerank).

## Validations from CF's own engineering posts
Our proxy-Worker/AI-Gateway routing, DO-SQLite-over-D1 for per-user state, and
default-closed data access all match Cloudflare's internal patterns. Code Mode
(agent writes JS vs chatty tool calls) is a token-saving pattern to consider at
Phase 6.

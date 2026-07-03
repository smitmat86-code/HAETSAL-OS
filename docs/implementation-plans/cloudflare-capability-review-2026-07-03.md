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

## Privacy model & scope decisions (2026-07-03, Matt)

**Scope: single-user product.** HAETSAL is built and operated for one user (Matt
= sole tenant/operator). Get it excellent single-user first; only then decide
between (a) multi-user or (b) clone-the-setup per person (which keeps everyone
their own single-user operator and sidesteps multi-tenant crypto entirely).

**Vendor-blindness is explicitly NOT a goal for now — and is NOT achieved by the
current build.** As-built, the operator can read any tenant's data two ways:
(1) `canonical_chunks.chunk_text` (+ claims/facts) is **plaintext** in Neon and
the operator holds the DB credentials; (2) the TMK is `HKDF(key=CF_ACCESS_AUD,
salt='brain-tmk', info=jwtSub)` — both inputs are operator-known, so any user's
TMK is re-derivable and their R2 bodies are decryptable. True vendor-blindness
would require a user-held key the server never learns AND encrypted-at-rest
retrieval (which breaks server-side FTS/pgvector) — a dedicated redesign, not a
Phase-13 checkbox. Deferred until/unless the product goes multi-user.

**Encryption (Law 2) is two separable things:**
- **Part A — keep plaintext out of Worker logs / Analytics Engine / AI Gateway
  payloads.** Cheap, high-value hygiene against sprawl (AI Gateway would
  otherwise log every retrieved memory). **KEEP ALWAYS, regardless of scope.**
- **Part B — TMK-encrypt content at rest in R2/D1.** Defends a narrow case (a
  Cloudflare-storage breach that doesn't also capture Neon creds) while the same
  content is plaintext-searchable in Neon; it's the source of the TMK/KEK-in-KV
  complexity behind today's DO-eviction bug. Arguably over-built for single-user.
  **Decision: keep as-is for now** (not broken post-KEK-fix; it's the foundation
  for any future multi-user/vendor-blind path; ripping it out mid-mission is
  regression risk for mostly "less code"). **Re-evaluate "keep or simplify" at
  Phase 13** with the whole system in view. Modest argument to keep even
  single-user: no single vendor holds the complete plaintext picture (CF =
  ciphertext+metadata, Neon = searchable text).

## Validations from CF's own engineering posts
Our proxy-Worker/AI-Gateway routing, DO-SQLite-over-D1 for per-user state, and
default-closed data access all match Cloudflare's internal patterns. Code Mode
(agent writes JS vs chatty tool calls) is a token-saving pattern to consider at
Phase 6.

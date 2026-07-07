// src/config/models.ts
// Single source of truth for Workers AI model IDs. Every env.AI.run() model
// argument MUST come from a const here so that (a) a catalog deprecation is a
// one-line change, and (b) the postflight retired-model scan can enforce that
// no removed model ID lingers in runtime code.
//
// Catalog verified against Cloudflare Workers AI on 2026-07-03. The 2026-05-30
// removals (which broke prod when llama-3.1-8b + the 3.2 vision model were
// pulled) are listed in RETIRED_MODELS below and enforced by postflight.

// ── Active model roles ────────────────────────────────────────────────────────

/** Chat tier — grounded replies, routing, write-policy classification.
 *  Research-driven swap from gemma-4-26b-a4b-it (2026-07-06): reasoning
 *  models legitimately return empty responses when hidden <think> tokens
 *  exhaust max_tokens (documented across o-series, DeepSeek R1, Claude
 *  extended thinking, Gemini thinking — same class). Llama 3.3 70B Instruct
 *  FP8 Fast is standard instruction-tuned (not reasoning), supports function
 *  calling, 24K context, production-labeled on Workers AI. Same model as
 *  MODEL_DEEP by intent — the "cheap chat tier vs deep tier" distinction was
 *  a premature optimization; the research-faithful default is one reliable
 *  instruct model until measured need justifies tiering. */
export const MODEL_CHAT = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'

/** Vision tier — inbound photo description (data-URL image_url content part).
 *  FOLLOW-UP: research recommended llama-3.2-11b-vision-instruct but that
 *  model was retired 2026-05-30 (see RETIRED_MODELS). Gemma-4 remains here
 *  because (a) photo ingest rides waitUntil so latency isn't user-facing and
 *  (b) no measured empty-response failures on the vision path. Re-evaluate
 *  when a production-labeled vision-specialized replacement lands. */
export const MODEL_VISION = '@cf/google/gemma-4-26b-a4b-it'

/** Deep reasoning / synthesis — agent turns, consolidation passes, nightly
 *  dream cycle. Currently equals MODEL_CHAT; a reasoning-specialist swap
 *  (e.g., DeepSeek R1 on Workers AI) is a follow-up specifically for the
 *  dream cycle where the extra latency + <think> exhaustion risk are
 *  acceptable (batch, not user-facing). */
export const MODEL_DEEP = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'

/** Canonical embedding — 768-dim, matches the pgvector column width in Neon. */
export const MODEL_EMBEDDING = '@cf/baai/bge-base-en-v1.5'

// ── Retired models (Workers AI catalog removals, 2026-05-30) ──────────────────
// Any of these in a runtime env.AI.run() call fails in prod (AiGatewayError
// 5028). The postflight scan fails the build if any appears in src/ outside
// this file. Replacements: cheap→gemma-4/glm-4.7-flash, agentic→kimi-k2.6.
export const RETIRED_MODELS: readonly string[] = [
  '@cf/meta/llama-3-8b-instruct',
  '@cf/meta/llama-3-8b-instruct-awq',
  '@cf/meta/llama-3.1-8b-instruct',
  '@cf/meta/llama-3.1-8b-instruct-awq',
  '@cf/meta/llama-3.1-70b-instruct',
  '@cf/meta/llama-3.2-11b-vision-instruct',
  '@cf/meta/llama-2-7b-chat-int8',
  '@cf/meta/llama-2-7b-chat-fp16',
  '@cf/mistral/mistral-7b-instruct-v0.1',
  '@hf/mistral/mistral-7b-instruct-v0.2',
  '@hf/meta-llama/meta-llama-3-8b-instruct',
  '@hf/google/gemma-7b-it',
  '@cf/google/gemma-3-12b-it',
  '@hf/nousresearch/hermes-2-pro-mistral-7b',
  '@cf/microsoft/phi-2',
  '@cf/defog/sqlcoder-7b-2',
  '@cf/unum/uform-gen2-qwen-500m',
  '@cf/facebook/bart-large-cnn',
  '@cf/moonshotai/kimi-k2.5',
]

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

/** Cheap chat tier — grounded replies, routing, write-policy classification.
 *  gemma-4 also handles vision, so MODEL_VISION points at the same id. */
export const MODEL_CHAT = '@cf/google/gemma-4-26b-a4b-it'

/** Vision tier — inbound photo description (data-URL image_url content part). */
export const MODEL_VISION = '@cf/google/gemma-4-26b-a4b-it'

/** Deep reasoning / synthesis — agent turns, consolidation passes. Retained
 *  `-fast` variant (explicitly kept in the 2026-05-30 catalog refresh). */
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

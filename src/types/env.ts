// src/types/env.ts
// Manual Env extends Wrangler's generated binding shape; declare secrets here.

export interface Env extends Cloudflare.Env {
  // Secrets (from .dev.vars / Cloudflare secrets)
  CF_ACCESS_AUD: string
  CF_ACCESS_TEAM: string
  HMAC_SECRET: string
  TELNYX_PUBLIC_KEY: string
  TELEGRAM_BOT_TOKEN: string
  TELEGRAM_WEBHOOK_SECRET: string
  BRAVE_API_KEY: string
  HINDSIGHT_WEBHOOK_SECRET: string
  TELNYX_API_KEY: string
  NEON_CONNECTION_STRING: string
  CANONICAL_POSTGRES_CONNECTION_STRING?: string
  AI_GATEWAY_TOKEN: string

  // Optional local/runtime configuration not emitted by wrangler types.
  GRAPHITI_KUZU_PATH?: string
  CANONICAL_MEMORY_SHADOW_WRITES?: string
  GRAPHITI_API_URL?: string
  GRAPHITI_API_TOKEN?: string
}

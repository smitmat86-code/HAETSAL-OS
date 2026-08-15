// src/types/env.ts
// Manual Env extends Wrangler's generated binding shape; declare secrets here.

export interface Env extends Cloudflare.Env {
  // Secrets (from .dev.vars / Cloudflare secrets)
  CF_ACCESS_AUD: string
  CF_ACCESS_TEAM: string
  CF_ACCESS_DELEGATED_PRINCIPALS?: string
  CF_ACCESS_CLIENT_IDENTITIES?: string
  HMAC_SECRET: string
  TELNYX_PUBLIC_KEY: string
  TELEGRAM_BOT_TOKEN: string
  TELEGRAM_WEBHOOK_SECRET: string
  BRAVE_API_KEY: string
  TELNYX_API_KEY: string
  SENDBLUE_API_KEY_ID: string
  SENDBLUE_API_SECRET_KEY: string
  SENDBLUE_PHONE_NUMBER: string
  SENDBLUE_WEBHOOK_PATH_SECRET: string
  SENDBLUE_WEBHOOK_SIGNING_SECRET: string
  NEON_CONNECTION_STRING: string
  CANONICAL_POSTGRES_CONNECTION_STRING?: string
  AI_GATEWAY_TOKEN: string
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string

  // M4 ops-alert ingress: SELECT-only connection to the haetsal_health Neon
  // DB for the morning-brief freshness line (forerunner of Phase 4 haetsal_ro).
  HEALTH_SPINE_RO_URL?: string

  // Optional local/runtime configuration not emitted by wrangler types.
  CANONICAL_MEMORY_SHADOW_WRITES?: string
}

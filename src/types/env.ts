// src/types/env.ts
// Full Env interface — all wrangler.toml bindings + DO namespace
// Binding names match wrangler.toml exactly (verified against 1.1 As-Built)

export interface Env {
  // Container (Cloudflare Container — DO-backed, not Fetcher)
  HINDSIGHT: DurableObjectNamespace
  HINDSIGHT_WORKER: DurableObjectNamespace

  // D1
  D1_US: D1Database
  D1_EU: D1Database

  // R2
  R2_ARTIFACTS: R2Bucket
  R2_OBSERVABILITY: R2Bucket

  // KV
  KV_SESSION: KVNamespace

  // Queues
  QUEUE_HIGH: Queue
  QUEUE_NORMAL: Queue
  QUEUE_BULK: Queue
  QUEUE_DEAD: Queue
  QUEUE_ACTIONS: Queue

  // Vectorize + Analytics
  VECTORIZE: VectorizeIndex
  ANALYTICS: AnalyticsEngineDataset

  // AI + Browser
  AI: Ai
  BROWSER: Fetcher

  // Durable Objects
  MCPAGENT: DurableObjectNamespace

  // Workflows
  BOOTSTRAP_WORKFLOW: Workflow

  // Secrets (from .dev.vars / CF secrets)
  CF_ACCESS_AUD: string   // CF Access audience tag
  CF_ACCESS_TEAM: string  // CF Access team domain (for JWKs URL)
  HMAC_SECRET: string     // For action preference HMAC (Phase 1.3)
  TELNYX_PUBLIC_KEY: string // Ed25519 public key for SMS webhook signature verification
  TELEGRAM_BOT_TOKEN: string   // Bot API token from BotFather
  TELEGRAM_WEBHOOK_SECRET: string // Secret token for webhook validation
  BRAVE_API_KEY: string        // Brave Search API key for news headlines
  HINDSIGHT_WEBHOOK_SECRET: string // HMAC-SHA256 for Hindsight webhook validation
  WORKER_DOMAIN: string            // e.g. 'the-brain.workers.dev' — webhook registration (2.4a)
  TELNYX_API_KEY: string           // Telnyx v2 API key for sending SMS
  TELNYX_FROM_NUMBER: string       // Telnyx virtual number (e.g. +13236785761)
  NEON_CONNECTION_STRING: string   // Direct Neon Postgres URL for Hindsight container runtime
  AI_GATEWAY_ID: string            // Cloudflare AI Gateway id, e.g. 'haetsal-brain-gateway'
  AI_GATEWAY_ACCOUNT_ID: string    // Cloudflare account id for gateway compat URL
  AI_GATEWAY_TOKEN: string         // Cloudflare AI Gateway token (auth to gateway, BYOK stored upstream)
  HINDSIGHT_DEDICATED_WORKERS_ENABLED: string // 'true' to disable API internal worker and use dedicated Hindsight workers
  HINDSIGHT_DEDICATED_WORKER_COUNT: string    // Number of dedicated Hindsight worker container instances to keep available
  CANONICAL_MEMORY_SHADOW_WRITES?: string     // 'true' enables best-effort canonical shadow writes
  GRAPHITI_API_URL?: string                  // Trusted external Graphiti runtime base URL
  GRAPHITI_API_TOKEN?: string                // Optional bearer token for the Graphiti runtime
}

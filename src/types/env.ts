// src/types/env.ts
// Full Env interface — all wrangler.toml bindings + DO namespace
// Binding names match wrangler.toml exactly (verified against 1.1 As-Built)

export interface Env {
  // Container
  HINDSIGHT: Fetcher

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

  // Hyperdrive (used by Container — not directly by Worker)
  HYPERDRIVE: Hyperdrive

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
}

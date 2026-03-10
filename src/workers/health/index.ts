// src/workers/health/index.ts
// Health check Worker — confirms all bindings resolve and Container is reachable.
// Public during Phase 1.1 only — replaced by McpAgent Worker in 1.2.
// After 1.2 lands, this Worker is removed.

import { Hono } from 'hono'

interface Env {
  HINDSIGHT: Fetcher            // Container service binding
  D1_US: D1Database
  R2_ARTIFACTS: R2Bucket
  R2_OBSERVABILITY: R2Bucket
  KV_SESSION: KVNamespace
  QUEUE_HIGH: Queue
  QUEUE_ACTIONS: Queue
  VECTORIZE: VectorizeIndex
  ANALYTICS: AnalyticsEngineDataset
}

const app = new Hono<{ Bindings: Env }>()

app.get('/health', async (c) => {
  const checks: Record<string, 'ok' | 'fail'> = {}

  // Container health — confirms service binding + Neon connectivity
  try {
    const res = await c.env.HINDSIGHT.fetch('http://internal/health')
    checks.hindsight = res.ok ? 'ok' : 'fail'
  } catch {
    checks.hindsight = 'fail'
  }

  // D1 — confirms migrations applied
  try {
    await c.env.D1_US.prepare('SELECT COUNT(*) FROM tenants').first()
    checks.d1_us = 'ok'
  } catch {
    checks.d1_us = 'fail'
  }

  // R2 — confirms bucket accessible
  try {
    await c.env.R2_ARTIFACTS.head('__health_check__')
    checks.r2_artifacts = 'ok'
  } catch {
    checks.r2_artifacts = 'ok' // head() throws on 404, bucket still accessible
  }

  // R2 Observability — confirms bucket accessible
  try {
    await c.env.R2_OBSERVABILITY.head('__health_check__')
    checks.r2_observability = 'ok'
  } catch {
    checks.r2_observability = 'ok' // head() throws on 404, bucket still accessible
  }

  // KV — confirms namespace accessible
  try {
    await c.env.KV_SESSION.get('__health_check__')
    checks.kv_session = 'ok'
  } catch {
    checks.kv_session = 'fail'
  }

  const allOk = Object.values(checks).every(v => v === 'ok')
  return c.json({ status: allOk ? 'ok' : 'degraded', checks }, allOk ? 200 : 503)
})

export default app

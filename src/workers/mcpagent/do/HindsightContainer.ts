// src/workers/mcpagent/do/HindsightContainer.ts
// Cloudflare Container DO class for Hindsight memory engine.
// Hindsight API-only image + direct Neon Postgres + AI Gateway BYOK for Groq-backed LLMs.
// Hindsight serves its API on port 8888; use startAndWaitForPorts for cold-start safety.

import { Container } from '@cloudflare/containers'
import type { Env } from '../../../types/env'

const HINDSIGHT_PORT = 8888
const HINDSIGHT_WORKER_PORT = 8889
export const HINDSIGHT_PING_ENDPOINT = 'localhost/metrics'
export const HINDSIGHT_WORKER_PING_ENDPOINT = 'localhost/health'

function buildAIGatewayCompatUrl(env: Env): string {
  const accountId = env.AI_GATEWAY_ACCOUNT_ID.trim()
  const gatewayId = env.AI_GATEWAY_ID.trim()
  return `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/compat`
}

export function useDedicatedHindsightWorkers(env: Pick<Env, 'HINDSIGHT_DEDICATED_WORKERS_ENABLED'>): boolean {
  return env.HINDSIGHT_DEDICATED_WORKERS_ENABLED?.trim().toLowerCase() === 'true'
}

export function getDedicatedHindsightWorkerCount(
  env: Pick<Env, 'HINDSIGHT_DEDICATED_WORKER_COUNT'>,
): number {
  const parsed = Number.parseInt(env.HINDSIGHT_DEDICATED_WORKER_COUNT?.trim() ?? '0', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function buildSharedHindsightModelEnv(env: Env): Record<string, string> {
  const gatewayToken = env.AI_GATEWAY_TOKEN?.trim()
  if (!gatewayToken) {
    return {
      HINDSIGHT_API_EMBEDDINGS_PROVIDER: 'local',
      HINDSIGHT_API_RERANKER_PROVIDER: 'local',
      HINDSIGHT_API_LLM_PROVIDER: 'none',
      HINDSIGHT_API_LLM_MODEL: 'none',
    }
  }

  return {
    HINDSIGHT_API_LLM_PROVIDER: 'openai',
    HINDSIGHT_API_LLM_API_KEY: gatewayToken,
    HINDSIGHT_API_LLM_BASE_URL: buildAIGatewayCompatUrl(env),
    HINDSIGHT_API_LLM_MODEL: 'groq/openai/gpt-oss-20b',
    HINDSIGHT_API_EMBEDDINGS_PROVIDER: 'local',
    HINDSIGHT_API_REFLECT_LLM_PROVIDER: 'openai',
    HINDSIGHT_API_REFLECT_LLM_API_KEY: gatewayToken,
    HINDSIGHT_API_REFLECT_LLM_BASE_URL: buildAIGatewayCompatUrl(env),
    HINDSIGHT_API_REFLECT_LLM_MODEL: 'groq/openai/gpt-oss-120b',
    HINDSIGHT_API_RERANKER_PROVIDER: 'local',
  }
}

export function buildHindsightContainerEnv(env: Env): Record<string, string> {
  const databaseUrl = env.NEON_CONNECTION_STRING?.trim()
  if (!databaseUrl) {
    throw new Error('NEON_CONNECTION_STRING secret is required for Hindsight container mode')
  }
  return {
    HINDSIGHT_ENABLE_API: 'true',
    HINDSIGHT_ENABLE_CP: 'false',
    HINDSIGHT_API_HOST: '0.0.0.0',
    HINDSIGHT_API_PORT: String(HINDSIGHT_PORT),
    HINDSIGHT_API_DATABASE_URL: databaseUrl,
    HINDSIGHT_API_MIGRATION_DATABASE_URL: databaseUrl,
    HINDSIGHT_API_RUN_MIGRATIONS_ON_STARTUP: 'true',
    HINDSIGHT_API_WORKER_ENABLED: useDedicatedHindsightWorkers(env) ? 'false' : 'true',
    HINDSIGHT_API_WORKER_ID: 'haetsal-api-internal',
    HINDSIGHT_API_WORKER_POLL_INTERVAL_MS: '500',
    HINDSIGHT_API_WORKER_MAX_SLOTS: '4',
    HINDSIGHT_API_WORKER_CONSOLIDATION_MAX_SLOTS: '1',
    HINDSIGHT_API_LOG_LEVEL: 'debug',
    HINDSIGHT_API_LOG_FORMAT: 'json',
    HINDSIGHT_CP_DATAPLANE_API_URL: `http://localhost:${HINDSIGHT_PORT}`,
    ...buildSharedHindsightModelEnv(env),
  }
}

export function buildHindsightWorkerContainerEnv(env: Env, workerId: string): Record<string, string> {
  const databaseUrl = env.NEON_CONNECTION_STRING?.trim()
  if (!databaseUrl) {
    throw new Error('NEON_CONNECTION_STRING secret is required for Hindsight worker mode')
  }
  return {
    HINDSIGHT_ENABLE_API: 'false',
    HINDSIGHT_ENABLE_CP: 'false',
    HINDSIGHT_API_DATABASE_URL: databaseUrl,
    HINDSIGHT_API_MIGRATION_DATABASE_URL: databaseUrl,
    HINDSIGHT_API_RUN_MIGRATIONS_ON_STARTUP: 'false',
    HINDSIGHT_API_WORKER_ENABLED: 'true',
    HINDSIGHT_API_WORKER_ID: workerId,
    HINDSIGHT_API_WORKER_HTTP_PORT: String(HINDSIGHT_WORKER_PORT),
    HINDSIGHT_API_WORKER_POLL_INTERVAL_MS: '500',
    HINDSIGHT_API_WORKER_MAX_SLOTS: '4',
    HINDSIGHT_API_WORKER_CONSOLIDATION_MAX_SLOTS: '1',
    HINDSIGHT_API_LOG_LEVEL: 'debug',
    HINDSIGHT_API_LOG_FORMAT: 'json',
    ...buildSharedHindsightModelEnv(env),
  }
}

export class HindsightContainer extends Container<Env> {
  defaultPort = 8888
  requiredPorts = [8888]
  sleepAfter = '10m'
  enableInternet = true
  // Cloudflare's Container class health-checks this endpoint while waiting for readiness.
  // Hindsight exposes Prometheus metrics on the API port, but not a default /ping route.
  pingEndpoint = HINDSIGHT_PING_ENDPOINT

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx as DurableObjectState<{}>, env)
    this.envVars = buildHindsightContainerEnv(env)
  }

  override async fetch(request: Request): Promise<Response> {
    return this.containerFetch(request, HINDSIGHT_PORT)
  }

  override onError(error: unknown): void {
    console.error('Hindsight container error:', error)
  }
}

export class HindsightWorkerContainer extends Container<Env> {
  defaultPort = HINDSIGHT_WORKER_PORT
  requiredPorts = [HINDSIGHT_WORKER_PORT]
  sleepAfter = '10m'
  enableInternet = true
  pingEndpoint = HINDSIGHT_WORKER_PING_ENDPOINT
  entrypoint = ['hindsight-worker']

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx as DurableObjectState<{}>, env)
    const suffix = ctx.id.toString().slice(-12)
    this.envVars = buildHindsightWorkerContainerEnv(env, `haetsal-worker-${suffix}`)
  }

  override async fetch(request: Request): Promise<Response> {
    return this.containerFetch(request, HINDSIGHT_WORKER_PORT)
  }

  override onError(error: unknown): void {
    console.error('Hindsight worker container error:', error)
  }
}

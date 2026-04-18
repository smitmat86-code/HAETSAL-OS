import { describe, expect, it } from 'vitest'
import {
  buildHindsightWorkerContainerEnv,
  buildHindsightContainerEnv,
  HINDSIGHT_PING_ENDPOINT,
  HINDSIGHT_WORKER_PING_ENDPOINT,
} from '../src/workers/mcpagent/do/HindsightContainer'

describe('2.4b Hindsight Container Runtime', () => {
  it('builds API-only runtime env with direct Neon + AI Gateway compat URL', () => {
    const env = buildHindsightContainerEnv({
      NEON_CONNECTION_STRING: 'postgresql://neon.example/brain',
      AI_GATEWAY_ID: 'haetsal-brain-gateway',
      AI_GATEWAY_ACCOUNT_ID: 'acct123',
      AI_GATEWAY_TOKEN: 'cf-aig-token',
      HINDSIGHT_DEDICATED_WORKERS_ENABLED: 'true',
    } as any)

    expect(env.HINDSIGHT_API_DATABASE_URL).toBe('postgresql://neon.example/brain')
    expect(env.HINDSIGHT_API_LLM_PROVIDER).toBe('openai')
    expect(env.HINDSIGHT_API_LLM_API_KEY).toBe('cf-aig-token')
    expect(env.HINDSIGHT_API_LLM_BASE_URL).toBe(
      'https://gateway.ai.cloudflare.com/v1/acct123/haetsal-brain-gateway/compat',
    )
    expect(env.HINDSIGHT_API_LLM_MODEL).toBe('groq/openai/gpt-oss-20b')
    expect(env.HINDSIGHT_API_EMBEDDINGS_PROVIDER).toBe('local')
    expect(env.HINDSIGHT_API_RERANKER_PROVIDER).toBe('local')
    expect(env.HINDSIGHT_API_REFLECT_LLM_MODEL).toBe('groq/openai/gpt-oss-120b')
    expect(env.HINDSIGHT_API_WORKER_ENABLED).toBe('false')
    expect(env.HINDSIGHT_API_WORKER_ID).toBe('haetsal-api-internal')
    expect(env.HINDSIGHT_API_WORKER_POLL_INTERVAL_MS).toBe('500')
    expect(env.HINDSIGHT_API_WORKER_MAX_SLOTS).toBe('4')
    expect(env.HINDSIGHT_API_WORKER_CONSOLIDATION_MAX_SLOTS).toBe('1')
    expect(env.HINDSIGHT_API_LOG_LEVEL).toBe('debug')
    expect(env.HINDSIGHT_API_LOG_FORMAT).toBe('json')
    expect(env.HINDSIGHT_ENABLE_CP).toBe('false')
  })

  it('falls back to llm=none when AI gateway token is not configured yet', () => {
    const env = buildHindsightContainerEnv({
      NEON_CONNECTION_STRING: 'postgresql://neon.example/brain',
      AI_GATEWAY_ID: 'haetsal-brain-gateway',
      AI_GATEWAY_ACCOUNT_ID: 'acct123',
      AI_GATEWAY_TOKEN: '',
      HINDSIGHT_DEDICATED_WORKERS_ENABLED: 'true',
    } as any)

    expect(env.HINDSIGHT_API_LLM_PROVIDER).toBe('none')
    expect(env.HINDSIGHT_API_LLM_MODEL).toBe('none')
    expect(env.HINDSIGHT_API_EMBEDDINGS_PROVIDER).toBe('local')
    expect(env.HINDSIGHT_API_RERANKER_PROVIDER).toBe('local')
    expect(env.HINDSIGHT_API_LLM_API_KEY).toBeUndefined()
    expect(env.HINDSIGHT_API_DATABASE_URL).toBe('postgresql://neon.example/brain')
  })

  it('requires a direct Neon connection string', () => {
    expect(() => buildHindsightContainerEnv({
      NEON_CONNECTION_STRING: '',
      AI_GATEWAY_ID: 'haetsal-brain-gateway',
      AI_GATEWAY_ACCOUNT_ID: 'acct123',
      AI_GATEWAY_TOKEN: '',
      HINDSIGHT_DEDICATED_WORKERS_ENABLED: 'true',
    } as any)).toThrow(/NEON_CONNECTION_STRING/)
  })

  it('uses a real Hindsight readiness endpoint for container health checks', () => {
    expect(HINDSIGHT_PING_ENDPOINT).toBe('localhost/metrics')
  })

  it('builds dedicated worker runtime env with worker metrics port and worker id', () => {
    const env = buildHindsightWorkerContainerEnv({
      NEON_CONNECTION_STRING: 'postgresql://neon.example/brain',
      AI_GATEWAY_ID: 'haetsal-brain-gateway',
      AI_GATEWAY_ACCOUNT_ID: 'acct123',
      AI_GATEWAY_TOKEN: 'cf-aig-token',
    } as any, 'haetsal-worker-1')

    expect(env.HINDSIGHT_API_DATABASE_URL).toBe('postgresql://neon.example/brain')
    expect(env.HINDSIGHT_ENABLE_API).toBe('false')
    expect(env.HINDSIGHT_ENABLE_CP).toBe('false')
    expect(env.HINDSIGHT_API_RUN_MIGRATIONS_ON_STARTUP).toBe('false')
    expect(env.HINDSIGHT_API_WORKER_ENABLED).toBe('true')
    expect(env.HINDSIGHT_API_WORKER_ID).toBe('haetsal-worker-1')
    expect(env.HINDSIGHT_API_WORKER_HTTP_PORT).toBe('8889')
    expect(env.HINDSIGHT_API_LLM_MODEL).toBe('groq/openai/gpt-oss-20b')
    expect(HINDSIGHT_WORKER_PING_ENDPOINT).toBe('localhost/health')
  })
})

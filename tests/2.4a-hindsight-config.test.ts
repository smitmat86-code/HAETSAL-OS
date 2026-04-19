import { describe, expect, it, vi } from 'vitest'
import { configureHindsightBank, createMentalModels, ensureHindsightBankConfigured, registerConsolidationWebhook, MENTAL_MODEL_DOMAINS } from '../src/services/bootstrap/hindsight-config'
import { buildHindsightBankProvisioningSpec, computeHindsightConfigVersion } from '../src/services/bootstrap/hindsight-bank-spec'

function unwrapRequest(input: RequestInfo | URL, init?: RequestInit): Request {
  return input instanceof Request ? input : new Request(input.toString(), init)
}

function withHindsight(fetch: (request: Request) => Promise<Response>, extra: Record<string, unknown> = {}) {
  return { HINDSIGHT: { fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(unwrapRequest(input, init)) }, ...extra } as any
}

describe('2.4a Hindsight Configuration', () => {
  it('exports configureHindsightBank, createMentalModels, registerConsolidationWebhook', () => {
    expect(typeof configureHindsightBank).toBe('function')
    expect(typeof createMentalModels).toBe('function')
    expect(typeof registerConsolidationWebhook).toBe('function')
  })

  it('exports exactly 6 mental model domain IDs', () => {
    expect(MENTAL_MODEL_DOMAINS).toEqual(['career', 'health', 'relationships', 'learning', 'finance', 'general'])
  })

  it('mental model IDs match BaseAgent.open() pattern: mental-model-{domain}', () => {
    for (const domain of MENTAL_MODEL_DOMAINS) expect(`mental-model-${domain}`).toMatch(/^mental-model-[a-z]+$/)
  })

  it('createMentalModels handles 409 (already exists) gracefully', async () => {
    const mockEnv = withHindsight(async (request) => {
      if (request.method === 'GET') return new Response(JSON.stringify({ items: [] }))
      if (request.method === 'POST') return new Response('', { status: 409 })
      return new Response('', { status: 200 })
    })
    await expect(createMentalModels('test-bank', mockEnv)).resolves.toBeUndefined()
  })

  it('registerConsolidationWebhook skips if already registered', async () => {
    let postCalled = false
    const mockEnv = withHindsight(async (request) => {
      if (request.method === 'GET') {
        return new Response(JSON.stringify({ items: [{ url: 'https://brain.workers.dev/hindsight/webhook', enabled: true }] }))
      }
      postCalled = true
      return new Response('', { status: 201 })
    }, { WORKER_DOMAIN: 'brain.workers.dev', HINDSIGHT_WEBHOOK_SECRET: 'test-secret' })
    await registerConsolidationWebhook('test-bank', mockEnv)
    expect(postCalled).toBe(false)
  })

  it('registerConsolidationWebhook creates webhook when not registered', async () => {
    let postBody = ''
    const mockEnv = withHindsight(async (request) => {
      if (request.method === 'GET') return new Response(JSON.stringify({ items: [] }))
      postBody = await request.text()
      return new Response('', { status: 201 })
    }, { WORKER_DOMAIN: 'brain.workers.dev', HINDSIGHT_WEBHOOK_SECRET: 'test-secret' })
    await registerConsolidationWebhook('test-bank', mockEnv)
    const parsed = JSON.parse(postBody)
    expect(parsed.url).toBe('https://brain.workers.dev/hindsight/webhook')
    expect(parsed.event_types).toEqual(['consolidation.completed'])
    expect(parsed.secret).toBe('test-secret')
    expect(parsed.enabled).toBe(true)
  })

  it('configureHindsightBank sends observations_mission + retain_mission + enable_observations', async () => {
    let putBody = ''
    const mockEnv = withHindsight(async (request) => {
      putBody = await request.text()
      return new Response('', { status: 200 })
    })
    await configureHindsightBank('test-bank', mockEnv)
    const parsed = JSON.parse(putBody)
    expect(parsed.retain_mission).toBeDefined()
    expect(parsed.observations_mission).toBeDefined()
    expect(parsed.enable_observations).toBe(true)
  })

  it('webhook URL uses env.WORKER_DOMAIN, not hardcoded', async () => {
    let postBody = ''
    const mockEnv = withHindsight(async (request) => {
      if (request.method === 'GET') return new Response(JSON.stringify({ items: [] }))
      postBody = await request.text()
      return new Response('', { status: 201 })
    }, { WORKER_DOMAIN: 'custom-domain.example.com', HINDSIGHT_WEBHOOK_SECRET: 'secret' })
    await registerConsolidationWebhook('test-bank', mockEnv)
    const parsed = JSON.parse(postBody)
    expect(parsed.url).toContain('custom-domain.example.com')
    expect(parsed.url).not.toContain('the-brain.workers.dev')
  })

  it('mental model partial failure does not throw', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let callCount = 0
    const mockEnv = withHindsight(async (request) => {
      if (request.method === 'GET') return new Response(JSON.stringify({ items: [] }))
      if (request.method === 'POST') {
        callCount++
        if (callCount <= 3) return new Response('fail', { status: 500 })
        return new Response('', { status: 409 })
      }
      return new Response('', { status: 200 })
    })
    await expect(createMentalModels('test-bank', mockEnv)).resolves.toBeUndefined()
  })

  it('ensureHindsightBankConfigured skips when config hash already matches', async () => {
    let fetchCalls = 0
    const spec = buildHindsightBankProvisioningSpec('brain.workers.dev', 'test-secret')
    const configVersion = computeHindsightConfigVersion(spec)
    const mockEnv = withHindsight(async () => {
      fetchCalls++
      return new Response('', { status: 200 })
    }, {
      D1_US: {
        prepare: (sql: string) => ({
          bind: (...params: unknown[]) => ({
            first: async () => sql.includes('SELECT config_version') ? { config_version: configVersion } : null,
            run: async () => ({ success: true, meta: { changes: 1 }, params }),
          }),
        }),
      },
      WORKER_DOMAIN: 'brain.workers.dev',
      HINDSIGHT_WEBHOOK_SECRET: 'test-secret',
    })
    await ensureHindsightBankConfigured('test-bank', 'tenant-a', mockEnv)
    expect(fetchCalls).toBe(0)
  })
})

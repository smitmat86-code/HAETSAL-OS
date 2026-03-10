// tests/2.4a-hindsight-config.test.ts
// Hindsight bank config, mental models, and webhook registration (2.4a addendum)

import { describe, it, expect } from 'vitest'
import {
  configureHindsightBank, createMentalModels,
  registerConsolidationWebhook, MENTAL_MODEL_DOMAINS,
} from '../src/services/bootstrap/hindsight-config'

describe('2.4a Hindsight Configuration', () => {
  it('exports configureHindsightBank, createMentalModels, registerConsolidationWebhook', () => {
    expect(typeof configureHindsightBank).toBe('function')
    expect(typeof createMentalModels).toBe('function')
    expect(typeof registerConsolidationWebhook).toBe('function')
  })

  it('exports exactly 6 mental model domain IDs', () => {
    expect(MENTAL_MODEL_DOMAINS).toHaveLength(6)
    expect(MENTAL_MODEL_DOMAINS).toEqual([
      'career', 'health', 'relationships', 'learning', 'finance', 'general',
    ])
  })

  it('mental model IDs match BaseAgent.open() pattern: mental-model-{domain}', () => {
    for (const domain of MENTAL_MODEL_DOMAINS) {
      expect(`mental-model-${domain}`).toMatch(/^mental-model-[a-z]+$/)
    }
  })

  it('createMentalModels handles 409 (already exists) gracefully', async () => {
    // Stub HINDSIGHT to return 409 for all POST requests
    const mockEnv = {
      HINDSIGHT: {
        fetch: async (_url: string, opts?: RequestInit) => {
          if (opts?.method === 'POST') return new Response('', { status: 409 })
          return new Response('', { status: 200 })
        },
      },
    } as any // eslint-disable-line @typescript-eslint/no-explicit-any
    // Should not throw — 409 is idempotent success
    await expect(createMentalModels('test-bank', mockEnv)).resolves.toBeUndefined()
  })

  it('registerConsolidationWebhook skips if already registered', async () => {
    let postCalled = false
    const mockEnv = {
      HINDSIGHT: {
        fetch: async (url: string, opts?: RequestInit) => {
          if (!opts?.method || opts.method === 'GET') {
            return new Response(JSON.stringify({
              items: [{ url: 'https://brain.workers.dev/hindsight/webhook', enabled: true }],
            }))
          }
          postCalled = true
          return new Response('', { status: 201 })
        },
      },
    } as any // eslint-disable-line @typescript-eslint/no-explicit-any
    await registerConsolidationWebhook('test-bank', mockEnv)
    expect(postCalled).toBe(false) // should skip POST
  })

  it('registerConsolidationWebhook creates webhook when not registered', async () => {
    let postBody: string | undefined
    const mockEnv = {
      HINDSIGHT: {
        fetch: async (_url: string, opts?: RequestInit) => {
          if (!opts?.method || opts.method === 'GET') {
            return new Response(JSON.stringify({ items: [] }))
          }
          postBody = opts.body as string
          return new Response('', { status: 201 })
        },
      },
      WORKER_DOMAIN: 'brain.workers.dev',
      HINDSIGHT_WEBHOOK_SECRET: 'test-secret',
    } as any // eslint-disable-line @typescript-eslint/no-explicit-any
    await registerConsolidationWebhook('test-bank', mockEnv)
    expect(postBody).toBeDefined()
    const parsed = JSON.parse(postBody!)
    expect(parsed.url).toBe('https://brain.workers.dev/hindsight/webhook')
    expect(parsed.event_types).toEqual(['consolidation.completed'])
    expect(parsed.secret).toBe('test-secret')
    expect(parsed.enabled).toBe(true)
  })

  it('configureHindsightBank sends observations_mission + retain_mission + enable_observations', async () => {
    let putBody: string | undefined
    const mockEnv = {
      HINDSIGHT: {
        fetch: async (_url: string, opts?: RequestInit) => {
          putBody = opts?.body as string
          return new Response('', { status: 200 })
        },
      },
    } as any // eslint-disable-line @typescript-eslint/no-explicit-any
    await configureHindsightBank('test-bank', mockEnv)
    expect(putBody).toBeDefined()
    const parsed = JSON.parse(putBody!)
    expect(parsed.retain_mission).toBeDefined()
    expect(parsed.observations_mission).toBeDefined()
    expect(parsed.enable_observations).toBe(true)
  })

  it('webhook URL uses env.WORKER_DOMAIN, not hardcoded', async () => {
    let postBody: string | undefined
    const mockEnv = {
      HINDSIGHT: {
        fetch: async (_url: string, opts?: RequestInit) => {
          if (!opts?.method || opts.method === 'GET') {
            return new Response(JSON.stringify({ items: [] }))
          }
          postBody = opts.body as string
          return new Response('', { status: 201 })
        },
      },
      WORKER_DOMAIN: 'custom-domain.example.com',
      HINDSIGHT_WEBHOOK_SECRET: 'secret',
    } as any // eslint-disable-line @typescript-eslint/no-explicit-any
    await registerConsolidationWebhook('test-bank', mockEnv)
    const parsed = JSON.parse(postBody!)
    expect(parsed.url).toContain('custom-domain.example.com')
    expect(parsed.url).not.toContain('the-brain.workers.dev')
  })

  it('mental model partial failure does not throw', async () => {
    let callCount = 0
    const mockEnv = {
      HINDSIGHT: {
        fetch: async (_url: string, opts?: RequestInit) => {
          if (opts?.method === 'POST') {
            callCount++
            // Fail 3 of 6, succeed (409) for the rest
            if (callCount <= 3) return new Response('fail', { status: 500 })
            return new Response('', { status: 409 })
          }
          return new Response('', { status: 200 })
        },
      },
    } as any // eslint-disable-line @typescript-eslint/no-explicit-any
    // Should not throw — Promise.allSettled handles partial failures
    await expect(createMentalModels('test-bank', mockEnv)).resolves.toBeUndefined()
  })
})

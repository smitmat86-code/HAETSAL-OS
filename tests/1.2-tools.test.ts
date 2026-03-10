// tests/1.2-tools.test.ts
// Tool integration tests
// Verifies retain/recall return correct schema shapes
// Updated in Phase 2.1: retainStub → retainViaService (real pipeline)

import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { retainViaService } from '../src/tools/retain'
import { recallStub } from '../src/tools/recall'

describe('1.2 Tools — brain_v1_retain', () => {

  it('returns deferred status when TMK is null', async () => {
    const result = await retainViaService(
      { content: 'Test memory content for retention', domain: 'career', memory_type: 'episodic' },
      'test-tenant',
      null, // No TMK — should return deferred
      env,
    )
    expect(result.status).toBe('deferred')
    expect(result.memory_id).toBe('')
  })

  it('returns correct schema shape', async () => {
    const result = await retainViaService(
      { content: 'Short content' },
      'test-tenant',
      null,
      env,
    )
    expect(result).toHaveProperty('memory_id')
    expect(result).toHaveProperty('salience_tier')
    expect(result).toHaveProperty('status')
  })
})

describe('1.2 Tools — brain_v1_recall stub', () => {

  it('returns correct schema with results and synthesis', async () => {
    const result = await recallStub({
      query: 'What did I learn about TypeScript?',
      domain: 'career',
    })
    expect(result.results).toBeInstanceOf(Array)
    expect(result.results.length).toBeGreaterThanOrEqual(1)
    expect(result.results[0]).toHaveProperty('memory_id')
    expect(result.results[0]).toHaveProperty('content')
    expect(result.results[0]).toHaveProperty('memory_type')
    expect(result.results[0]).toHaveProperty('confidence')
    expect(result.results[0]).toHaveProperty('relevance')
    expect(result.synthesis).toBeTruthy()
  })

  it('synthesis indicates stub status', async () => {
    const result = await recallStub({ query: 'test' })
    expect(result.synthesis).toContain('Stub')
  })
})

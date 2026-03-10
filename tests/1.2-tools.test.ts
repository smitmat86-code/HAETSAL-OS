// tests/1.2-tools.test.ts
// Tool stub integration tests
// Verifies retain/recall stubs return correct schema shapes

import { describe, it, expect } from 'vitest'
import { retainStub } from '../src/tools/retain'
import { recallStub } from '../src/tools/recall'

describe('1.2 Tools — brain_v1_retain stub', () => {

  it('returns correct schema with memory_id and salience_tier', async () => {
    const result = await retainStub({
      content: 'Test memory content for retention',
      domain: 'career',
      memory_type: 'episodic',
    })
    expect(result.memory_id).toBeTruthy()
    expect(result.memory_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    expect(result.salience_tier).toBeGreaterThanOrEqual(1)
    expect(result.status).toBe('retained')
  })

  it('assigns higher salience to longer content', async () => {
    const short = await retainStub({ content: 'Short' })
    const long = await retainStub({ content: 'A'.repeat(600) })
    expect(long.salience_tier).toBeGreaterThanOrEqual(short.salience_tier)
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

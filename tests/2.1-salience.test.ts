// tests/2.1-salience.test.ts
// Salience scoring tests: tier classification + queue routing

import { describe, it, expect } from 'vitest'
import { scoreSalience } from '../src/services/ingestion/salience'
import type { IngestionArtifact } from '../src/types/ingestion'

function makeArtifact(overrides: Partial<IngestionArtifact> = {}): IngestionArtifact {
  return {
    tenantId: 'test-tenant',
    source: 'sms',
    content: 'Hello world',
    occurredAt: Date.now(),
    ...overrides,
  }
}

describe('salience scoring', () => {
  it('classifies explicit retain (mcp_retain) as Tier 3', () => {
    const result = scoreSalience(makeArtifact({ source: 'mcp_retain', content: 'remember this' }))
    expect(result.tier).toBe(3)
    expect(result.queue).toBe('QUEUE_HIGH')
    expect(result.reasons).toContain('explicit_retain')
  })

  it('classifies self-SMS as Tier 3', () => {
    const result = scoreSalience(makeArtifact({
      source: 'sms', provenance: 'self_sms', content: 'note to self',
    }))
    expect(result.tier).toBe(3)
    expect(result.queue).toBe('QUEUE_HIGH')
    expect(result.reasons).toContain('self_sms')
  })

  it('classifies decision language with date as Tier 3', () => {
    const result = scoreSalience(makeArtifact({
      content: 'I decided to accept the offer by 03/15/2026. Must respond soon.',
    }))
    expect(result.tier).toBe(3)
    expect(result.queue).toBe('QUEUE_HIGH')
  })

  it('classifies named person with context as Tier 2', () => {
    const result = scoreSalience(makeArtifact({
      content: 'Had a meeting with John Smith about the project timeline.',
    }))
    expect(result.tier).toBe(2)
    expect(result.queue).toBe('QUEUE_HIGH')
  })

  it('classifies financial content as Tier 2', () => {
    const result = scoreSalience(makeArtifact({
      content: 'The new salary offer is $150,000 per year.',
    }))
    expect(result.tier).toBe(2)
    expect(result.queue).toBe('QUEUE_HIGH')
  })

  it('classifies SMS from known contact as Tier 2', () => {
    const result = scoreSalience(makeArtifact({
      source: 'sms', content: 'ok sounds good',
    }))
    expect(result.tier).toBe(2)
    expect(result.queue).toBe('QUEUE_HIGH')
    expect(result.reasons).toContain('known_contact_sms')
  })

  it('classifies routine content (no entities, no decisions) as Tier 1', () => {
    const result = scoreSalience(makeArtifact({
      source: 'file', content: 'picked up groceries from the store today',
    }))
    expect(result.tier).toBe(1)
    expect(result.queue).toBe('QUEUE_NORMAL')
    expect(result.reasons).toContain('routine')
  })

  it('routes Tier 2+ to QUEUE_HIGH and Tier 1 to QUEUE_NORMAL', () => {
    const tier3 = scoreSalience(makeArtifact({ source: 'mcp_retain', content: 'x' }))
    const tier2 = scoreSalience(makeArtifact({ content: 'Meeting with Jane Doe about contract.' }))
    const tier1 = scoreSalience(makeArtifact({ source: 'file', content: 'plain text file content' }))

    expect(tier3.queue).toBe('QUEUE_HIGH')
    expect(tier2.queue).toBe('QUEUE_HIGH')
    expect(tier1.queue).toBe('QUEUE_NORMAL')
  })

  it('surprise score is stub 0.5 for all content', () => {
    const result = scoreSalience(makeArtifact({ content: 'any content' }))
    expect(result.surpriseScore).toBe(0.5)
  })
})

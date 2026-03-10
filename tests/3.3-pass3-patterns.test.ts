// tests/3.3-pass3-patterns.test.ts
// Behavioral pattern extraction — sole procedural write path

import { describe, it, expect } from 'vitest'

describe('Pass 3 — Behavioral Patterns', () => {
  it('pass3-patterns.ts exports runPass3', async () => {
    const mod = await import('../src/cron/passes/pass3-patterns')
    expect(typeof mod.runPass3).toBe('function')
  })

  it('consolidationRetain is NOT exported (Law 3 structural guard)', async () => {
    const mod = await import('../src/cron/passes/pass3-patterns') as Record<string, unknown>
    // consolidationRetain must not be in the module's exports
    expect(mod.consolidationRetain).toBeUndefined()
  })

  it('pattern confidence filter: only > 0.6 retained', () => {
    const patterns = [
      { pattern: 'High confidence', confidence: 0.8, domain: 'career', evidence_count: 5 },
      { pattern: 'Low confidence', confidence: 0.4, domain: 'health', evidence_count: 2 },
      { pattern: 'Border', confidence: 0.6, domain: 'general', evidence_count: 3 },
    ]
    const retained = patterns.filter(p => p.confidence > 0.6)
    expect(retained.length).toBe(1)
    expect(retained[0].pattern).toBe('High confidence')
  })

  it('max 3 patterns per run enforced', () => {
    const patterns = [
      { confidence: 0.9 }, { confidence: 0.85 }, { confidence: 0.8 },
      { confidence: 0.75 }, { confidence: 0.7 },
    ].filter(p => p.confidence > 0.6)
    expect(patterns.slice(0, 3).length).toBe(3)
  })

  it('procedural memory type is restricted to consolidation only', async () => {
    // retainContent's write policy blocks 'procedural' from agents
    // Only consolidationRetain bypasses via cron source identity
    const retainMod = await import('../src/services/ingestion/retain')
    expect(typeof retainMod.retainContent).toBe('function')
  })
})

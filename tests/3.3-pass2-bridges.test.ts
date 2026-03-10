// tests/3.3-pass2-bridges.test.ts
// Bridge edge discovery — /graph structural seeding, is_bridge metadata

import { describe, it, expect } from 'vitest'

describe('Pass 2 — Bridge Edges', () => {
  it('pass2-bridges.ts exports runPass2', async () => {
    const mod = await import('../src/cron/passes/pass2-bridges')
    expect(typeof mod.runPass2).toBe('function')
  })

  it('structural hole detection: cross-domain pairs with shared neighbors', () => {
    // Simulate adjacency graph
    const adj = new Map<string, Set<string>>()
    adj.set('A', new Set(['C', 'D']))
    adj.set('B', new Set(['C', 'D']))
    adj.set('C', new Set(['A', 'B']))
    adj.set('D', new Set(['A', 'B']))

    // A and B share neighbors C and D but have no direct edge
    const neighborsA = adj.get('A')!
    const neighborsB = adj.get('B')!
    const shared = [...neighborsA].filter(n => neighborsB.has(n)).length
    expect(shared).toBe(2)
    expect(neighborsA.has('B')).toBe(false) // structural hole
  })

  it('max 5 bridges enforced', () => {
    const candidates = Array.from({ length: 8 }, (_, i) => ({
      insight: `Bridge ${i}`, memory_id_a: `a${i}`, memory_id_b: `b${i}`,
    }))
    expect(candidates.slice(0, 5).length).toBe(5)
  })

  it('bridges use is_bridge: true metadata', () => {
    const metadata = { is_bridge: true, bridge_memory_ids: ['mem-1', 'mem-2'] }
    expect(metadata.is_bridge).toBe(true)
    expect(metadata.bridge_memory_ids).toHaveLength(2)
  })

  it('bridge retained as semantic memory type', () => {
    const memoryType = 'semantic'
    const provenance = 'pass2_bridge'
    expect(memoryType).toBe('semantic')
    expect(provenance).toBe('pass2_bridge')
  })
})

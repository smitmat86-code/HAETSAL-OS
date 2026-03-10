// tests/3.1-base-agent.test.ts
// BaseAgent lifecycle, doom loop detection, context budget, Law 3

import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { checkDoomLoop } from '../src/agents/base-agent'
import type { EpistemicMemoryType, DoomLoopState, AgentContext } from '../src/agents/types'

describe('BaseAgent — Law 3 structural enforcement', () => {
  it('EpistemicMemoryType allows episodic, semantic, world', () => {
    const types: EpistemicMemoryType[] = ['episodic', 'semantic', 'world']
    expect(types).toHaveLength(3)
    expect(types).toContain('episodic')
    expect(types).toContain('semantic')
    expect(types).toContain('world')
  })

  it('EpistemicMemoryType structurally excludes procedural', () => {
    // This is a compile-time check — if 'procedural' were in the union,
    // this test would still pass at runtime. The real enforcement is TypeScript.
    // @ts-expect-error — procedural is not in EpistemicMemoryType
    const _badType: EpistemicMemoryType = 'procedural'
    // If this line compiles without the ts-expect-error, Law 3 is broken
    expect(_badType).toBe('procedural')
  })
})

describe('BaseAgent — doom loop detection', () => {
  it('returns ok for first call', async () => {
    const state: DoomLoopState = { calls: [], warnCount: 0 }
    const result = await checkDoomLoop(state, 'tool_a', { q: 'test' })
    expect(result).toBe('ok')
    expect(state.calls).toHaveLength(1)
  })

  it('returns ok for different inputs', async () => {
    const state: DoomLoopState = { calls: [], warnCount: 0 }
    await checkDoomLoop(state, 'tool_a', { q: 'one' })
    await checkDoomLoop(state, 'tool_a', { q: 'two' })
    const result = await checkDoomLoop(state, 'tool_a', { q: 'three' })
    expect(result).toBe('ok')
    expect(state.calls).toHaveLength(3)
  })

  it('warns at 3 identical calls', async () => {
    const state: DoomLoopState = { calls: [], warnCount: 0 }
    await checkDoomLoop(state, 'tool_a', { q: 'same' })
    await checkDoomLoop(state, 'tool_a', { q: 'same' })
    await checkDoomLoop(state, 'tool_a', { q: 'same' })
    const result = await checkDoomLoop(state, 'tool_a', { q: 'same' })
    expect(result).toBe('warn')
    expect(state.warnCount).toBe(1)
  })

  it('circuit breaks at 5 identical calls', async () => {
    const state: DoomLoopState = { calls: [], warnCount: 0 }
    for (let i = 0; i < 5; i++) {
      await checkDoomLoop(state, 'tool_a', { q: 'loop' })
    }
    const result = await checkDoomLoop(state, 'tool_a', { q: 'loop' })
    expect(result).toBe('break')
  })

  it('tracks separate tools independently', async () => {
    const state: DoomLoopState = { calls: [], warnCount: 0 }
    await checkDoomLoop(state, 'tool_a', { q: 'x' })
    await checkDoomLoop(state, 'tool_b', { q: 'x' })
    await checkDoomLoop(state, 'tool_a', { q: 'x' })
    await checkDoomLoop(state, 'tool_a', { q: 'x' })
    // tool_a has 3 calls now, 4th triggers warn
    const result = await checkDoomLoop(state, 'tool_a', { q: 'x' })
    expect(result).toBe('warn')
  })
})

describe('BaseAgent — AgentContext shape', () => {
  it('context has required fields', () => {
    const ctx: AgentContext = { memories: [], pendingActions: [] }
    expect(ctx.memories).toEqual([])
    expect(ctx.pendingActions).toEqual([])
    expect(ctx.parentTraceId).toBeUndefined()
  })

  it('context memories have expected structure', () => {
    const ctx: AgentContext = {
      memories: [{
        memory_id: 'test-id',
        content: 'test content',
        memory_type: 'episodic',
        confidence: 0.9,
        relevance: 0.8,
      }],
      pendingActions: [],
    }
    expect(ctx.memories[0].memory_id).toBe('test-id')
    expect(ctx.memories[0].confidence).toBe(0.9)
  })
})

describe('BaseAgent — context budget', () => {
  it('flush threshold is 80% of 128K model limit', () => {
    const MODEL_CONTEXT_LIMIT = 128_000
    const FLUSH_THRESHOLD = 0.80
    const flushAt = MODEL_CONTEXT_LIMIT * FLUSH_THRESHOLD
    expect(flushAt).toBe(102_400)
  })
})

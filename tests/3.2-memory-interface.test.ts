// tests/3.2-memory-interface.test.ts
// memory_search + memory_write MCP tools — available in all sessions

import { describe, it, expect } from 'vitest'
import { z } from 'zod'

describe('memory_write — Zod schema enforcement', () => {
  const writeSchema = z.object({
    content: z.string(),
    memory_type: z.enum(['episodic', 'semantic']),
    domain: z.string().optional(),
  })

  it('accepts episodic memory type', () => {
    const result = writeSchema.safeParse({
      content: 'Had a productive meeting',
      memory_type: 'episodic',
    })
    expect(result.success).toBe(true)
  })

  it('accepts semantic memory type', () => {
    const result = writeSchema.safeParse({
      content: 'Career goal: become staff engineer',
      memory_type: 'semantic',
      domain: 'career',
    })
    expect(result.success).toBe(true)
  })

  it('rejects procedural memory type — Law 3', () => {
    const result = writeSchema.safeParse({
      content: 'Always prefers morning meetings',
      memory_type: 'procedural',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].code).toBe('invalid_enum_value')
    }
  })

  it('rejects world memory type — ingestion-only', () => {
    const result = writeSchema.safeParse({
      content: 'The stock market rose 2% today',
      memory_type: 'world',
    })
    expect(result.success).toBe(false)
  })

  it('requires content field', () => {
    const result = writeSchema.safeParse({
      memory_type: 'episodic',
    })
    expect(result.success).toBe(false)
  })
})

describe('memory_search — schema', () => {
  const searchSchema = z.object({
    query: z.string(),
    domain: z.string().optional(),
    limit: z.number().optional(),
  })

  it('accepts query-only search', () => {
    const result = searchSchema.safeParse({ query: 'meeting notes' })
    expect(result.success).toBe(true)
  })

  it('accepts domain-filtered search', () => {
    const result = searchSchema.safeParse({
      query: 'project deadlines',
      domain: 'career',
      limit: 5,
    })
    expect(result.success).toBe(true)
  })

  it('rejects empty query', () => {
    const result = searchSchema.safeParse({})
    expect(result.success).toBe(false)
  })
})

describe('memory tools — registration pattern', () => {
  it('registerMemoryTools exports function', async () => {
    const { registerMemoryTools } = await import('../src/tools/memory')
    expect(typeof registerMemoryTools).toBe('function')
  })
})

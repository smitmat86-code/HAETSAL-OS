// Mission Phase 6 / 14.4 revision: delegation decider is pattern-only. The
// LLM classifier fallback was removed 2026-07-06 per production-routing
// research — semantic routing does not belong inside a pipeline that
// already knows its own intent, and the classifier compounded gateway
// flakiness (three empties per user message = 258 s wall clock during the
// 2026-07-06 incident). Long ambiguous asks default INLINE.

import { describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { decideDelegation, maybeDelegateExecutionTask } from '../src/services/agents/delegation'
import type { Env } from '../src/types/env'

function trackingEnv(calls: unknown[]): Env {
  return {
    ...env,
    AI_GATEWAY_ID: 'test-gateway',
    AI: {
      run: async (_m: string, input: unknown) => {
        calls.push(input)
        return { response: 'inline' }
      },
    },
  } as unknown as Env
}

describe('mission 6.2 — delegation decision (pattern-only)', () => {
  it('research phrasing delegates by pattern (no AI call)', () => {
    const calls: unknown[] = []
    const decision = decideDelegation('can you research the best standing desks under $400', trackingEnv(calls))
    expect(decision).toEqual({ kind: 'delegate', profile: 'research' })
    expect(calls).toHaveLength(0)
  })

  it('memory-sweep phrasing delegates to the memory profile (no AI call)', () => {
    const calls: unknown[] = []
    const decision = decideDelegation('summarize what I decided about the garage project', trackingEnv(calls))
    expect(decision).toEqual({ kind: 'delegate', profile: 'memory' })
    expect(calls).toHaveLength(0)
  })

  it('short conversational turns stay inline (no AI call)', () => {
    const calls: unknown[] = []
    const decision = decideDelegation('how are you today?', trackingEnv(calls))
    expect(decision).toEqual({ kind: 'inline' })
    expect(calls).toHaveLength(0)
  })

  it('long ambiguous asks default INLINE (classifier removed — conservative default)', () => {
    const calls: unknown[] = []
    const longAsk = 'I have been thinking about whether the situation with the vendor contracts from last quarter needs another pass and what the market currently offers as alternatives before we renew anything'
    expect(decideDelegation(longAsk, trackingEnv(calls))).toEqual({ kind: 'inline' })
    expect(calls).toHaveLength(0)
  })

  it('AI namespace is never invoked by the delegation decider', () => {
    const aiSpy = vi.fn(async () => ({ response: 'anything' }))
    const spyEnv = { ...env, AI: { run: aiSpy } } as unknown as Env
    decideDelegation('a fairly long question about many things that could go many different directions', spyEnv)
    expect(aiSpy).not.toHaveBeenCalled()
  })
})

describe('mission 6.2 — inline fallback on dispatch failure', () => {
  function fakeNamespace(stub: Record<string, unknown>) {
    return {
      idFromName: (name: string) => name,
      get: () => ({ setName: async () => {}, ...stub }),
    }
  }

  it('returns null (grounded-reply fallback) when the DO refuses dispatch', async () => {
    const brokenEnv = {
      ...trackingEnv([]),
      MCPAGENT: fakeNamespace({
        dispatchExecutionTask: async () => { throw new Error('tenant session key unavailable') },
      }),
    } as unknown as Env
    const ack = await maybeDelegateExecutionTask(brokenEnv, 'tenant-x', 'research the best e-ink tablets', {
      channel: 'telegram', replyTo: '123',
    })
    expect(ack).toBeNull()
  })

  it('returns the ack text when dispatch succeeds', async () => {
    const okEnv = {
      ...trackingEnv([]),
      MCPAGENT: fakeNamespace({
        dispatchExecutionTask: async () => ({ runId: 'run-77' }),
      }),
    } as unknown as Env
    const ack = await maybeDelegateExecutionTask(okEnv, 'tenant-x', 'research the best e-ink tablets', {
      channel: 'telegram', replyTo: '123',
    })
    expect(ack).toContain('research agent')
    expect(ack).toContain('dashboard')
  })
})

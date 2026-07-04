// Mission Phase 6: delegation decider — pattern-first routing with classifier
// fallback and a conservative inline default, plus honest inline fallback when
// the DO dispatch path is unavailable.

import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import { decideDelegation, maybeDelegateExecutionTask } from '../src/services/agents/delegation'
import type { Env } from '../src/types/env'

function envWithClassifier(label: string | null, calls?: unknown[]): Env {
  return {
    ...env,
    AI_GATEWAY_ID: 'test-gateway',
    AI: {
      run: async (_m: string, input: unknown) => {
        calls?.push(input)
        if (label === null) throw new Error('classifier down')
        return { response: label }
      },
    },
  } as unknown as Env
}

describe('mission 6.2 — delegation decision', () => {
  it('research phrasing delegates by pattern (no classifier call)', async () => {
    const calls: unknown[] = []
    const decision = await decideDelegation('can you research the best standing desks under $400', envWithClassifier('inline', calls))
    expect(decision).toEqual({ kind: 'delegate', profile: 'research' })
    expect(calls).toHaveLength(0)
  })

  it('memory-sweep phrasing delegates to the memory profile', async () => {
    const decision = await decideDelegation('summarize what I decided about the garage project', envWithClassifier('inline'))
    expect(decision).toEqual({ kind: 'delegate', profile: 'memory' })
  })

  it('short conversational turns stay inline without a classifier call', async () => {
    const calls: unknown[] = []
    const decision = await decideDelegation('how are you today?', envWithClassifier('research', calls))
    expect(decision).toEqual({ kind: 'inline' })
    expect(calls).toHaveLength(0)
  })

  it('long ambiguous asks use the classifier verdict', async () => {
    const longAsk = 'I have been thinking about whether the situation with the vendor contracts from last quarter needs another pass and what the market currently offers as alternatives before we renew anything'
    expect(await decideDelegation(longAsk, envWithClassifier('research'))).toEqual({ kind: 'delegate', profile: 'research' })
    expect(await decideDelegation(longAsk, envWithClassifier('inline'))).toEqual({ kind: 'inline' })
  })

  it('classifier failure degrades to inline (never blocks the reply)', async () => {
    const longAsk = 'walk me through everything that would be involved in moving the family newsletter off the old platform onto something self-hosted with proper backups and archives'
    expect(await decideDelegation(longAsk, envWithClassifier(null))).toEqual({ kind: 'inline' })
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
      ...envWithClassifier('inline'),
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
      ...envWithClassifier('inline'),
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

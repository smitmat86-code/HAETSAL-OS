// Mission 13.1 hotfix contract: runGatewayChat retries transient gateway
// failures (thrown errors AND empty replies) with backoff, preserving the
// original semantics at exhaustion — final throw propagates, final empty
// returns null. Root cause of the live "trouble thinking" fallback: the
// chat path had zero retries while the execution loop had two.

import { describe, expect, it, vi } from 'vitest'
import { runGatewayChat } from '../src/services/workers-ai-chat'
import type { Env } from '../src/types/env'

const ok = (text: string) => ({ choices: [{ message: { content: text } }] })
const envWith = (run: (...args: unknown[]) => Promise<unknown>): Env =>
  ({ AI: { run }, AI_GATEWAY_ID: 'test-gateway' } as unknown as Env)

describe('mission 13.1 — gateway chat retry', () => {
  it('recovers from a thrown upstream blip on the next attempt', async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('InferenceUpstreamError: blip'))
      .mockResolvedValueOnce(ok('recovered'))
    await expect(runGatewayChat(envWith(run), [{ role: 'user', content: 'hi' }]))
      .resolves.toBe('recovered')
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('recovers from an empty reply on the next attempt', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { content: null } }] })
      .mockResolvedValueOnce(ok('second try'))
    await expect(runGatewayChat(envWith(run), [{ role: 'user', content: 'hi' }]))
      .resolves.toBe('second try')
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('exhausts retries then preserves original semantics', async () => {
    const alwaysThrows = vi.fn().mockRejectedValue(new Error('down'))
    await expect(runGatewayChat(envWith(alwaysThrows), [{ role: 'user', content: 'hi' }]))
      .rejects.toThrow('down')
    expect(alwaysThrows).toHaveBeenCalledTimes(3) // 1 + 2 retries

    const alwaysEmpty = vi.fn().mockResolvedValue({ choices: [] })
    await expect(runGatewayChat(envWith(alwaysEmpty), [{ role: 'user', content: 'hi' }]))
      .resolves.toBeNull()
    expect(alwaysEmpty).toHaveBeenCalledTimes(3)
  }, 30_000)
})

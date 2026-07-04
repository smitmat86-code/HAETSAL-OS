// Mission Phase 6: execution-agent tool loop — per-spawn tool scoping enforced
// structurally, tolerant tool_calls parsing, doom-loop break, cooperative
// cancellation, soft deadline, gate-preserving propose_* routing, and the
// remind channel-enum alignment fold-in.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { parseToolCalls, runExecutionToolLoop, type ToolLoopConfig } from '../src/agents/execution/tool-loop'
import { PROFILE_TOOLS } from '../src/agents/execution/types'
import { buildTerminalTailStream, sanitizeExecutionError, type RunSql } from '../src/agents/execution/run-store'
import { remindSchema } from '../src/tools/act/remind'
import { encryptWithKek, decryptWithKek } from '../src/cron/kek'
import type { ActionQueueMessage } from '../src/types/action'
import type { Env } from '../src/types/env'

const SUITE = crypto.randomUUID()
const TENANT = `test-tenant-mission-60-${SUITE}`

async function testTmk(): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(`m60-${SUITE}`), { name: 'HKDF' }, false, ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('m60'), info: new TextEncoder().encode('m60') },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  )
}

type AiTurn = { response?: string; tool_calls?: unknown[] }

function makeEnv(turns: AiTurn[], overrides: Partial<Record<string, unknown>> = {}): { env: Env; aiCalls: unknown[] } {
  const aiCalls: unknown[] = []
  const fakeEnv = {
    ...env,
    BRAVE_API_KEY: 'test-brave-key',
    AI_GATEWAY_ID: 'test-gateway',
    AI: {
      run: async (_model: string, input: unknown) => {
        aiCalls.push(input)
        return turns[Math.min(aiCalls.length - 1, turns.length - 1)] ?? { response: 'done' }
      },
    },
    ...overrides,
  } as unknown as Env
  return { env: fakeEnv, aiCalls }
}

async function loopConfig(partial: Partial<ToolLoopConfig> & { env: Env }): Promise<ToolLoopConfig> {
  return {
    tenantId: TENANT,
    tmk: await testTmk(),
    agentIdentity: 'execution_agent/research',
    task: 'test task',
    allowedTools: ['web_search'],
    maxTurns: 4,
    deadlineAt: Date.now() + 60_000,
    isCancelled: () => false,
    onProgress: () => {},
    ...partial,
  }
}

beforeEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('mission 6.0 — tool_calls parser tolerance', () => {
  it('reads flat, OpenAI-nested, and stringified-argument shapes', () => {
    expect(parseToolCalls({ tool_calls: [{ name: 'a', arguments: { q: 1 } }] }))
      .toEqual([{ name: 'a', args: { q: 1 } }])
    expect(parseToolCalls({ tool_calls: [{ function: { name: 'b', arguments: '{"q":2}' } }] }))
      .toEqual([{ name: 'b', args: { q: 2 } }])
    expect(parseToolCalls({ tool_calls: [{ function: { name: 'c' } }] }))
      .toEqual([{ name: 'c', args: {} }])
    expect(parseToolCalls({ response: 'no tools' })).toEqual([])
  })
})

describe('mission 6.0 — per-spawn tool scoping (structural)', () => {
  it('an out-of-scope tool call never executes and the model is told', async () => {
    const braveFetch = vi.fn()
    vi.stubGlobal('fetch', braveFetch)
    const { env: fakeEnv } = makeEnv([
      { tool_calls: [{ name: 'web_search', arguments: { query: 'x' } }] },
      { response: 'final answer' },
    ])
    const result = await runExecutionToolLoop(await loopConfig({
      env: fakeEnv,
      allowedTools: ['recall_memory'], // web_search NOT in scope
    }))
    expect(result.status).toBe('completed')
    expect(result.resultText).toBe('final answer')
    expect(braveFetch).not.toHaveBeenCalled() // scoping is structural, not prompt-only
    expect(result.toolsUsed).toEqual([])
  })

  it('memory profile scope excludes every propose_* tool', () => {
    expect(PROFILE_TOOLS.memory).toEqual(['recall_memory'])
    expect(PROFILE_TOOLS.research).not.toContain('propose_message')
  })
})

describe('mission 6.0 — in-scope tool execution', () => {
  it('web_search executes through Brave and feeds results back', async () => {
    const braveFetch = vi.fn(async () => new Response(JSON.stringify({
      web: { results: [{ title: 'Hit', url: 'https://x', description: 'snippet' }] },
    })))
    vi.stubGlobal('fetch', braveFetch)
    const { env: fakeEnv, aiCalls } = makeEnv([
      { tool_calls: [{ name: 'web_search', arguments: { query: 'e-ink' } }] },
      { response: 'summarized' },
    ])
    const result = await runExecutionToolLoop(await loopConfig({ env: fakeEnv }))
    expect(result.status).toBe('completed')
    expect(result.toolCalls).toBe(1)
    expect(result.toolsUsed).toEqual(['web_search'])
    const braveReq = braveFetch.mock.calls[0] as unknown[]
    expect(String(braveReq[0])).toContain('api.search.brave.com')
    const secondCall = aiCalls[1] as { messages: Array<{ role: string; content?: string }> }
    expect(secondCall.messages.some(m => m.role === 'tool' && (m.content ?? '').includes('Hit'))).toBe(true)
  })

  it('propose_reminder stays behind the action gate (queued, WRITE_INTERNAL)', async () => {
    const queued: ActionQueueMessage[] = []
    const { env: fakeEnv } = makeEnv([
      { tool_calls: [{ name: 'propose_reminder', arguments: { message: 'stretch', remind_at: '2026-07-05T09:00:00Z', channel: 'telegram' } }] },
      { response: 'reminder proposed' },
    ], { QUEUE_ACTIONS: { send: async (m: unknown) => { queued.push(m as ActionQueueMessage) } } })
    const result = await runExecutionToolLoop(await loopConfig({
      env: fakeEnv, allowedTools: ['propose_reminder'],
    }))
    expect(result.status).toBe('completed')
    expect(queued).toHaveLength(1)
    expect(queued[0].tool_name).toBe('brain_v1_act_remind')
    expect(queued[0].capability_class).toBe('WRITE_INTERNAL')
  })
})

describe('mission 6.0 — transient model-failure retry', () => {
  it('recovers when the first two calls fail (blip-cluster resilience)', async () => {
    let calls = 0
    const fakeEnv = {
      ...env, AI_GATEWAY_ID: 'g',
      AI: { run: async () => { if (++calls <= 2) throw new Error('InferenceUpstreamError: upstream 5xx'); return { response: 'recovered' } } },
    } as unknown as Env
    const result = await runExecutionToolLoop(await loopConfig({ env: fakeEnv }))
    expect(result.status).toBe('completed')
    expect(result.resultText).toBe('recovered')
    expect(calls).toBe(3)
  }, 15_000)

  it('persistent failure surfaces as a real error after bounded retries', async () => {
    let calls = 0
    const fakeEnv = {
      ...env, AI_GATEWAY_ID: 'g',
      AI: { run: async () => { calls++; throw new Error('InferenceUpstreamError: upstream 5xx') } },
    } as unknown as Env
    await expect(runExecutionToolLoop(await loopConfig({ env: fakeEnv }))).rejects.toThrow(/InferenceUpstreamError/)
    expect(calls).toBe(3) // original + two retries, no infinite loop
  }, 15_000)
})

describe('mission 6.0 — doom loop, cancellation, deadline', () => {
  it('breaks out after repeated identical calls instead of spinning', async () => {
    // web_search here: its executor makes no AI calls, so aiCalls counts loop
    // turns only (recall_memory would add embedding calls to the same fake).
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ web: { results: [] } }))))
    const sameCall = { name: 'web_search', arguments: { query: 'same' } }
    const { env: fakeEnv, aiCalls } = makeEnv([
      { tool_calls: [sameCall, sameCall, sameCall, sameCall] },
    ])
    const result = await runExecutionToolLoop(await loopConfig({
      env: fakeEnv, allowedTools: ['web_search'], maxTurns: 8,
    }))
    expect(result.status).toBe('completed')
    expect(result.resultText).toContain('stuck')
    expect(result.toolCalls).toBe(5) // 4 in turn one + 1 in turn two, break on the 6th
    expect(aiCalls.length).toBe(2)   // broke during turn two, not at maxTurns
  })

  it('cancellation observed before any model call aborts with no AI usage', async () => {
    const { env: fakeEnv, aiCalls } = makeEnv([{ response: 'never' }])
    const result = await runExecutionToolLoop(await loopConfig({
      env: fakeEnv, isCancelled: () => true,
    }))
    expect(result.status).toBe('aborted')
    expect(aiCalls).toHaveLength(0)
  })

  it('cancellation between turns aborts before the next model call', async () => {
    let calls = 0
    const { env: fakeEnv, aiCalls } = makeEnv([
      { tool_calls: [{ name: 'web_search', arguments: { query: 'x' } }] },
      { response: 'never reached' },
    ])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ web: { results: [] } }))))
    const result = await runExecutionToolLoop(await loopConfig({
      env: fakeEnv,
      isCancelled: () => ++calls > 2, // false for the first checks, true after the first tool round
    }))
    expect(result.status).toBe('aborted')
    expect(aiCalls.length).toBe(1)
  })

  it('expired soft deadline returns honestly without model calls', async () => {
    const { env: fakeEnv, aiCalls } = makeEnv([{ response: 'never' }])
    const result = await runExecutionToolLoop(await loopConfig({
      env: fakeEnv, deadlineAt: Date.now() - 1,
    }))
    expect(result.status).toBe('completed')
    expect(result.resultText).toContain('ran out of time')
    expect(aiCalls).toHaveLength(0)
  })
})

describe('mission 6.0 — Law 2 output discipline', () => {
  it('TMK ciphertext round-trips and never contains the plaintext', async () => {
    const tmk = await testTmk()
    const secret = `finding: the meeting with Alice moved to Friday ${SUITE}`
    const ciphertext = await encryptWithKek(secret, tmk)
    expect(ciphertext).not.toContain('Alice')
    expect(JSON.stringify({ ciphertext })).not.toContain('Friday')
    expect(await decryptWithKek(ciphertext, tmk)).toBe(secret)
  })

  it('persisted error strings come from the fixed vocabulary, never raw messages', () => {
    expect(sanitizeExecutionError(new Error('failed to decrypt payload'))).toBe('encryption_failure')
    expect(sanitizeExecutionError(new Error('AI run failed: gateway 5028'))).toBe('model_call_failure')
    expect(sanitizeExecutionError(new Error('deadline exceeded'))).toBe('deadline_exceeded')
    const leaked = sanitizeExecutionError(new Error('parse failed near "meeting with Alice on Friday"'))
    expect(leaked).not.toContain('Alice')
    expect(leaked).toMatch(/^unexpected_error:/)
    expect(sanitizeExecutionError('string throw with secrets')).toBe('unknown_error')
  })
})

describe('mission 6.0 — terminal tail stream (fast completion delivery)', () => {
  it('stays open while running and closes once the run goes terminal', async () => {
    let status = 'running'
    const sql = ((strings: TemplateStringsArray) => {
      if (strings.join('?').includes('SELECT run_id')) {
        return [{ run_id: 'r1', status, started_at: 1, completed_at: null, output_json: null,
          summary: null, error: null, progress_json: null, cancelled: 0, heartbeat_at: 1 }]
      }
      return []
    }) as unknown as RunSql
    const stream = buildTerminalTailStream(sql, 'r1', 60_000, 10)
    const reader = stream.getReader()
    setTimeout(() => { status = 'completed' }, 40)
    const started = Date.now()
    const { done } = await reader.read() // resolves only when the stream closes
    expect(done).toBe(true)
    expect(Date.now() - started).toBeGreaterThanOrEqual(30)
  })

  it('closes immediately for an unknown run', async () => {
    const sql = (() => []) as unknown as RunSql
    const reader = buildTerminalTailStream(sql, 'missing', 60_000, 10).getReader()
    const { done } = await reader.read()
    expect(done).toBe(true)
  })
})

describe('mission 6.0 — act_remind channel enum fold-in', () => {
  it('accepts the canonical MessageChannel values', () => {
    for (const channel of ['sms', 'imessage', 'telegram', 'email']) {
      expect(remindSchema.safeParse({ message: 'm', remind_at: '2026-07-05T09:00:00Z', channel }).success).toBe(true)
    }
  })
  it('rejects the retired Phase-1 values', () => {
    for (const channel of ['push', 'both']) {
      expect(remindSchema.safeParse({ message: 'm', remind_at: '2026-07-05T09:00:00Z', channel }).success).toBe(false)
    }
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/types/env'
import type { IngestionQueueMessage } from '../src/types/ingestion'

const handlers = vi.hoisted(() => ({
  handleSmsInbound: vi.fn(),
  handleGmailThread: vi.fn(),
  handleCalendarEvent: vi.fn(),
  handleObsidianNote: vi.fn(),
  handleBootstrapGmailThread: vi.fn(),
  handleBootstrapCalendarEvent: vi.fn(),
  handleBootstrapDriveFile: vi.fn(),
}))

const retainConsumer = vi.hoisted(() => ({
  processQueuedRetainArtifact: vi.fn(),
}))

const identity = vi.hoisted(() => ({
  getMcpAgentObjectId: vi.fn(() => 'stub-do-id'),
}))

vi.mock('../src/workers/ingestion/handlers', () => handlers)
vi.mock('../src/workers/ingestion/retain-consumer', () => retainConsumer)
vi.mock('../src/workers/mcpagent/do/identity', () => identity)

import { handleIngestionBatch } from '../src/workers/ingestion/consumer'

function makeQueueMessage(body: IngestionQueueMessage) {
  return {
    id: crypto.randomUUID(),
    body,
    attempts: 1,
    timestamp: new Date(),
    ack: vi.fn(),
    retry: vi.fn(),
  } as unknown as Message<IngestionQueueMessage> & {
    ack: ReturnType<typeof vi.fn>
    retry: ReturnType<typeof vi.fn>
  }
}

function makeBatch(message: Message<IngestionQueueMessage>): MessageBatch<IngestionQueueMessage> {
  return {
    queue: 'brain-priority-high',
    messages: [message],
    retryAll: vi.fn(),
    ackAll: vi.fn(),
  } as unknown as MessageBatch<IngestionQueueMessage>
}

function makeEnv(getTmkImpl?: () => Promise<CryptoKey | null>): Env {
  return {
    MCPAGENT: {
      get: vi.fn(() => ({
        getTmk: getTmkImpl ?? (async () => null),
      })),
    },
  } as unknown as Env
}

const ctx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext

describe('2.1c ingestion consumer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('processes retain_artifact without requiring TMK lookup', async () => {
    const message = makeQueueMessage({
      type: 'retain_artifact',
      tenantId: 'tenant-a',
      payload: {
        requestId: 'req-1',
        artifact: {
          source: 'mcp_retain',
          content: 'remember this',
          occurredAt: Date.now(),
          provenance: 'mcp_retain',
        },
        contentEncrypted: 'ciphertext',
      },
      enqueuedAt: Date.now(),
    })
    const env = makeEnv()

    await handleIngestionBatch(makeBatch(message), env, ctx)

    expect(retainConsumer.processQueuedRetainArtifact).toHaveBeenCalledOnce()
    expect(retainConsumer.processQueuedRetainArtifact).toHaveBeenCalledWith(
      'tenant-a',
      message.body.payload,
      env,
      ctx,
    )
    expect(message.ack).toHaveBeenCalledOnce()
    expect(message.retry).not.toHaveBeenCalled()
    expect(env.MCPAGENT.get).not.toHaveBeenCalled()
  })

  it('retries non-retain messages when TMK is unavailable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const message = makeQueueMessage({
      type: 'sms_inbound',
      tenantId: 'tenant-b',
      payload: {
        text: 'hello',
        occurredAt: Date.now(),
        from: '+15551234567',
      },
      enqueuedAt: Date.now(),
    })
    const env = makeEnv(async () => null)

    await handleIngestionBatch(makeBatch(message), env, ctx)

    expect(identity.getMcpAgentObjectId).toHaveBeenCalledWith(env.MCPAGENT, 'tenant-b')
    expect(handlers.handleSmsInbound).not.toHaveBeenCalled()
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 30 })
    expect(message.ack).not.toHaveBeenCalled()
  })

  it('processes non-retain messages when TMK is available', async () => {
    const tmk = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    ) as CryptoKey
    const message = makeQueueMessage({
      type: 'sms_inbound',
      tenantId: 'tenant-c',
      payload: {
        text: 'queued sms',
        occurredAt: Date.now(),
        from: '+15557654321',
      },
      enqueuedAt: Date.now(),
    })
    const env = makeEnv(async () => tmk)

    await handleIngestionBatch(makeBatch(message), env, ctx)

    expect(handlers.handleSmsInbound).toHaveBeenCalledOnce()
    expect(handlers.handleSmsInbound).toHaveBeenCalledWith(
      'tenant-c',
      message.body.payload,
      tmk,
      env,
      ctx,
    )
    expect(message.retry).not.toHaveBeenCalled()
    expect(message.ack).toHaveBeenCalledOnce()
  })
})

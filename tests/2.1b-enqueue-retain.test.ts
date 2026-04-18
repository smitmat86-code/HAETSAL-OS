import { describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { enqueueRetainArtifact } from '../src/services/ingestion/enqueue'
import type { IngestionArtifact } from '../src/types/ingestion'

describe('2.1b enqueueRetainArtifact', () => {
  it('includes pre-encrypted archival content when TMK is available', async () => {
    const sendSpy = vi.spyOn(env.QUEUE_HIGH, 'send').mockResolvedValue(undefined as never)
    const tmk = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    ) as CryptoKey
    const artifact: IngestionArtifact = {
      tenantId: 'test-tenant',
      source: 'mcp_retain',
      content: 'Queue this memory with ciphertext',
      occurredAt: Date.now(),
      memoryType: 'episodic',
      domain: 'career',
      provenance: 'mcp_retain',
    }

    await enqueueRetainArtifact(artifact, env, undefined, tmk)

    const payload = sendSpy.mock.calls[0]?.[0] as {
      payload: { artifact: { content: string }; contentEncrypted?: string }
    }
    expect(payload.payload.artifact.content).toContain('Queue this memory with ciphertext')
    expect(payload.payload.contentEncrypted).toBeTruthy()
    expect(payload.payload.contentEncrypted).not.toContain('Queue this memory with ciphertext')
  })
})

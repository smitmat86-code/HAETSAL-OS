import { describe, expect, it, vi } from 'vitest'
import { broadcastEvent } from '../src/services/action/executor'
import { getMcpAgentObjectId, getMcpAgentObjectName } from '../src/workers/mcpagent/do/identity'

describe('1.2b MCP agent identity helpers', () => {
  it('maps tenant ids to the prefixed DO object id', () => {
    const idFromName = vi.fn(() => ({ toString: () => 'object-id' }) as unknown as DurableObjectId)
    const namespace = { idFromName } as unknown as DurableObjectNamespace

    const id = getMcpAgentObjectId(namespace, 'tenant-123')

    expect(idFromName).toHaveBeenCalledWith(getMcpAgentObjectName('tenant-123'))
    expect(String(id)).toBe('object-id')
  })

  it('broadcastEvent resolves the MCP DO with the prefixed name', async () => {
    const broadcast = vi.fn().mockResolvedValue(undefined)
    const get = vi.fn(() => ({ broadcast }))
    const idFromName = vi.fn(() => ({ toString: () => 'object-id' }) as unknown as DurableObjectId)
    const env = {
      MCPAGENT: { idFromName, get },
    } as unknown as Parameters<typeof broadcastEvent>[0]

    await broadcastEvent(env, 'tenant-456', { type: 'test.event' })

    expect(idFromName).toHaveBeenCalledWith(getMcpAgentObjectName('tenant-456'))
    expect(get).toHaveBeenCalled()
    expect(broadcast).toHaveBeenCalledWith({ type: 'test.event' })
  })
})

import { describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/types/env'
import {
  CANONICAL_BRAIN_PROVENANCE,
  EXTERNAL_BRAIN_CLIENT_MAPPINGS,
  EXTERNAL_BRAIN_IMPLEMENTATION_ORDER,
  EXTERNAL_BRAIN_SOURCES,
  EXTERNAL_BRAIN_SURFACES,
  EXTERNAL_CLIENT_FIXTURES,
  EXTERNAL_SOURCE_FIXTURES,
  PORTABLE_WORKING_IDENTITY_ARTIFACTS,
  getExternalBrainSurface,
  validatePortableWorkingIdentityFamily,
} from '../src/services/external-brain-contract'
import { BRAIN_MEMORY_TOOL_NAMES, registerBrainMemorySurface } from '../src/tools/brain-memory-surface'

describe('9.3 external client and source integration architecture', () => {
  it('defines brain-memory as the first live external-client surface', () => {
    const surface = getExternalBrainSurface('brain-memory')

    expect(surface.status).toBe('live')
    expect(surface.operations.filter((operation) => operation.live).map((operation) => operation.id)).toEqual(
      expect.arrayContaining(BRAIN_MEMORY_TOOL_NAMES),
    )
    expect(surface.operations.every((operation) => operation.actionClass === 'memory')).toBe(true)
  })

  it('keeps source-read separate from source-write and leaves actions deferred', () => {
    const sourceRead = getExternalBrainSurface('brain-sources-read')
    const actions = getExternalBrainSurface('brain-actions')

    expect(sourceRead.status).toBe('planned')
    expect(sourceRead.operations.every((operation) => operation.actionClass === 'source-read')).toBe(true)
    expect(actions.status).toBe('deferred')
    expect(actions.operations.some((operation) => operation.actionClass === 'source-write')).toBe(true)
    expect(actions.operations.every((operation) => operation.live === false)).toBe(true)
  })

  it('maps client classes by capability scope instead of vendor brand', () => {
    const codingClients = EXTERNAL_CLIENT_FIXTURES.filter((fixture) => fixture.clientClass === 'mcp-native-coding-client')
    const codingMapping = EXTERNAL_BRAIN_CLIENT_MAPPINGS.find((mapping) => mapping.clientClass === 'mcp-native-coding-client')
    const webMapping = EXTERNAL_BRAIN_CLIENT_MAPPINGS.find((mapping) => mapping.clientClass === 'web-ai-client')

    expect(codingClients.map((fixture) => fixture.expectedSurface)).toEqual(['brain-memory', 'brain-memory', 'brain-memory'])
    expect(codingMapping?.connectionPattern).toBe('remote-mcp')
    expect(webMapping).toEqual({
      clientClass: 'web-ai-client',
      connectionPattern: 'byoc-portability',
      defaultSurface: null,
      portabilityBridge: true,
    })
  })

  it('defines selective source ingestion without naive mirroring', () => {
    const eventDriven = EXTERNAL_BRAIN_SOURCES.find((source) => source.sourceClass === 'event-driven-source-read')
    const explicit = EXTERNAL_BRAIN_SOURCES.find((source) => source.sourceClass === 'explicit-file-ingestion')
    const historical = EXTERNAL_BRAIN_SOURCES.find((source) => source.sourceClass === 'historical-import')

    expect(eventDriven?.examples).toEqual(expect.arrayContaining(['Gmail', 'Calendar']))
    expect(explicit?.examples).toEqual(expect.arrayContaining(['Drive/Docs', 'Obsidian bridge']))
    expect(historical?.selective).toBe(true)
    expect(EXTERNAL_SOURCE_FIXTURES.map((fixture) => fixture.expectedSurface)).toEqual([
      'brain-sources-read',
      'brain-sources-read',
      'brain-sources-read',
    ])
  })

  it('defines the portable working-identity family as user-owned byoc exports', () => {
    const validation = validatePortableWorkingIdentityFamily(PORTABLE_WORKING_IDENTITY_ARTIFACTS.map((artifact) => artifact.id))

    expect(validation).toEqual({ valid: true, missing: [] })
    expect(PORTABLE_WORKING_IDENTITY_ARTIFACTS.every((artifact) => artifact.userOwned)).toBe(true)
    expect(PORTABLE_WORKING_IDENTITY_ARTIFACTS.every((artifact) => artifact.provenance === 'byoc_export')).toBe(true)
    expect(PORTABLE_WORKING_IDENTITY_ARTIFACTS.every((artifact) => artifact.delivery.includes('file') && artifact.delivery.includes('mcp-record'))).toBe(true)
  })

  it('keeps canonical provenance classes distinct across direct, source, import, and byoc flows', () => {
    expect(CANONICAL_BRAIN_PROVENANCE.map((entry) => entry.id)).toEqual([
      'user_authored',
      'agent_authored',
      'source_ingested',
      'bootstrap_import',
      'byoc_export',
    ])
  })

  it('keeps the rollout order memory-first, sources-read second, actions last', () => {
    expect(EXTERNAL_BRAIN_IMPLEMENTATION_ORDER.map((step) => step.id)).toEqual([
      'brain-memory',
      'client-capture-patterns',
      'brain-sources-read',
      'byoc-portability',
      'brain-actions',
    ])
  })

  it('registers the live brain-memory surface through the canonical memory tool subset', () => {
    const tool = vi.fn()
    const server = { tool } as Parameters<typeof registerBrainMemorySurface>[0]

    registerBrainMemorySurface(server, {
      getEnv: () => ({}) as Env,
      getTenantId: () => 'tenant-93',
      getTmk: () => null,
      getExecutionContext: () => ({ waitUntil: () => undefined }),
    })

    const registeredNames = tool.mock.calls.map((call) => call[0])
    expect(registeredNames).toEqual(expect.arrayContaining(BRAIN_MEMORY_TOOL_NAMES))
    expect(registeredNames).not.toEqual(expect.arrayContaining(['brain_v1_act_send_message', 'brain_v1_retain']))
  })

  it('keeps the declared action classes aligned with the surfaced registries', () => {
    const memoryToolSet = new Set(BRAIN_MEMORY_TOOL_NAMES)
    const liveSurfaceIds = EXTERNAL_BRAIN_SURFACES
      .flatMap((surface) => surface.operations.filter((operation) => operation.live).map((operation) => operation.id))

    expect(liveSurfaceIds.every((id) => memoryToolSet.has(id))).toBe(true)
  })
})

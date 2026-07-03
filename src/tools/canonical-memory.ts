import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env } from '../types/env'
import type { EntityTimelineInput, TraceRelationshipInput } from '../types/canonical-graph-query'
import type { PrepareContextForAgentInput } from '../types/chief-of-staff-context'
import type { ExternalClientCaptureInput } from '../types/external-client-memory'
import { writeAuditLog } from '../middleware/audit'
import { getCanonicalBrokerTrace, listRecentCanonicalBrokerTraces } from '../services/canonical-broker-trace-read'
import { getCanonicalEntityTimeline, traceCanonicalRelationship } from '../services/canonical-graph-query'
import { prepareContextForAgent } from '../services/chief-of-staff-context'
import { getCanonicalDocument, listRecentCanonicalMemories, searchCanonicalMemory } from '../services/canonical-memory-query'
import { getCanonicalMemoryStats } from '../services/canonical-memory-stats'
import { getCanonicalMemoryStatus } from '../services/canonical-memory-status'
import { BRAIN_MEMORY_SURFACE_PROFILE } from '../services/external-client-memory'
import { captureExternalClientMemory } from '../services/external-client-memory-write'
import {
  captureSchema,
  documentSchema,
  entityTimelineSchema,
  prepareContextSchema,
  recentSchema,
  recentTraceSchema,
  searchSchema,
  statusSchema,
  traceRelationshipSchema,
  traceSchema,
} from './canonical-memory-schema'
interface CanonicalMemoryToolContext {
  getEnv: () => Env
  getTenantId: () => string
  getTmk: () => CryptoKey | null
  getExecutionContext: () => Pick<ExecutionContext, 'waitUntil'>
}

const asText = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] })
const readOptions = (ctx: CanonicalMemoryToolContext) => ({ tmk: ctx.getTmk(), executionContext: ctx.getExecutionContext() })

export function registerCanonicalMemoryTools(server: McpServer, ctx: CanonicalMemoryToolContext): void {
  server.tool('capture_memory', 'Capture memory through the canonical memory contract', captureSchema.shape, async (input) => {
    return asText(await captureExternalClientMemory(input as ExternalClientCaptureInput, ctx.getTenantId(), ctx.getTmk(), ctx.getEnv(), ctx.getExecutionContext()))
  })

  server.tool('search_memory', 'Search canonical memories', searchSchema.shape, async (input) => {
    const typed = input as z.infer<typeof searchSchema>
    const result = await searchCanonicalMemory({
      tenantId: ctx.getTenantId(),
      query: typed.query,
      scope: typed.scope ?? null,
      limit: typed.limit,
      mode: typed.mode,
    }, ctx.getEnv(), ctx.getTenantId(), readOptions(ctx))
    ctx.getExecutionContext().waitUntil(writeAuditLog(ctx.getEnv(), 'memory.search.executed', ctx.getTenantId(), { agentIdentity: 'mcpagent/tool' }))
    return asText(result)
  })

  server.tool('trace_relationship', 'Trace direct graph relationships through the canonical memory surface', traceRelationshipSchema.shape, async (input) => {
    const typed = input as TraceRelationshipInput
    return asText(await traceCanonicalRelationship({ ...typed, tenantId: ctx.getTenantId(), to: typed.to ?? null, relation: typed.relation ?? null }, ctx.getEnv(), ctx.getTenantId()))
  })

  server.tool('get_entity_timeline', 'View graph-backed entity activity over time through the canonical surface', entityTimelineSchema.shape, async (input) => {
    const typed = input as EntityTimelineInput & { start_at?: number; end_at?: number }
    return asText(await getCanonicalEntityTimeline({
      tenantId: ctx.getTenantId(),
      entity: typed.entity,
      startAt: typed.start_at ?? null,
      endAt: typed.end_at ?? null,
      limit: typed.limit,
    }, ctx.getEnv(), ctx.getTenantId()))
  })

  server.tool('prepare_context_for_agent', 'Assemble a read-only context bundle for a first-party agent', prepareContextSchema.shape, async (input) => {
    const typed = input as PrepareContextForAgentInput
    return asText(await prepareContextForAgent({ ...typed, scope: typed.scope ?? null }, ctx.getEnv(), ctx.getTenantId(), readOptions(ctx)))
  })

  server.tool('get_recent_memory_traces', 'List recent brokered memory traces for the current tenant', recentTraceSchema.shape, async (input) => {
    const typed = input as z.infer<typeof recentTraceSchema>
    return asText(await listRecentCanonicalBrokerTraces({
      tenantId: ctx.getTenantId(),
      limit: typed.limit,
      mode: typed.mode ?? null,
    }, ctx.getEnv(), ctx.getTenantId(), readOptions(ctx)))
  })

  server.tool('get_memory_trace', 'Read one brokered memory trace for the current tenant', traceSchema.shape, async (input) => {
    const typed = input as z.infer<typeof traceSchema>
    return asText(await getCanonicalBrokerTrace({
      tenantId: ctx.getTenantId(),
      queryId: typed.query_id,
    }, ctx.getEnv(), ctx.getTenantId(), readOptions(ctx)))
  })

  server.tool('get_recent_memories', 'List recent canonical memories', recentSchema.shape, async (input) => {
    const typed = input as z.infer<typeof recentSchema>
    const result = await listRecentCanonicalMemories({ tenantId: ctx.getTenantId(), scope: typed.scope ?? null, limit: typed.limit }, ctx.getEnv(), ctx.getTenantId(), { tmk: ctx.getTmk() })
    ctx.getExecutionContext().waitUntil(writeAuditLog(ctx.getEnv(), 'memory.recent.viewed', ctx.getTenantId(), { agentIdentity: 'mcpagent/tool' }))
    return asText(result)
  })

  server.tool('get_document', 'Get one canonical document', documentSchema.shape, async (input) => {
    const typed = input as z.infer<typeof documentSchema>
    const result = await getCanonicalDocument({ tenantId: ctx.getTenantId(), documentId: typed.document_id }, ctx.getEnv(), ctx.getTenantId(), { tmk: ctx.getTmk() })
    ctx.getExecutionContext().waitUntil(writeAuditLog(ctx.getEnv(), 'memory.document.viewed', ctx.getTenantId(), { memoryId: result.documentId, agentIdentity: 'mcpagent/tool' }))
    return asText(result)
  })

  server.tool('memory_status', 'Get canonical memory operation status', statusSchema.shape, async (input) => {
    const typed = input as z.infer<typeof statusSchema>
    const result = await getCanonicalMemoryStatus({ tenantId: ctx.getTenantId(), captureId: typed.capture_id, operationId: typed.operation_id }, ctx.getEnv(), ctx.getTenantId())
    ctx.getExecutionContext().waitUntil(writeAuditLog(ctx.getEnv(), 'memory.status.viewed', ctx.getTenantId(), { memoryId: result.operation.operationId, agentIdentity: 'mcpagent/tool' }))
    return asText(result)
  })
  server.tool('memory_stats', 'Get canonical memory stats', {}, async () =>
    asText({
      ...(await getCanonicalMemoryStats(ctx.getEnv(), ctx.getTenantId())),
      brainMemoryProfile: BRAIN_MEMORY_SURFACE_PROFILE,
    }))

}

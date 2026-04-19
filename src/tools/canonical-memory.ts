import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env } from '../types/env'
import type { EntityTimelineInput, TraceRelationshipInput } from '../types/canonical-graph-query'
import type { PrepareContextForAgentInput } from '../types/chief-of-staff-context'
import type { ExternalClientCaptureInput } from '../types/external-client-memory'
import { writeAuditLog } from '../middleware/audit'
import { getCanonicalEntityTimeline, traceCanonicalRelationship } from '../services/canonical-graph-query'
import { prepareContextForAgent } from '../services/chief-of-staff-context'
import { getCanonicalDocument, listRecentCanonicalMemories, searchCanonicalMemory } from '../services/canonical-memory-query'
import { getCanonicalMemoryStats } from '../services/canonical-memory-stats'
import { getCanonicalMemoryStatus } from '../services/canonical-memory-status'
import { BRAIN_MEMORY_SURFACE_PROFILE } from '../services/external-client-memory'
import { captureExternalClientMemory } from '../services/external-client-memory-write'

interface CanonicalMemoryToolContext {
  getEnv: () => Env
  getTenantId: () => string
  getTmk: () => CryptoKey | null
  getExecutionContext: () => Pick<ExecutionContext, 'waitUntil'>
}

const captureSchema = z.object({
  content: z.string().describe('Memory content to capture'),
  scope: z.string().optional().describe('Canonical scope, such as general or research'),
  memory_type: z.enum(['episodic', 'semantic', 'world']).optional().describe('Capture category'),
  provenance: z.string().optional().describe('Capture provenance label'),
  capture_mode: z.enum(['explicit', 'session_summary', 'artifact']).optional()
    .describe('Optional brain-memory rollout capture mode'),
  client_name: z.string().optional().describe('Calling MCP-native client name'),
  title: z.string().optional().describe('Optional durable title for the captured memory'),
  session_id: z.string().optional().describe('Optional client session identifier for session-close captures'),
  source_ref: z.string().optional().describe('Optional caller-provided source reference for explicit capture'),
  artifact_ref: z.string().optional().describe('Optional artifact reference or path for artifact-linked capture'),
  artifact_filename: z.string().optional().describe('Optional artifact display name'),
  artifact_media_type: z.string().optional().describe('Optional artifact media type'),
  artifact_byte_length: z.number().optional().describe('Optional artifact size in bytes'),
})
const searchSchema = z.object({
  query: z.string().describe('Canonical memory search query'),
  scope: z.string().optional().describe('Optional scope filter'),
  limit: z.number().optional().describe('Maximum results to return'),
  mode: z.enum(['raw', 'semantic', 'graph', 'composed', 'lexical']).optional()
    .describe('Optional explicit mode override; lexical is accepted as a backward-compatible alias for raw'),
})
const recentSchema = z.object({ scope: z.string().optional().describe('Optional scope filter'), limit: z.number().optional().describe('Maximum results to return') })
const documentSchema = z.object({ document_id: z.string().describe('Canonical document id') })
const statusSchema = z.object({
  capture_id: z.string().optional().describe('Canonical capture id'),
  operation_id: z.string().optional().describe('Canonical memory operation id'),
})
const traceRelationshipSchema = z.object({
  from: z.string().describe('Starting entity, topic, scope, or canonical graph key'),
  to: z.string().optional().describe('Optional target entity to constrain the trace'),
  relation: z.string().optional().describe('Optional relation filter, such as conversed_with'),
  limit: z.number().optional().describe('Maximum relationships to return'),
})
const entityTimelineSchema = z.object({
  entity: z.string().describe('Entity, topic, scope, or canonical graph key to inspect over time'),
  start_at: z.number().optional().describe('Optional inclusive start timestamp in unix milliseconds'),
  end_at: z.number().optional().describe('Optional inclusive end timestamp in unix milliseconds'),
  limit: z.number().optional().describe('Maximum timeline events to return'),
})
const prepareContextSchema = z.object({
  agent: z.string().describe('First-party agent identity requesting the bundle'),
  intent: z.enum(['person', 'project', 'scope', 'meeting_prep']).describe('Context bundle intent'),
  target: z.string().describe('Person, project, or scope to assemble context for'),
  scope: z.string().optional().describe('Optional canonical scope filter'),
  limit: z.number().optional().describe('Maximum memories to pull per retrieval mode'),
})

const asText = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] })

export function registerCanonicalMemoryTools(server: McpServer, ctx: CanonicalMemoryToolContext): void {
  server.tool('capture_memory', 'Capture memory through the canonical memory contract', captureSchema.shape, async (input) => {
    return asText(await captureExternalClientMemory(
      input as ExternalClientCaptureInput,
      ctx.getTenantId(),
      ctx.getTmk(),
      ctx.getEnv(),
      ctx.getExecutionContext(),
    ))
  })

  server.tool('search_memory', 'Search canonical memories', searchSchema.shape, async (input) => {
    const typed = input as z.infer<typeof searchSchema>
    const result = await searchCanonicalMemory({
      tenantId: ctx.getTenantId(),
      query: typed.query,
      scope: typed.scope ?? null,
      limit: typed.limit,
      mode: typed.mode,
    }, ctx.getEnv(), ctx.getTenantId(), { tmk: ctx.getTmk() })
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
    return asText(await prepareContextForAgent({ ...typed, scope: typed.scope ?? null }, ctx.getEnv(), ctx.getTenantId(), { tmk: ctx.getTmk() }))
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

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env } from '../types/env'
import { writeAuditLog } from '../middleware/audit'
import { getCanonicalDocument, listRecentCanonicalMemories, searchCanonicalMemory } from '../services/canonical-memory-query'
import { getCanonicalMemoryStats } from '../services/canonical-memory-stats'
import { getCanonicalMemoryStatus } from '../services/canonical-memory-status'
import { retainViaService } from './retain'

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
})
const searchSchema = z.object({
  query: z.string().describe('Canonical memory search query'),
  scope: z.string().optional().describe('Optional scope filter'),
  limit: z.number().optional().describe('Maximum results to return'),
})
const recentSchema = z.object({
  scope: z.string().optional().describe('Optional scope filter'),
  limit: z.number().optional().describe('Maximum results to return'),
})
const documentSchema = z.object({
  document_id: z.string().describe('Canonical document id'),
})
const statusSchema = z.object({
  capture_id: z.string().optional().describe('Canonical capture id'),
  operation_id: z.string().optional().describe('Canonical memory operation id'),
})

function asText(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] }
}

export function registerCanonicalMemoryTools(server: McpServer, ctx: CanonicalMemoryToolContext): void {
  server.tool('capture_memory', 'Capture memory through the canonical memory contract', captureSchema.shape,
    async (input) => {
      const typed = input as z.infer<typeof captureSchema>
      return asText(await retainViaService({
        content: typed.content,
        domain: typed.scope ?? 'general',
        memory_type: typed.memory_type,
        provenance: typed.provenance,
      }, ctx.getTenantId(), ctx.getTmk(), ctx.getEnv(), ctx.getExecutionContext()))
    })

  server.tool('search_memory', 'Search canonical memories', searchSchema.shape, async (input) => {
    const typed = input as z.infer<typeof searchSchema>
    const result = await searchCanonicalMemory(
      { tenantId: ctx.getTenantId(), query: typed.query, scope: typed.scope ?? null, limit: typed.limit },
      ctx.getEnv(),
      ctx.getTenantId(),
      { tmk: ctx.getTmk() },
    )
    ctx.getExecutionContext().waitUntil(writeAuditLog(ctx.getEnv(), 'memory.search.executed', ctx.getTenantId(), { agentIdentity: 'mcpagent/tool' }))
    return asText(result)
  })

  server.tool('get_recent_memories', 'List recent canonical memories', recentSchema.shape, async (input) => {
    const typed = input as z.infer<typeof recentSchema>
    const result = await listRecentCanonicalMemories(
      { tenantId: ctx.getTenantId(), scope: typed.scope ?? null, limit: typed.limit },
      ctx.getEnv(),
      ctx.getTenantId(),
      { tmk: ctx.getTmk() },
    )
    ctx.getExecutionContext().waitUntil(writeAuditLog(ctx.getEnv(), 'memory.recent.viewed', ctx.getTenantId(), { agentIdentity: 'mcpagent/tool' }))
    return asText(result)
  })

  server.tool('get_document', 'Get one canonical document', documentSchema.shape, async (input) => {
    const typed = input as z.infer<typeof documentSchema>
    const result = await getCanonicalDocument(
      { tenantId: ctx.getTenantId(), documentId: typed.document_id },
      ctx.getEnv(),
      ctx.getTenantId(),
      { tmk: ctx.getTmk() },
    )
    ctx.getExecutionContext().waitUntil(writeAuditLog(ctx.getEnv(), 'memory.document.viewed', ctx.getTenantId(), { memoryId: result.documentId, agentIdentity: 'mcpagent/tool' }))
    return asText(result)
  })

  server.tool('memory_status', 'Get canonical memory operation status', statusSchema.shape, async (input) => {
    const typed = input as z.infer<typeof statusSchema>
    const result = await getCanonicalMemoryStatus(
      { tenantId: ctx.getTenantId(), captureId: typed.capture_id, operationId: typed.operation_id },
      ctx.getEnv(),
      ctx.getTenantId(),
    )
    ctx.getExecutionContext().waitUntil(writeAuditLog(ctx.getEnv(), 'memory.status.viewed', ctx.getTenantId(), { memoryId: result.operation.operationId, agentIdentity: 'mcpagent/tool' }))
    return asText(result)
  })

  server.tool('memory_stats', 'Get canonical memory stats', {}, async () => asText(
    await getCanonicalMemoryStats(ctx.getEnv(), ctx.getTenantId()),
  ))
}

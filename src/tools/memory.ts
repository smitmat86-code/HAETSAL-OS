// src/tools/memory.ts — memory_search + memory_write MCP tools
// Available in ALL sessions (not session-scoped)
// memory_write Zod: z.enum(['episodic', 'semantic']) — excludes procedural AND world
// Law 3: procedural excluded (only cron writes it)
// world excluded: enters via ingestion pipeline, not MCP callers

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env } from '../types/env'
import type { IngestionArtifact } from '../types/ingestion'
import { recallViaService } from './recall'
import { retainContent } from '../services/ingestion/retain'

interface MemoryToolContext {
  getEnv: () => Env
  getTenantId: () => string
  getTmk: () => CryptoKey | null
  getHindsightTenantId: () => string
  getExecutionContext: () => Pick<ExecutionContext, 'waitUntil'>
}

const searchSchema = z.object({
  query: z.string().describe('Natural language search query'),
  domain: z.string().optional().describe('Filter by domain (career, health, etc.)'),
  limit: z.number().optional().describe('Max results (default 10)'),
})

const writeSchema = z.object({
  content: z.string().describe('Memory content to write'),
  memory_type: z.enum(['episodic', 'semantic']).describe('Memory type'),
  domain: z.string().optional().describe('Domain tag'),
})

export function registerMemoryTools(server: McpServer, ctx: MemoryToolContext): void {
  server.tool('memory_search', 'Search memories by query', searchSchema.shape,
    async (input) => {
      const { query, domain, limit } = input as z.infer<typeof searchSchema>
      const result = await recallViaService(
        { query, domain, limit: limit ?? 10 },
        ctx.getHindsightTenantId(), ctx.getTmk(), ctx.getEnv(),
      )
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
    },
  )

  server.tool('memory_write', 'Write an episodic or semantic memory', writeSchema.shape,
    async (input) => {
      const { content, memory_type, domain } = input as z.infer<typeof writeSchema>
      const tmk = ctx.getTmk()
      console.log('MEMORY_WRITE_START', {
        tenantId: ctx.getTenantId(),
        domain: domain ?? 'general',
        memoryType: memory_type,
      })
      if (!tmk) {
        console.warn('MEMORY_WRITE_NO_TMK', { tenantId: ctx.getTenantId() })
        return { content: [{ type: 'text' as const,
          text: JSON.stringify({ memory_id: null, error: 'No active session' }) }] }
      }
      const artifact: IngestionArtifact = {
        tenantId: ctx.getTenantId(), content,
        source: 'mcp:memory_write', memoryType: memory_type,
        domain: domain ?? 'general', provenance: 'user_authored',
        occurredAt: Date.now(),
      }
      const result = await retainContent(artifact, tmk, ctx.getEnv(), ctx.getExecutionContext(), {
        hindsightAsync: true,
      })
      console.log('MEMORY_WRITE_DONE', {
        tenantId: ctx.getTenantId(),
        memoryId: result?.memoryId ?? null,
        status: result ? 'queued' : 'deferred',
      })
      return { content: [{ type: 'text' as const,
        text: JSON.stringify({
          memory_id: result?.memoryId ?? null,
          status: result ? 'queued' : 'deferred',
          canonical_capture_id: result?.canonicalCaptureId ?? null,
          canonical_document_id: result?.canonicalDocumentId ?? null,
          canonical_operation_id: result?.canonicalOperationId ?? null,
          dispatch_status: result?.canonicalDispatchStatus ?? null,
          compatibility_status: result?.compatibilityStatus ?? null,
        }) }] }
    },
  )
}

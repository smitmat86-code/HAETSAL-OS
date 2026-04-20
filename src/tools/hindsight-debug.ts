import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env } from '../types/env'
import { debugHindsightBankState } from '../services/canonical-hindsight-debug'

interface HindsightDebugToolContext {
  getEnv: () => Env
  getTenantId: () => string
}

const debugHindsightSchema = z.object({
  capture_id: z.string().optional().describe('Optional canonical capture id to resolve latest hindsight projection state'),
  operation_id: z.string().optional().describe('Optional canonical memory operation id to resolve latest hindsight projection state'),
  recall_query: z.string().optional().describe('Optional raw Hindsight recall query without canonical filtering'),
  limit: z.number().optional().describe('Maximum raw Hindsight recall items to include'),
})

const asText = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] })

export function registerHindsightDebugTool(server: McpServer, ctx: HindsightDebugToolContext): void {
  server.tool('debug_hindsight_bank_state', 'Inspect raw Hindsight bank state for the current tenant', debugHindsightSchema.shape, async (input) => {
    const typed = input as z.infer<typeof debugHindsightSchema>
    return asText(await debugHindsightBankState({
      tenantId: ctx.getTenantId(),
      captureId: typed.capture_id ?? null,
      operationId: typed.operation_id ?? null,
      recallQuery: typed.recall_query ?? null,
      limit: typed.limit,
    }, ctx.getEnv()))
  })
}

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerCanonicalMemoryTools } from './canonical-memory'

export const BRAIN_MEMORY_TOOL_NAMES = [
  'capture_memory',
  'search_memory',
  'trace_relationship',
  'get_entity_timeline',
  'prepare_context_for_agent',
  'get_recent_memories',
  'get_document',
  'memory_status',
  'memory_stats',
] as const

export type BrainMemoryToolName = typeof BRAIN_MEMORY_TOOL_NAMES[number]
export type BrainMemorySurfaceContext = Parameters<typeof registerCanonicalMemoryTools>[1]

export function registerBrainMemorySurface(
  server: McpServer,
  ctx: BrainMemorySurfaceContext,
): void {
  registerCanonicalMemoryTools(server, ctx)
}

export function isBrainMemoryToolName(name: string): name is BrainMemoryToolName {
  return (BRAIN_MEMORY_TOOL_NAMES as readonly string[]).includes(name)
}

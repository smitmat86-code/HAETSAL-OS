// src/types/tools.ts
// MCP tool input/output schemas for brain_v1_retain and brain_v1_recall
// Uses Zod for MCP SDK compatibility (agents SDK requires Zod schemas)

import { z } from 'zod'

export interface RetainInput {
  content: string
  domain?: string
  memory_type?: 'episodic' | 'semantic' | 'world'
  provenance?: string
}

export interface RetainOutput {
  memory_id: string   // Stable retained document reference or async operation id
  salience_tier: number
  status: 'retained' | 'queued' | 'deferred'
  canonical_capture_id?: string
  canonical_document_id?: string
  canonical_operation_id?: string
  dispatch_status?: 'queued' | 'failed'
  compatibility_status?: 'skipped' | 'queued' | 'retained' | 'failed'
}

export interface RecallInput {
  query: string
  domain?: string
  mode?: 'default' | 'timeline'
  limit?: number
}

export interface RecallOutput {
  results: Array<{
    memory_id: string
    content: string   // stub: placeholder text
    memory_type: string
    confidence: number
    relevance: number
  }>
  synthesis: string
}

// Zod schemas for MCP tool registration (agents SDK requirement)
export const retainSchema = {
  content: z.string().describe('The memory content to retain'),
  domain: z.string().optional().describe('Knowledge domain (e.g., career, health)'),
  memory_type: z.enum(['episodic', 'semantic', 'world']).optional()
    .describe('Type of memory to create'),
  provenance: z.string().optional().describe('Source of this memory'),
}

export const recallSchema = {
  query: z.string().describe('Search query for memory retrieval'),
  domain: z.string().optional().describe('Filter by knowledge domain'),
  mode: z.enum(['default', 'timeline']).optional().describe('Retrieval mode'),
  limit: z.number().optional().describe('Maximum results to return'),
}

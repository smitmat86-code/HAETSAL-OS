import { z } from 'zod'

export const captureSchema = z.object({
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

export const searchSchema = z.object({
  query: z.string().describe('Canonical memory search query'),
  scope: z.string().optional().describe('Optional scope filter'),
  limit: z.number().optional().describe('Maximum results to return'),
  mode: z.enum(['raw', 'lexical', 'semantic', 'graph', 'temporal', 'compiled', 'composed']).optional()
    .describe('Optional explicit retrieval mode override (all seven broker modes)'),
})

export const recentSchema = z.object({
  scope: z.string().optional().describe('Optional scope filter'),
  limit: z.number().optional().describe('Maximum results to return'),
})

export const documentSchema = z.object({
  document_id: z.string().describe('Canonical document id'),
})

export const statusSchema = z.object({
  capture_id: z.string().optional().describe('Canonical capture id'),
  operation_id: z.string().optional().describe('Canonical memory operation id'),
})

export const traceRelationshipSchema = z.object({
  from: z.string().describe('Starting entity, topic, scope, or canonical graph key'),
  to: z.string().optional().describe('Optional target entity to constrain the trace'),
  relation: z.string().optional().describe('Optional relation filter, such as conversed_with'),
  limit: z.number().optional().describe('Maximum relationships to return'),
})

export const entityTimelineSchema = z.object({
  entity: z.string().describe('Entity, topic, scope, or canonical graph key to inspect over time'),
  start_at: z.number().optional().describe('Optional inclusive start timestamp in unix milliseconds'),
  end_at: z.number().optional().describe('Optional inclusive end timestamp in unix milliseconds'),
  limit: z.number().optional().describe('Maximum timeline events to return'),
})

export const prepareContextSchema = z.object({
  agent: z.string().describe('First-party agent identity requesting the bundle'),
  intent: z.enum(['person', 'project', 'scope', 'meeting_prep']).describe('Context bundle intent'),
  target: z.string().describe('Person, project, or scope to assemble context for'),
  scope: z.string().optional().describe('Optional canonical scope filter'),
  limit: z.number().optional().describe('Maximum memories to pull per retrieval mode'),
})

export const recentTraceSchema = z.object({
  limit: z.number().optional().describe('Maximum traces to return'),
  mode: z.enum(['raw', 'semantic', 'graph', 'composed']).optional()
    .describe('Optional primary-route filter'),
})

export const traceSchema = z.object({
  query_id: z.string().describe('Broker query id to inspect'),
})

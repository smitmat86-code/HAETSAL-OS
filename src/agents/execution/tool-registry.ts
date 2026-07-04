// src/agents/execution/tool-registry.ts
// Scoped tool registry for execution agents. READ tools execute inline
// (GREEN fixed floor, audited); WRITE tools only PROPOSE through the existing
// act stubs so the authorization gate (capability class + TOCTOU + delay)
// stays the single path to the outside world. Tool results feed the model
// loop; they are never persisted by this module.

import type { Env } from '../../types/env'
import type { ExecutionToolName } from './types'
import { executeWebSearch } from '../../services/action/integrations/web-search'
import { recallViaService } from '../../tools/recall'
import { sendMessageSchema, sendMessageStub } from '../../tools/act/send-message'
import { draftSchema, draftStub } from '../../tools/act/draft'
import { remindSchema, remindStub } from '../../tools/act/remind'
import { writeAuditLog } from '../../middleware/audit'

export interface ToolRuntime {
  env: Env
  tenantId: string
  tmk: CryptoKey
  agentIdentity: string
}

interface RegisteredTool {
  description: string
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>, rt: ToolRuntime) => Promise<string>
}

const str = (v: unknown): string => (typeof v === 'string' ? v : String(v ?? ''))

export const EXECUTION_TOOLS: Record<ExecutionToolName, RegisteredTool> = {
  web_search: {
    description: 'Search the web for current information. Returns titles, URLs, and snippets.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        max_results: { type: 'number', description: 'Max results (1-10)' },
      },
      required: ['query'],
    },
    execute: async (args, rt) => {
      const result = await executeWebSearch(str(args.query), rt.env, {
        maxResults: typeof args.max_results === 'number' ? args.max_results : 5,
      })
      void writeAuditLog(rt.env, 'agent_tool.web_search', rt.tenantId, { agentIdentity: rt.agentIdentity })
      return JSON.stringify(result.hits.map(h => ({ title: h.title, url: h.url, snippet: h.description.slice(0, 300) })))
    },
  },
  recall_memory: {
    description: 'Search the tenant memory for relevant past events, facts, and decisions.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for' },
        limit: { type: 'number', description: 'Max memories (1-10)' },
      },
      required: ['query'],
    },
    execute: async (args, rt) => {
      const result = await recallViaService(
        { query: str(args.query), limit: typeof args.limit === 'number' ? Math.min(args.limit, 10) : 5 },
        rt.tenantId, rt.tmk, rt.env,
      )
      void writeAuditLog(rt.env, 'agent_tool.recall_memory', rt.tenantId, { agentIdentity: rt.agentIdentity })
      return JSON.stringify(result.results.map(r => ({ content: r.content.slice(0, 400), type: r.memory_type })))
    },
  },
  propose_message: {
    description: 'PROPOSE sending a message (sms/imessage/telegram/email). Goes to the approval gate; it is not sent immediately.',
    parameters: {
      type: 'object',
      properties: {
        recipient: { type: 'string', description: 'Phone (E.164), Telegram chat id, or email' },
        message: { type: 'string', description: 'Message body' },
        channel: { type: 'string', enum: ['sms', 'imessage', 'telegram', 'email'] },
      },
      required: ['recipient', 'message'],
    },
    execute: async (args, rt) => {
      const out = await sendMessageStub(sendMessageSchema.parse(args), rt.env, rt.tenantId, rt.agentIdentity)
      return JSON.stringify({ proposed: true, action_id: out.action_id })
    },
  },
  propose_draft: {
    description: 'PROPOSE creating a draft (note or plan). Routed through the action gate.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        content: { type: 'string' },
        draft_type: { type: 'string', description: 'note | plan | email' },
      },
      required: ['title', 'content'],
    },
    execute: async (args, rt) => {
      const out = await draftStub(draftSchema.parse(args), rt.env, rt.tenantId, rt.agentIdentity)
      return JSON.stringify({ proposed: true, action_id: out.action_id })
    },
  },
  propose_reminder: {
    description: 'PROPOSE a scheduled reminder. Routed through the action gate.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Reminder text' },
        remind_at: { type: 'string', description: 'ISO 8601 datetime' },
        channel: { type: 'string', enum: ['sms', 'imessage', 'telegram', 'email'] },
      },
      required: ['message', 'remind_at'],
    },
    execute: async (args, rt) => {
      const out = await remindStub(remindSchema.parse(args), rt.env, rt.tenantId, rt.agentIdentity)
      return JSON.stringify({ proposed: true, action_id: out.action_id })
    },
  },
}

/** Model-facing tool definitions for the scoped subset only. */
export function toolDefinitionsFor(allowed: ExecutionToolName[]): Array<{
  name: string; description: string; parameters: Record<string, unknown>
}> {
  return allowed.filter(name => name in EXECUTION_TOOLS).map(name => ({
    name,
    description: EXECUTION_TOOLS[name].description,
    parameters: EXECUTION_TOOLS[name].parameters,
  }))
}

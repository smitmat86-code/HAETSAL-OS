// src/services/action/tool-dispatch.ts
// Maps a proposed action's tool_name to its real integration and returns the
// execution result. Returns 'stub' for tools with no real executor yet.
// executor.ts owns the surrounding state/audit/episodic/broadcast batch.

import type { Env } from '../../types/env'
import type { ActionQueueMessage } from '../../types/action'
import { executeBrowse } from './integrations/browser'
import { executeCreateEvent, executeModifyEvent } from './integrations/calendar'
import { executeWebSearch } from './integrations/web-search'
import { executeDraft } from './integrations/drafts'
import { executeSendMessage } from './integrations/messaging'
import { executeReminder } from './integrations/reminder'

export interface ToolExecutionResult {
  resultSummary: string
  externalId?: string
  htmlLink?: string
}

export async function dispatchTool(
  msg: ActionQueueMessage,
  tmk: CryptoKey | null,
  env: Env,
  ctx: ExecutionContext,
): Promise<ToolExecutionResult | 'stub'> {
  switch (msg.tool_name) {
    case 'brain_v1_act_browse': {
      const { url } = JSON.parse(msg.payload_stub) as { url: string }
      const result = await executeBrowse(url, env)
      return { resultSummary: `browsed:${result.title.slice(0, 80)}` }
    }
    case 'brain_v1_act_search': {
      const input = JSON.parse(msg.payload_stub) as { query: string; domain?: string; max_results?: number }
      const result = await executeWebSearch(input.query, env, { maxResults: input.max_results, domain: input.domain })
      const top = result.hits.slice(0, 3).map((h) => h.title).join('; ')
      return { resultSummary: `searched:${result.hits.length} hits${top ? ` — ${top.slice(0, 100)}` : ''}` }
    }
    case 'brain_v1_act_draft': {
      if (!tmk) throw new Error('TMK required for draft capture')
      const input = JSON.parse(msg.payload_stub) as { title: string; content: string; draft_type?: string }
      const draft = await executeDraft({ ...input, action_id: msg.action_id }, msg.tenant_id, tmk, env, ctx)
      return { resultSummary: `drafted:${draft.draftType}:${draft.draftId.slice(0, 8)}` }
    }
    case 'brain_v1_act_send_message': {
      const input = JSON.parse(msg.payload_stub) as { recipient: string; message: string; channel?: string }
      const sent = await executeSendMessage(input, env)
      return { resultSummary: `sent:${sent.channel}:${sent.detail}` }
    }
    case 'brain_v1_act_remind': {
      const input = JSON.parse(msg.payload_stub) as { message: string; remind_at: string; channel?: string }
      const result = await executeReminder(input, msg.tenant_id, env)
      return { resultSummary: `reminder:scheduled:${new Date(result.scheduledFor).toISOString()}` }
    }
    case 'brain_v1_act_create_event': {
      if (!tmk) throw new Error('TMK required for calendar integration')
      const result = await executeCreateEvent(JSON.parse(msg.payload_stub), msg.tenant_id, tmk, env)
      return { resultSummary: `created_event:${result.eventId}`, externalId: result.eventId, htmlLink: result.htmlLink }
    }
    case 'brain_v1_act_modify_event': {
      if (!tmk) throw new Error('TMK required for calendar integration')
      const result = await executeModifyEvent(JSON.parse(msg.payload_stub), msg.tenant_id, tmk, env)
      return { resultSummary: `modified_event:${result.eventId}`, externalId: result.eventId, htmlLink: result.htmlLink }
    }
    default:
      return 'stub'
  }
}

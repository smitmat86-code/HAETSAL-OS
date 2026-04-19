import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env } from '../../../types/env'
import type { RecallInput, RetainInput } from '../../../types/tools'
import { recallSchema, retainSchema } from '../../../types/tools'
import { writeAuditLog } from '../../../middleware/audit'
import { browseSchema, browseStub } from '../../../tools/act/browse'
import { createEventSchema, createEventStub } from '../../../tools/act/create-event'
import { draftSchema, draftStub } from '../../../tools/act/draft'
import { modifyEventSchema, modifyEventStub } from '../../../tools/act/modify-event'
import { remindSchema, remindStub } from '../../../tools/act/remind'
import { runPlaybookSchema, runPlaybookStub } from '../../../tools/act/run-playbook'
import { searchSchema, searchStub } from '../../../tools/act/search'
import { sendMessageSchema, sendMessageStub } from '../../../tools/act/send-message'
import { recallViaService } from '../../../tools/recall'
import { retainViaService } from '../../../tools/retain'

interface ToolRegistrationContext {
  env: Env
  server: McpServer
  getTenantId: () => string
  getTmk: () => CryptoKey | null
  waitUntil: (promise: Promise<unknown>) => void
}

export function registerLegacyMemoryTools({
  env,
  server,
  getTenantId,
  getTmk,
  waitUntil,
}: ToolRegistrationContext): void {
  server.tool('brain_v1_retain', 'Retain a memory in THE Brain', retainSchema,
    async (input) => {
      const typedInput = input as unknown as RetainInput
      const tenantId = getTenantId()
      const result = await retainViaService(typedInput, tenantId, getTmk(), env, { waitUntil })
      const operation =
        result.status === 'queued'
          ? 'memory.retain_requested'
          : result.status === 'retained'
            ? 'memory.retained'
            : 'memory.retain_deferred'
      waitUntil(writeAuditLog(env, operation, tenantId, { agentIdentity: 'mcpagent/tool' }))
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
    },
  )

  server.tool('brain_v1_recall', 'Recall memories from THE Brain', recallSchema,
    async (input) => {
      const typedInput = input as unknown as RecallInput
      const tenantId = getTenantId()
      const result = await recallViaService(typedInput, tenantId, getTmk(), env)
      waitUntil(writeAuditLog(env, 'memory.recalled', tenantId, { agentIdentity: 'mcpagent/tool' }))
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
    },
  )
}

export function registerActTools({
  env,
  server,
  getTenantId,
}: Omit<ToolRegistrationContext, 'getTmk' | 'waitUntil'>): void {
  const proposedBy = 'mcpagent/tool'
  const wrap = (fn: (input: unknown) => Promise<{ action_id: string; status: string }>) =>
    async (input: unknown) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(await fn(input)) }],
    })

  server.tool('brain_v1_act_send_message', 'Send SMS or email',
    sendMessageSchema.shape, wrap(i => sendMessageStub(i as Parameters<typeof sendMessageStub>[0], env, getTenantId(), proposedBy)))
  server.tool('brain_v1_act_create_event', 'Create calendar event',
    createEventSchema.shape, wrap(i => createEventStub(i as Parameters<typeof createEventStub>[0], env, getTenantId(), proposedBy)))
  server.tool('brain_v1_act_modify_event', 'Modify calendar event',
    modifyEventSchema.shape, wrap(i => modifyEventStub(i as Parameters<typeof modifyEventStub>[0], env, getTenantId(), proposedBy)))
  server.tool('brain_v1_act_draft', 'Create a draft',
    draftSchema.shape, wrap(i => draftStub(i as Parameters<typeof draftStub>[0], env, getTenantId(), proposedBy)))
  server.tool('brain_v1_act_search', 'Search the web',
    searchSchema.shape, wrap(i => searchStub(i as Parameters<typeof searchStub>[0], env, getTenantId(), proposedBy)))
  server.tool('brain_v1_act_browse', 'Browse a web page',
    browseSchema.shape, wrap(i => browseStub(i as Parameters<typeof browseStub>[0], env, getTenantId(), proposedBy)))
  server.tool('brain_v1_act_remind', 'Set a reminder',
    remindSchema.shape, wrap(i => remindStub(i as Parameters<typeof remindStub>[0], env, getTenantId(), proposedBy)))
  server.tool('brain_v1_act_run_playbook', 'Run a multi-step playbook',
    runPlaybookSchema.shape, wrap(i => runPlaybookStub(i as Parameters<typeof runPlaybookStub>[0], env, getTenantId(), proposedBy)))
}

// src/workers/mcpagent/do/register-automation-tools.ts
// MCP CRUD tools for user automations (mission Phase 7): create_automation,
// list_automations, toggle_automation, delete_automation. Thin wrappers over
// the DO's automation runtime — the same surface chat and the dashboard use.

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { DEFAULT_TZ } from '../../../services/automations/recurrence'
import type { AutomationHost, CreateAutomationInput } from './automation-runtime'
import { createAutomation, removeAutomation, toggleAutomation } from './automation-runtime'
import { listAutomationsView } from './automation-view'

const createSchema = z.object({
  task: z.string().min(3).max(1000).describe('What the automation should do each time it fires'),
  kind: z.enum(['daily', 'weekdays', 'weekly']).describe('Recurrence cadence'),
  hour: z.number().int().min(0).max(23).describe('Hour of day (tenant timezone)'),
  minute: z.number().int().min(0).max(59).optional().describe('Minute (default 0)'),
  day_of_week: z.number().int().min(0).max(6).optional().describe('0=Sunday..6=Saturday (weekly only)'),
  tz: z.string().optional().describe(`IANA timezone (default ${DEFAULT_TZ})`),
})

const idSchema = z.object({
  automation_id: z.string().min(4).describe('Automation id (or unique prefix)'),
})

interface AutomationToolContext {
  server: McpServer
  getHost: () => AutomationHost
  getDefaultRoute: () => Promise<{ channel: 'telegram' | 'sendblue' | 'sms'; replyTo: string }>
}

const asText = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] })

export function registerAutomationTools({ server, getHost, getDefaultRoute }: AutomationToolContext): void {
  server.tool('create_automation', 'Create a recurring automation that runs a task and messages the result', createSchema.shape,
    async (input) => {
      const parsed = createSchema.parse(input)
      const route = await getDefaultRoute()
      const spec: CreateAutomationInput = {
        task: parsed.task,
        spec: {
          kind: parsed.kind, hour: parsed.hour, minute: parsed.minute ?? 0,
          ...(parsed.kind === 'weekly' ? { dayOfWeek: parsed.day_of_week ?? 1 } : {}),
          tz: parsed.tz ?? DEFAULT_TZ,
        },
        replyChannel: route.channel,
        replyTo: route.replyTo,
      }
      return asText(await createAutomation(getHost(), spec))
    })

  server.tool('list_automations', 'List automations with schedules and recent fire events', {},
    async () => asText(await listAutomationsView(getHost())))

  server.tool('toggle_automation', 'Pause or resume an automation',
    { ...idSchema.shape, enabled: z.boolean().describe('true = resume, false = pause') },
    async (input) => {
      const { automation_id } = idSchema.parse(input)
      const enabled = Boolean((input as { enabled?: unknown }).enabled)
      return asText(await toggleAutomation(getHost(), automation_id, enabled))
    })

  server.tool('delete_automation', 'Delete an automation permanently', idSchema.shape,
    async (input) => asText(await removeAutomation(getHost(), idSchema.parse(input).automation_id)))
}
